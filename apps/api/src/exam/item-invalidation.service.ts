import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { pickRole } from '../authz/roles';
import { AuthzService } from '../authz/authz.service';
import type { CurriculumRole } from '../curriculum/curriculum-state';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { isReasonCode } from '../question/reason-codes';
import { allExcluded, scoreAssessment, type Difficulty } from './exam-domain';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from './exam.errors';

type Tx = Prisma.TransactionClient;

/** Same people who publish questions: an approver or super admin. */
export const INVALIDATE_ROLES: readonly CurriculumRole[] = ['APPROVER', 'SUPER_ADMIN'];
/** A version must already be out of serving, so no new test can pick it up while (or after) it is invalidated. */
export const INVALIDATABLE_STATES = ['QUARANTINED', 'RETIRED', 'SUPERSEDED'] as const;

export interface InvalidationImpact {
  revisionId: string;
  code: string;
  state: string;
  /** Items in tests that would stop counting now (already-excluded items are not counted again). */
  items: number;
  inProgress: number;
  submitted: number;
  other: number;
  blockers: string[];
  already: { invalidationId: string; at: string; reasonCode: string; note: string } | null;
}

export interface InvalidationSummary {
  invalidationId: string;
  revisionId: string;
  itemsAffected: number;
  resultsRescored: number;
  sessionsInvalidated: number;
  /** True when this version had already been invalidated: nothing changed this time. */
  repeated: boolean;
}

interface ScoreSnapshot {
  total: number;
  correct: number;
  unanswered: number;
  by_difficulty: Record<Difficulty, { total: number; correct: number }>;
  competitive_eligible: boolean;
}

/**
 * InvalidateAssessmentItem (spec: COMMAND_EVENT_CATALOG; invariants 12 and 18). When a question version turns out to be
 * wrong after students were tested on it, an approver invalidates it. In every test that used it the item stops
 * counting: running tests skip it, finished results are rescored (the result row holds the current value; every change
 * is kept in assessment_result_correction and announced as assessment.rescored.v1 so mastery and competitive points
 * can recalculate), and a test left with no counting items is invalidated. Locked answers are never edited; the item
 * is excluded instead. It is one decision per version, and repeating it changes nothing.
 */
