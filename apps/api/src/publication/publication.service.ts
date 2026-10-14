import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { pickRole } from '../authz/roles';
import { AuthzService } from '../authz/authz.service';
import type { CurriculumRole } from '../curriculum/curriculum-state';
import { DatabaseService } from '../database/database.service';
import { EXAM_CONFIG, type ExamConfig } from '../exam/exam-domain';
import type { QuestionState } from '../question/question-domain';
import { isReasonCode } from '../question/reason-codes';
import { QuestionService } from '../question/question.service';
import {
  HEALTH_ROLES, PUBLISH_ROLES, WITHDRAW_ROLES, healthBlockers, publishBlockers, summariseBank,
  type PublicationState, type StoredHealth, type UnitBankSummary,
} from './publication-domain';
import { PublicationConflictError, PublicationForbiddenError, PublicationNotFoundError } from './publication.errors';
import { withdrawInTx } from './publication-write';

export interface PublishUnitResult {
  published: number;
  skipped: Array<{ code: string; reasons: string[] }>;
}

/**
 * Publishing, withdrawing and bank health. The caller's role is read from the database on every call. Publishing is for
 * approvers: a reviewer can approve a question but cannot put it into the bank that tests are built from.
 */
@Injectable()
export class PublicationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly questions: QuestionService,
    @Inject(EXAM_CONFIG) private readonly config: ExamConfig,
  ) {}

  async publish(accountId: string, revisionId: string): Promise<{ publishedAt: Date }> {
    await this.require(accountId, PUBLISH_ROLES, 'only an approver may publish a question');
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const blockers = await this.blockersFor(tx, revisionId);
      if (blockers.length) throw new PublicationConflictError(`this question cannot be published: ${blockers.join('; ')}`);
      return this.writePublish(tx, revisionId, accountId);
    });
  }

  /** Publishes every approved, not-yet-published question of a unit that passes the same rules. Others are listed, not hidden. */
  async publishUnit(accountId: string, unitId: string): Promise<PublishUnitResult> {
    await this.require(accountId, PUBLISH_ROLES, 'only an approver may publish questions');
    const unit = await this.questions.unitIdentity(unitId);
    const candidates: any[] = await this.db.client.question_revision.findMany({
      where: {
        state: 'APPROVED',
        question: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId },
        OR: [{ publication: null }, { publication: { state: 'WITHDRAWN' } }],
      },
      select: { id: true, question: { select: { code: true } } },
      orderBy: { question: { code: 'asc' } },
      take: 2000,
    });
    const out: PublishUnitResult = { published: 0, skipped: [] };
    for (const c of candidates) {
      try {
        await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
          const blockers = await this.blockersFor(tx, c.id);
          if (blockers.length) {
            out.skipped.push({ code: c.question.code, reasons: blockers });
            return;
          }
          await this.writePublish(tx, c.id, accountId);
          out.published++;
        });
      } catch (e) {
        out.skipped.push({ code: c.question.code, reasons: [(e as Error).message] });
      }
    }
    return out;
  }

  async withdraw(accountId: string, revisionId: string, input: { reasonCode: string; note: string }): Promise<void> {
    await this.require(accountId, WITHDRAW_ROLES, 'only a reviewer or approver may withdraw a question');
    if (!isReasonCode(input.reasonCode)) throw new PublicationConflictError('a listed reason is required');
    if ((input.note ?? '').trim().length < 5) throw new PublicationConflictError('a note of at least 5 characters is required');
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM question_revision WHERE id = ${revisionId}::uuid FOR UPDATE`;
      const done = await withdrawInTx(tx, revisionId, { kind: 'HUMAN', accountId }, input.reasonCode, input.note.trim());
      if (!done) throw new PublicationConflictError('this version is not published');
    });
  }

  /** Sets the stored health of the question this version belongs to. Manual until live-quality signals exist. */
  async setHealth(accountId: string, revisionId: string, input: { health: string; reasonCode: string; note: string }): Promise<void> {
    await this.require(accountId, HEALTH_ROLES, 'only a reviewer or approver may change a question\'s health');
    if (!isReasonCode(input.reasonCode)) throw new PublicationConflictError('a listed reason is required');
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const rev: any = await tx.question_revision.findUnique({ where: { id: revisionId }, select: { question_id: true } });
      if (!rev) throw new PublicationNotFoundError('question');
      const current: any = await tx.question_bank_state.findUnique({ where: { question_id: rev.question_id } });
      const problems = healthBlockers((current?.health as StoredHealth | undefined) ?? null, input.health, (input.note ?? '').trim().length);
      if (problems.length) throw new PublicationConflictError(problems.join('; '));
      await tx.question_bank_state.upsert({
        where: { question_id: rev.question_id },
        create: { question_id: rev.question_id, health: input.health as StoredHealth, changed_by: accountId, reason_code: input.reasonCode, note: input.note.trim() },
        update: { health: input.health as StoredHealth, changed_by: accountId, reason_code: input.reasonCode, note: input.note.trim() },
      });
    });
  }

  async summary(accountId: string, unitId: string): Promise<UnitBankSummary> {
    await this.require(accountId, ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'], 'your account does not hold a curriculum role');
    return this.summaryOfUnit(await this.questions.unitIdentity(unitId));
  }

  /** Also used by the operator tool, which has no account. */
  async summaryOfUnit(unit: { curriculumVersionId: string; gradeId: string; subjectId: string }): Promise<UnitBankSummary> {
    const qs: any[] = await this.db.client.question.findMany({
      where: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId },
      include: { bank_state: true, revisions: { orderBy: { revision: 'desc' }, take: 1, include: { publication: true } } },
      take: 5000,
    });
    return summariseBank(
      qs.map((q) => ({
        state: q.revisions[0].state as QuestionState,
        publication: (q.revisions[0].publication?.state as PublicationState | undefined) ?? null,
        health: (q.bank_state?.health as StoredHealth | undefined) ?? null,
      })),
    );
  }

  // ---------------------------------------------------------------- internals

  private async blockersFor(tx: Prisma.TransactionClient, revisionId: string): Promise<string[]> {
    await tx.$queryRaw`SELECT id FROM question_revision WHERE id = ${revisionId}::uuid FOR UPDATE`;
    const rev: any = await tx.question_revision.findUnique({
      where: { id: revisionId },
      include: { question: true, publication: true, validation_runs: { orderBy: { created_at: 'desc' }, take: 1 } },
    });
    if (!rev) throw new PublicationNotFoundError('question');
    const latest: any = await tx.curriculum_subject_version.findFirst({
      where: { curriculum_version_id: rev.question.curriculum_version_id, grade_id: rev.question.grade_id, subject_id: rev.question.subject_id },
      orderBy: { revision: 'desc' },
      select: { id: true, state: true },
    });
    const path: string = rev.question.objective_path;
    const found = latest ? (await this.questions.objectivePaths(latest.id as string, tx)).get(path.split('/').pop() as string) : undefined;
    return publishBlockers({
      revisionState: rev.state,
      answerVerified: rev.answer_verified,
      checksPassed: rev.validation_runs[0]?.passed === true,
      objectiveExists: !!found && found.includes(path),
      curriculumState: latest?.state ?? 'MISSING',
      allowUnactivatedCurriculum: this.config.allowUnactivatedCurriculum,
      publication: (rev.publication?.state as PublicationState | undefined) ?? null,
      actorIsHuman: true,
    });
  }

  private async writePublish(tx: Prisma.TransactionClient, revisionId: string, accountId: string): Promise<{ publishedAt: Date }> {
    const now = new Date();
    await tx.question_publication.upsert({
      where: { revision_id: revisionId },
      create: { revision_id: revisionId, state: 'PUBLISHED', published_by: accountId, published_at: now },
      update: { state: 'PUBLISHED', published_by: accountId, published_at: now, withdrawn_by: null, withdrawn_at: null, withdraw_reason_code: null, withdraw_note: null },
    });
    await tx.question_publication_event.create({ data: { revision_id: revisionId, action: 'PUBLISH', actor_kind: 'HUMAN', actor_account_id: accountId } });
    return { publishedAt: now };
  }

  private async require(accountId: string, allowed: readonly CurriculumRole[], deny: string): Promise<CurriculumRole> {
    const role = pickRole(await this.authz.curriculumRolesFor(accountId), allowed);
    if (!role) throw new PublicationForbiddenError(deny);
    return role;
  }
}
