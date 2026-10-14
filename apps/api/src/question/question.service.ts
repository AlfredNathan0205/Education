import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { createHash } from 'node:crypto';
import { bankStatus, type BankStatus } from '../publication/publication-domain';
import { withdrawInTx } from '../publication/publication-write';
import { DatabaseService } from '../database/database.service';
import {
  EDITABLE_STATES,
  OPTION_LABELS,
  assertQuestionTransition,
  stemHash,
  type QuestionActor,
  type QuestionCognitive,
  type QuestionDifficulty,
  type QuestionDraft,
  type QuestionOrigin,
  type QuestionState,
} from './question-domain';
import { DETERMINISTIC_VALIDATOR_VERSION, runDeterministicChecks, type Finding } from './question-governance';
import { QuestionConflictError, QuestionNotFoundError } from './question.errors';
import type { ParsedQuestions, QuestionIssue } from './import/question-import';

/** The stable identity of a curriculum unit: it does not change when a correction revision is made. */
export interface UnitIdentity {
  curriculumVersionId: string;
  gradeId: string;
  subjectId: string;
  /** The newest revision of the unit, whose tree the objective codes are checked against. */
  latestRevisionId: string;
  latestRevisionState: string;
}

export type PlanAction = 'CREATE' | 'UPDATE' | 'NEW_REVISION' | 'UNCHANGED';

export interface PlanItem {
  where: string;
  draft: QuestionDraft;
  objectivePath: string;
  action: PlanAction;
  questionId?: string;
  revisionId?: string;
  revisionNo?: number;
}

export interface QuestionPlan {
  items: PlanItem[];
  issues: QuestionIssue[];
}

export interface WriteContext {
  actor: QuestionActor;
  origin: QuestionOrigin;
  aiSource?: string | null;
}

export interface QuestionRow {
  questionId: string;
  revisionId: string;
  code: string;
  objectivePath: string;
  stem: string;
  difficulty: QuestionDifficulty;
  cognitive: QuestionCognitive | null;
  state: QuestionState;
  revision: number;
  origin: QuestionOrigin;
  /** Bank status: NOT_PUBLISHED, WITHDRAWN, NEW, HEALTHY, WATCH, DEGRADED, QUARANTINED or RETIRED. */
  bankStatus: BankStatus;
}

export interface QuestionDetail extends QuestionRow {
  explanation: string | null;
  options: { label: string; text: string; isCorrect: boolean }[];
  reviewNote: string | null;
  answerVerified: boolean;
  aiSource: string | null;
  /** The latest deterministic check on this exact revision, if one has run. */
  validation: { validatorVersion: string; passed: boolean; findings: Finding[]; at: string } | null;
  publication: { state: 'PUBLISHED' | 'WITHDRAWN'; publishedAt: string; withdrawnReason: string | null; withdrawnNote: string | null } | null;
  /** How the AI factory scored this draft (advisory; a person decides). Null for anything not made by the factory. */
  generation: { batchId: string; route: string | null; confidence: number | null; repairs: number; issues: { role: string; message: string }[]; reason: string | null } | null;
  history: { from: string | null; to: string; actorKind: string; reasonCode: string | null; note: string | null; at: string }[];
}

const OPEN_FOR_EDIT: readonly QuestionState[] = EDITABLE_STATES;

function sameContent(
  draft: QuestionDraft,
  rev: { stem: string; difficulty: string; cognitive?: string | null; explanation: string | null; options: { text: string; is_correct: boolean }[] },
): boolean {
  return (
    rev.stem === draft.stem &&
    rev.difficulty === draft.difficulty &&
    (rev.cognitive ?? null) === draft.cognitive &&
    (rev.explanation ?? null) === draft.explanation &&
    rev.options.length === draft.options.length &&
    rev.options.every((o, i) => o.text === draft.options[i] && o.is_correct === (i === draft.correctIndex))
  );
}

/**
 * Database side of the question bank. It does not check who is allowed: QuestionBankService does that,
 * and passes in the actor. This class enforces the data rules (locks, one live approved revision).
 */
@Injectable()
export class QuestionService {
  constructor(private readonly db: DatabaseService) {}