@Injectable()
export class ItemInvalidationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly outbox: OutboxService,
  ) {}

  async impact(accountId: string, revisionId: string): Promise<InvalidationImpact> {
    await this.require(accountId);
    const db = this.db.client as unknown as Tx;
    const rev: any = await db.question_revision.findUnique({ where: { id: revisionId }, select: { id: true, state: true, question: { select: { code: true } } } });
    if (!rev) throw new ExamNotFoundError('Question not found');
    const already: any = await db.assessment_item_invalidation.findUnique({ where: { question_revision_id: revisionId } });
    const items: any[] = await db.assessment_instance_question.findMany({
      where: { question_revision_id: revisionId, excluded: null },
      select: { id: true, instance: { select: { session: { select: { status: true } } } } },
    });
    const status = (i: any) => i.instance?.session?.status ?? null;
    return {
      revisionId,
      code: rev.question.code,
      state: rev.state,
      items: items.length,
      inProgress: items.filter((i) => status(i) === 'IN_PROGRESS').length,
      submitted: items.filter((i) => status(i) === 'SUBMITTED').length,
      other: items.filter((i) => status(i) !== 'IN_PROGRESS' && status(i) !== 'SUBMITTED').length,
      blockers: blockersFor(rev.state),
      already: already ? { invalidationId: already.id, at: already.created_at.toISOString(), reasonCode: already.reason_code, note: already.note } : null,
    };
  }

  async invalidate(accountId: string, revisionId: string, input: { reasonCode: string; note: string }): Promise<InvalidationSummary> {
    const note = input.note.trim();
    if (!isReasonCode(input.reasonCode)) throw new ExamInputError('a listed reason is required');
    if (note.length < 10 || note.length > 1000) throw new ExamInputError('explain what is wrong with the question (10 to 1000 characters)');
    await this.require(accountId);

    const existing = await this.db.client.assessment_item_invalidation.findUnique({ where: { question_revision_id: revisionId } });
    if (existing) return summaryOf(existing, true);

    try {
      return await this.db.client.$transaction(
        async (tx: Tx) => {
          const rev: any = await tx.question_revision.findUnique({ where: { id: revisionId }, select: { id: true, state: true } });
          if (!rev) throw new ExamNotFoundError('Question not found');
          const blockers = blockersFor(rev.state);
          if (blockers.length) throw new ExamConflictError(blockers.join('; '));
          const now = new Date();
          const inv = await tx.assessment_item_invalidation.create({
            data: { question_revision_id: revisionId, reason_code: input.reasonCode, note, invalidated_by: accountId, items_affected: 0, results_rescored: 0, sessions_invalidated: 0 },
          });

          const hits: any[] = await tx.assessment_instance_question.findMany({
            where: { question_revision_id: revisionId, excluded: null },
            select: { instance: { select: { session: { select: { id: true } } } } },
          });
          // Lock every affected session in a fixed order, so this cannot deadlock with itself or a running test.
          const sessionIds = [...new Set(hits.map((h) => h.instance?.session?.id).filter((x): x is string => !!x))].sort();
          let items = 0;
          let rescored = 0;
          let invalidated = 0;
          for (const sid of sessionIds) {
            await tx.$queryRaw`SELECT id FROM assessment_session WHERE id = ${sid}::uuid FOR UPDATE`;
            const session: any = await tx.assessment_session.findUnique({
              where: { id: sid },
              include: { result: true, instance: { include: { items: { orderBy: { position: 'asc' }, include: { response: true } } } } },
            });
            const targets = session.instance.items.filter((i: any) => i.question_revision_id === revisionId && !i.excluded);
            if (!targets.length) continue;
            for (const t of targets) {
              await tx.assessment_instance_question.update({ where: { id: t.id }, data: { excluded: 'INVALIDATED', excluded_at: now, invalidation_id: inv.id } });
              t.excluded = 'INVALIDATED';
              await tx.student_response_event.create({ data: { session_id: sid, instance_question_id: t.id, event_type: 'INVALIDATED', active_ms: null, occurred_at: now } });
              items++;
            }
            const empty = allExcluded(session.instance.items.map((i: any) => ({ excluded: !!i.excluded })));
            if (session.status === 'SUBMITTED' && session.result) {
              await this.rescore(tx, session, inv.id, empty, now);
              rescored++;
            }
            if (empty && (session.status === 'IN_PROGRESS' || session.status === 'SUBMITTED')) {
              await tx.assessment_session.update({ where: { id: sid }, data: { status: 'INVALIDATED', last_activity_at: now } });
              await this.outbox.publish(tx, {
                aggregateType: 'assessment',
                aggregateId: sid,
                eventType: 'assessment.invalidated.v1',
                payload: { assessmentId: sid, studentId: session.student_id, mode: session.mode, reason: 'ALL_ITEMS_EXCLUDED', invalidationId: inv.id },
                idempotencyKey: `assessment.invalidated.v1:${sid}`,
              });
              invalidated++;
            }
          }

          const done = await tx.assessment_item_invalidation.update({
            where: { id: inv.id },
            data: { items_affected: items, results_rescored: rescored, sessions_invalidated: invalidated },
          });
          await tx.audit_event.create({
            data: {
              actor_account_id: accountId,
              action: 'assessment_item.invalidated',
              subject_type: 'question_revision',
              subject_id: revisionId,
              reason_code: input.reasonCode,
              metadata: { invalidationId: inv.id, items, rescored, invalidated },
            },
          });
          await this.outbox.publish(tx, {
            aggregateType: 'question_revision',
            aggregateId: revisionId,
            eventType: 'assessment_item.invalidated.v1',
            payload: { invalidationId: inv.id, questionRevisionId: revisionId, reasonCode: input.reasonCode, items, rescored, invalidated },
            idempotencyKey: `assessment_item.invalidated.v1:${inv.id}`,
          });
          return summaryOf(done, false);
        },
        { timeout: 60_000 },
      );
    } catch (e) {
      // Two approvers at once: the second one gets the first one's decision.
      if ((e as { code?: string }).code === 'P2002') {
        const won = await this.db.client.assessment_item_invalidation.findUnique({ where: { question_revision_id: revisionId } });
        if (won) return summaryOf(won, true);
      }
      throw e;
    }
  }

  /** Recomputes a finished result without the excluded items. The old figures are kept in the correction row. */
  private async rescore(tx: Tx, session: any, invalidationId: string, empty: boolean, now: Date): Promise<void> {
    const r = session.result;
    const before: ScoreSnapshot = {
      total: r.total,
      correct: r.correct,
      unanswered: r.unanswered,
      by_difficulty: r.by_difficulty,
      competitive_eligible: r.competitive_eligible,
    };
    const score = scoreAssessment(
      session.instance.items.map((i: any) => ({ difficulty: i.difficulty, locked: i.response?.state === 'LOCKED', isCorrect: i.response?.is_correct ?? null, excluded: !!i.excluded })),
    );
    const after: ScoreSnapshot = {
      total: score.total,
      correct: score.correct,
      unanswered: score.unanswered,
      by_difficulty: score.byDifficulty,
      // A test with nothing left to count cannot be competitive.
      competitive_eligible: empty ? false : r.competitive_eligible,
    };
    await tx.assessment_result.update({
      where: { id: r.id },
      data: {
        total: after.total,
        correct: after.correct,
        unanswered: after.unanswered,
        by_difficulty: after.by_difficulty as unknown as Prisma.InputJsonValue,
        competitive_eligible: after.competitive_eligible,
        corrected_at: now,
        correction_count: { increment: 1 },
      },
    });
    await tx.assessment_result_correction.create({
      data: {
        result_id: r.id,
        session_id: session.id,
        invalidation_id: invalidationId,
        reason: 'INVALIDATION',
        before: before as unknown as Prisma.InputJsonValue,
        after: after as unknown as Prisma.InputJsonValue,
      },
    });
    await this.outbox.publish(tx, {
      aggregateType: 'assessment',
      aggregateId: session.id,
      eventType: 'assessment.rescored.v1',
      payload: {
        assessmentId: session.id,
        studentId: session.student_id,
        mode: session.mode,
        invalidationId,
        before: { correct: before.correct, total: before.total, competitiveEligible: before.competitive_eligible },
        after: { correct: after.correct, total: after.total, competitiveEligible: after.competitive_eligible },
      },
      idempotencyKey: `assessment.rescored.v1:${session.id}:${invalidationId}`,
    });
  }

  private async require(accountId: string): Promise<void> {
    const role = pickRole(await this.authz.curriculumRolesFor(accountId), INVALIDATE_ROLES);
    if (!role) throw new ExamNotPermittedError('only an approver may invalidate a question in tests already taken');
  }
}

export function blockersFor(state: string): string[] {
  return (INVALIDATABLE_STATES as readonly string[]).includes(state)
    ? []
    : ['take the question out of serving first (quarantine or retire it), so no new test can use it'];
}

function summaryOf(row: any, repeated: boolean): InvalidationSummary {
  return {
    invalidationId: row.id,
    revisionId: row.question_revision_id,
    itemsAffected: row.items_affected,
    resultsRescored: row.results_rescored,
    sessionsInvalidated: row.sessions_invalidated,
    repeated,
  };
}