  // --------------------------------------------------------------- units

  /** Looks up a unit from any of its revision rows. */
  async unitIdentity(subjectVersionId: string): Promise<UnitIdentity> {
    const row = await this.db.client.curriculum_subject_version.findUnique({
      where: { id: subjectVersionId },
      select: { curriculum_version_id: true, grade_id: true, subject_id: true },
    });
    if (!row) throw new QuestionNotFoundError('unit');
    const latest = await this.db.client.curriculum_subject_version.findFirst({
      where: { curriculum_version_id: row.curriculum_version_id, grade_id: row.grade_id, subject_id: row.subject_id },
      orderBy: { revision: 'desc' },
      select: { id: true, state: true },
    });
    return {
      curriculumVersionId: row.curriculum_version_id as string,
      gradeId: row.grade_id as string,
      subjectId: row.subject_id as string,
      latestRevisionId: latest!.id as string,
      latestRevisionState: latest!.state as string,
    };
  }

  /** The newest revision id of the question with this code in the unit, or null. */
  async revisionIdByCode(unit: UnitIdentity, code: string): Promise<string | null> {
    const q: any = await this.db.client.question.findFirst({
      where: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId, code },
      include: { revisions: { orderBy: { revision: 'desc' }, take: 1, select: { id: true } } },
    });
    return q?.revisions?.[0]?.id ?? null;
  }

  /** objective code -> every "chapter/topic/concept/objective" path that uses it, in the newest revision. */
  async objectivePaths(revisionId: string, client: Prisma.TransactionClient | DatabaseService['client'] = this.db.client): Promise<Map<string, string[]>> {
    const chapters = await client.chapter.findMany({
      where: { subject_version_id: revisionId },
      select: {
        code: true,
        topics: { select: { code: true, micro_concepts: { select: { code: true, learning_objectives: { select: { code: true } } } } } },
      },
    });
    const out = new Map<string, string[]>();
    for (const c of chapters as any[]) {
      for (const t of c.topics) {
        for (const m of t.micro_concepts) {
          for (const o of m.learning_objectives) {
            const list = out.get(o.code) ?? [];
            list.push(`${c.code}/${t.code}/${m.code}/${o.code}`);
            out.set(o.code, list);
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- plan

  /** Works out what a file would do, without writing. Problems are issues, never silent skips. */
  async plan(unit: UnitIdentity, parsed: ParsedQuestions): Promise<QuestionPlan> {
    const issues: QuestionIssue[] = [...parsed.issues];
    const paths = await this.objectivePaths(unit.latestRevisionId);
    if (paths.size === 0) {
      issues.push({ where: 'file', message: 'this unit has no curriculum content yet, so there are no objectives to attach questions to' });
    }

    const identity = {
      curriculum_version_id: unit.curriculumVersionId,
      grade_id: unit.gradeId,
      subject_id: unit.subjectId,
    };
    const codes = parsed.questions.map((q) => q.draft.code).filter((c) => c !== '');
    const existing: any[] = await this.db.client.question.findMany({
      where: { ...identity, code: { in: codes } },
      include: { revisions: { orderBy: { revision: 'desc' }, take: 1, include: { options: { orderBy: { position: 'asc' } } } } },
    });
    const byCode = new Map(existing.map((q) => [q.code as string, q]));

    const hashes = parsed.questions.map((q) => stemHash(q.draft.stem));
    const sameStem: any[] = await this.db.client.question_revision.findMany({
      where: { stem_hash: { in: hashes }, state: { not: 'SUPERSEDED' }, question: identity },
      select: { stem_hash: true, question: { select: { code: true } } },
    });

    const items: PlanItem[] = [];
    for (const { where, draft } of parsed.questions) {
      const found = paths.get(draft.objectiveCode);
      if (!found) {
        if (paths.size > 0) issues.push({ where, message: `objective ${draft.objectiveCode} does not exist in this unit's curriculum` });
        continue;
      }
      if (found.length > 1) {
        issues.push({ where, message: `objective code ${draft.objectiveCode} is used more than once in this unit, so it is ambiguous` });
        continue;
      }
      const clash = sameStem.find((s) => s.stem_hash === stemHash(draft.stem) && s.question.code !== draft.code);
      if (clash) {
        issues.push({ where, message: `the same question wording already exists as ${clash.question.code}` });
        continue;
      }
      const q = byCode.get(draft.code);
      if (!q) {
        items.push({ where, draft, objectivePath: found[0], action: 'CREATE' });
        continue;
      }
      const latest = q.revisions[0];
      if (latest.state === 'IN_REVIEW') {
        issues.push({ where, message: `question ${draft.code} is in review and cannot be changed until the reviewer decides` });
      } else if (latest.state === 'RETIRED') {
        issues.push({ where, message: `question ${draft.code} was retired; use a new question code` });
      } else if (OPEN_FOR_EDIT.includes(latest.state)) {
        items.push({ where, draft, objectivePath: found[0], action: 'UPDATE', questionId: q.id, revisionId: latest.id, revisionNo: latest.revision });
      } else {
        // APPROVED (SUPERSEDED is never the latest): a change is a new revision; no change is no-op.
        const unchanged = sameContent(draft, latest) && q.objective_path === found[0];
        items.push({
          where,
          draft,
          objectivePath: found[0],
          action: unchanged ? 'UNCHANGED' : 'NEW_REVISION',
          questionId: q.id,
          revisionId: latest.id,
          revisionNo: latest.revision,
        });
      }
    }
    return { items, issues };
  }

  // --------------------------------------------------------------- write

  /** Writes a plan in one transaction. Anything that changed since planning is a conflict, not a guess. */
  async apply(unit: UnitIdentity, plan: QuestionPlan, ctx: WriteContext): Promise<Record<PlanAction, number>> {
    const counts: Record<PlanAction, number> = { CREATE: 0, UPDATE: 0, NEW_REVISION: 0, UNCHANGED: 0 };
    const accountId = ctx.actor.kind === 'HUMAN' ? ctx.actor.accountId : null;
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const item of plan.items) {
        counts[item.action]++;
        const d = item.draft;
        const options = d.options.map((text, i) => ({ position: i, text, is_correct: i === d.correctIndex }));
        if (item.action === 'UNCHANGED') continue;

        if (item.action === 'CREATE') {
          const q = await tx.question.create({
            data: {
              curriculum_version_id: unit.curriculumVersionId,
              grade_id: unit.gradeId,
              subject_id: unit.subjectId,
              code: d.code,
              objective_path: item.objectivePath,
            },
            select: { id: true },
          });
          await this.createRevision(tx, q.id as string, 1, item, options, ctx, accountId);
          continue;
        }

        const revId = item.revisionId as string;
        await tx.$queryRaw`SELECT id FROM question_revision WHERE id = ${revId}::uuid FOR UPDATE`;
        const rev: any = await tx.question_revision.findUnique({ where: { id: revId } });
        if (!rev) throw new QuestionNotFoundError('question');

        if (item.action === 'UPDATE') {
          if (!OPEN_FOR_EDIT.includes(rev.state)) throw new QuestionConflictError(`question ${d.code} changed state while the file was being saved; check again`);
          const contributors = new Set<string>(rev.contributor_ids ?? []);
          if (accountId) contributors.add(accountId);
          await tx.question_revision.update({
            where: { id: revId },
            data: {
              stem: d.stem,
              explanation: d.explanation,
              difficulty: d.difficulty,
              cognitive: d.cognitive,
              stem_hash: stemHash(d.stem),
              contributor_ids: [...contributors],
              answer_verified: false,
              ...(ctx.origin === 'AI_DRAFT' ? { ai_source: ctx.aiSource ?? null } : {}),
            },
          });
          await tx.question_option.deleteMany({ where: { revision_id: revId } });
          await tx.question_option.createMany({ data: options.map((o) => ({ ...o, revision_id: revId })) });
          await tx.question.update({ where: { id: item.questionId as string }, data: { objective_path: item.objectivePath } });
          await this.event(tx, revId, rev.state, rev.state, ctx.actor, 'wording edited');
          continue;
        }

        // NEW_REVISION: the approved one stays live until the new one is approved.
        if (rev.state !== 'APPROVED') throw new QuestionConflictError(`question ${d.code} changed state while the file was being saved; check again`);
        await tx.question.update({ where: { id: item.questionId as string }, data: { objective_path: item.objectivePath } });
        await this.createRevision(tx, item.questionId as string, (item.revisionNo as number) + 1, item, options, ctx, accountId);
      }
    });
    return counts;
  }

  private async createRevision(
    tx: Prisma.TransactionClient,
    questionId: string,
    revision: number,
    item: PlanItem,
    options: { position: number; text: string; is_correct: boolean }[],
    ctx: WriteContext,
    accountId: string | null,
  ): Promise<void> {
    const d = item.draft;
    const rev = await tx.question_revision.create({
      data: {
        question_id: questionId,
        revision,
        state: 'DRAFT',
        origin: ctx.origin,
        stem: d.stem,
        explanation: d.explanation,
        difficulty: d.difficulty,
        cognitive: d.cognitive,
        stem_hash: stemHash(d.stem),
        authored_by: accountId,
        contributor_ids: accountId ? [accountId] : [],
        ai_source: ctx.origin === 'AI_DRAFT' ? ctx.aiSource ?? null : null,
        options: { create: options },
      },
      select: { id: true },
    });
    await this.event(tx, rev.id as string, null, 'DRAFT', ctx.actor, revision === 1 ? 'created' : `revision ${revision} created`);
  }

  private async event(
    tx: Prisma.TransactionClient,
    revisionId: string,
    from: QuestionState | null,
    to: QuestionState,
    actor: QuestionActor,
    note: string | null,
    reasonCode: string | null = null,
  ): Promise<void> {
    await tx.question_event.create({
      data: {
        revision_id: revisionId,
        from_state: from,
        to_state: to,
        actor_kind: actor.kind,
        actor_account_id: actor.accountId,
        note,
        reason_code: reasonCode,
      },
    });
  }

  // ---------------------------------------------------------- transitions

  /**
   * Moves one revision to a new review state. The row is locked, the state is re-read under the lock, and
   * the rules (roles, separation of duties, answer-key confirmation) are checked by the pure domain.
   */
  async transition(
    revisionId: string,
    to: QuestionState,
    actor: QuestionActor,
    input: { note?: string | null; answerVerified?: boolean; reasonCode?: string | null },
  ): Promise<QuestionState> {
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.$queryRaw`SELECT id FROM question_revision WHERE id = ${revisionId}::uuid FOR UPDATE`;
      const rev: any = await tx.question_revision.findUnique({
        where: { id: revisionId },
        include: { options: { orderBy: { position: 'asc' } }, question: true },
      });
      if (!rev) throw new QuestionNotFoundError('question');

      const involved = new Set<string>(rev.contributor_ids ?? []);
      if (rev.submitted_by) involved.add(rev.submitted_by);
      assertQuestionTransition(rev.state, to, actor, { involved: [...involved], answerVerified: input.answerVerified, note: input.note, reasonCode: input.reasonCode });

      const accountId = actor.kind === 'HUMAN' ? actor.accountId : null;

      if (to === 'IN_REVIEW') {
        const draft = this.draftOf(rev);
        const check = runDeterministicChecks(draft);
        if (!check.passed) {
          throw new QuestionConflictError(`the question is not ready: ${check.findings.filter((f) => f.severity === 'CRITICAL').map((f) => f.message).join('; ')}`);
        }
        await this.recordValidation(tx, revisionId, check);
        await this.requireObjective(tx, rev.question, rev.question.objective_path);
        await tx.question_revision.update({ where: { id: revisionId }, data: { state: to, submitted_by: accountId } });
      } else if (to === 'APPROVED') {
        await this.requireObjective(tx, rev.question, rev.question.objective_path);
        if (rev.state === 'QUARANTINED') {
          // Only one revision of a question may be live: a newer approved one means this cannot come back.
          const other = await tx.question_revision.count({ where: { question_id: rev.question_id, state: 'APPROVED', id: { not: revisionId } } });
          if (other > 0) throw new QuestionConflictError('a newer version of this question is already approved, so this one cannot be restored');
        } else {
          await this.requireCleanDeterministicRun(tx, revisionId, rev);
        }
        // Only one approved revision may be live. The previous one is retired by the system first.
        const previous: any[] = await tx.question_revision.findMany({
          where: { question_id: rev.question_id, state: 'APPROVED', id: { not: revisionId } },
          select: { id: true },
        });
        for (const p of previous) {
          await tx.question_revision.update({ where: { id: p.id }, data: { state: 'SUPERSEDED' } });
          await this.event(tx, p.id, 'APPROVED', 'SUPERSEDED', { kind: 'SYSTEM', accountId: null }, `replaced by revision ${rev.revision}`);
          // Approval is not publication: the new version must be published by a person. The old one stops being served now.
          await withdrawInTx(tx, p.id, { kind: 'SYSTEM', accountId: null }, 'OTHER', `replaced by revision ${rev.revision}`);
        }
        await tx.question_revision.update({
          where: { id: revisionId },
          data: { state: to, reviewed_by: accountId, review_note: input.note?.trim() || null, answer_verified: true },
        });
      } else {
        await tx.question_revision.update({
          where: { id: revisionId },
          data: { state: to, reviewed_by: accountId, review_note: input.note?.trim() || null },
        });
      }
      if (to === 'QUARANTINED' || to === 'RETIRED') {
        // Pulled from the bank in the same step. Restoring a quarantined question does not publish it again.
        await withdrawInTx(tx, revisionId, accountId ? { kind: 'HUMAN', accountId } : { kind: 'SYSTEM', accountId: null }, input.reasonCode ?? null, input.note?.trim() || `moved to ${to.toLowerCase()}`);
      }
      await this.event(tx, revisionId, rev.state, to, actor, input.note?.trim() || null, input.reasonCode ?? null);
      return to;
    });
  }

  private async recordValidation(tx: Prisma.TransactionClient, revisionId: string, r: ReturnType<typeof runDeterministicChecks>): Promise<void> {
    await tx.question_validation_run.create({
      data: {
        revision_id: revisionId,
        validator_version: r.validatorVersion,
        passed: r.passed,
        critical_count: r.critical,
        major_count: r.major,
        minor_count: r.minor,
        findings: r.findings as unknown as Prisma.InputJsonValue,
      },
    });
  }

  /**
   * Approval needs a passing deterministic run on this exact revision. A question submitted before the checks
   * existed has none, so the checks run now (and are recorded) instead of being skipped.
   */
  private async requireCleanDeterministicRun(tx: Prisma.TransactionClient, revisionId: string, rev: any): Promise<void> {
    const last: any = await tx.question_validation_run.findFirst({ where: { revision_id: revisionId }, orderBy: { created_at: 'desc' } });
    if (last?.passed && last.validator_version === DETERMINISTIC_VALIDATOR_VERSION) return;
    const check = runDeterministicChecks(this.draftOf(rev));
    await this.recordValidation(tx, revisionId, check);
    if (!check.passed) {
      throw new QuestionConflictError(`the question does not pass the automatic checks: ${check.findings.filter((f) => f.severity === 'CRITICAL').map((f) => f.message).join('; ')}`);
    }
  }

  private async requireObjective(tx: Prisma.TransactionClient, question: any, path: string): Promise<void> {
    const latest = await tx.curriculum_subject_version.findFirst({
      where: { curriculum_version_id: question.curriculum_version_id, grade_id: question.grade_id, subject_id: question.subject_id },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    const code = path.split('/').pop() as string;
    const found = latest ? (await this.objectivePaths(latest.id as string, tx)).get(code) : undefined;
    if (!found || !found.includes(path)) {
      throw new QuestionConflictError(`the learning objective ${path} no longer exists in this unit's curriculum; update the question to point at a current objective`);
    }
  }

  private draftOf(rev: any): QuestionDraft {
    const options = [...rev.options].sort((a: any, b: any) => a.position - b.position);
    return {
      code: rev.question.code,
      objectiveCode: String(rev.question.objective_path).split('/').pop() as string,
      stem: rev.stem,
      options: options.map((o: any) => o.text),
      correctIndex: options.findIndex((o: any) => o.is_correct),
      difficulty: rev.difficulty,
      cognitive: rev.cognitive ?? null,
      explanation: rev.explanation ?? null,
    };
  }

  /** Approved revisions that came from one AI import file (its hash). Used to pull a bad batch. */
  async approvedRevisionIdsFromSource(aiSource: string): Promise<string[]> {
    const rows: any[] = await this.db.client.question_revision.findMany({
      where: { ai_source: aiSource, state: 'APPROVED' },
      select: { id: true },
      take: 5000,
    });
    return rows.map((r) => r.id as string);
  }

  // ---------------------------------------------------------------- read

  async list(unit: UnitIdentity, state?: QuestionState): Promise<QuestionRow[]> {
    const qs: any[] = await this.db.client.question.findMany({
      where: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId },
      orderBy: { code: 'asc' },
      take: 500,
      include: { bank_state: true, revisions: { orderBy: { revision: 'desc' }, take: 1, include: { publication: true } } },
    });
    const rows = qs.map((q) => {
      const r = q.revisions[0];
      return {
        questionId: q.id,
        revisionId: r.id,
        code: q.code,
        objectivePath: q.objective_path,
        stem: r.stem,
        difficulty: r.difficulty,
        cognitive: r.cognitive ?? null,
        state: r.state,
        revision: r.revision,
        origin: r.origin,
        bankStatus: bankStatus(r.state, r.publication?.state ?? null, q.bank_state?.health ?? null),
      } as QuestionRow;
    });
    return state ? rows.filter((r) => r.state === state) : rows;
  }

  async detail(revisionId: string): Promise<QuestionDetail> {
    const r: any = await this.db.client.question_revision.findUnique({
      where: { id: revisionId },
      include: { options: { orderBy: { position: 'asc' } }, question: { include: { bank_state: true } }, publication: true, events: { orderBy: { occurred_at: 'asc' } }, validation_runs: { orderBy: { created_at: 'desc' }, take: 1 } },
    });
    if (!r) throw new QuestionNotFoundError('question');
    const gen: any = r.origin === 'AI_DRAFT' ? await this.db.client.generation_attempt.findFirst({ where: { question_revision_id: revisionId } }) : null;
    return {
      questionId: r.question_id,
      revisionId: r.id,
      code: r.question.code,
      objectivePath: r.question.objective_path,
      stem: r.stem,
      difficulty: r.difficulty,
      cognitive: r.cognitive ?? null,
      state: r.state,
      revision: r.revision,
      origin: r.origin,
      bankStatus: bankStatus(r.state, r.publication?.state ?? null, r.question.bank_state?.health ?? null),
      publication: r.publication ? { state: r.publication.state, publishedAt: new Date(r.publication.published_at).toISOString(), withdrawnReason: r.publication.withdraw_reason_code ?? null, withdrawnNote: r.publication.withdraw_note ?? null } : null,
      explanation: r.explanation ?? null,
      options: r.options.map((o: any) => ({ label: OPTION_LABELS[o.position], text: o.text, isCorrect: o.is_correct })),
      reviewNote: r.review_note ?? null,
      answerVerified: r.answer_verified,
      aiSource: r.ai_source ?? null,
      validation: r.validation_runs[0]
        ? { validatorVersion: r.validation_runs[0].validator_version, passed: r.validation_runs[0].passed, findings: r.validation_runs[0].findings as Finding[], at: new Date(r.validation_runs[0].created_at).toISOString() }
        : null,
      generation: gen
        ? {
            batchId: gen.batch_id,
            route: gen.route ?? null,
            confidence: gen.confidence === null || gen.confidence === undefined ? null : Number(gen.confidence),
            repairs: gen.repairs,
            issues: Array.isArray(gen.evidence?.issues) ? gen.evidence.issues : [],
            reason: gen.evidence?.reason ?? null,
          }
        : null,
      history: r.events.map((e: any) => ({
        from: e.from_state ?? null,
        to: e.to_state,
        actorKind: e.actor_kind,
        reasonCode: e.reason_code ?? null,
        note: e.note ?? null,
        at: new Date(e.occurred_at).toISOString(),
      })),
    };
  }
}

export function fileHash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
