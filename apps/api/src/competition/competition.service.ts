import { Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError } from '../exam/exam.errors';
import { ExamService } from '../exam/exam.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  ledgerEntry,
  parseCompetitionPolicy,
  publicHandle,
  qualify,
  rank,
  stillNeeded,
  weekOf,
  xpFor,
  type CompetitionPolicy,
  type Difficulty,
  type Standing,
} from './competition-domain';

type Tx = Prisma.TransactionClient;

export interface CompetitionRun {
  sessionId: string;
  qualified: boolean;
  cp: number;
  ledger: { kind: string; amount: number } | null;
  xp: number;
}

export interface BoardEntry {
  rank: number;
  handle: string;
  cp: number;
  you: boolean;
}

export interface BoardView {
  scope: 'COHORT' | 'SUBJECT';
  title: string;
  subjectCode: string | null;
  entries: BoardEntry[];
  rankedCount: number;
  you: {
    cp: number;
    qualified: number;
    eligibleQuestions: number;
    rank: number | null;
    needs: { tests: number; questions: number };
  };
}

export interface CompeteView {
  policy: string;
  week: { start: string; end: string };
  handle: string;
  /** False for minors in Release 1 (and for adults who chose to be hidden): others never see this student. */
  shownToOthers: boolean;
  /** Adults may choose; minors may not (Release 1). */
  canChangeVisibility: boolean;
  xp: { week: number; total: number };
  boards: BoardView[];
  /** Finished tests waiting to be scored for competition. */
  pending: number;
}

const ACTIVE_STATUSES = ['SUBMITTED', 'INVALIDATED'];

/**
 * Competitive points, XP and weekly leaderboards (Step 15).
 *
 * Like mastery, scoring is asynchronous: a reconciler finds every finished, rescored or invalidated test with no
 * competitive_qualification for its current result revision and processes it once, under the student's row lock.
 * The CP ledger is append-only: the first scoring adds an AWARD, and a rescore or invalidation adds an ADJUSTMENT or
 * REVERSAL dated to the test's own week. Boards are worked out on request from the ledger (a rebuildable projection
 * is not needed at beta scale).
 */
@Injectable()
export class CompetitionService {
  constructor(
    private readonly db: DatabaseService,
    private readonly exam: ExamService,
    private readonly outbox: OutboxService,
  ) {}

  // ── scoring ───────────────────────────────────────────────────────────────

  async reconcile(limit = 50): Promise<CompetitionRun[]> {
    const due = await this.db.client.$queryRaw<Array<{ id: string }>>`
      SELECT s.id
      FROM assessment_session s
      JOIN assessment_result r ON r.session_id = s.id
      WHERE s.status IN ('SUBMITTED', 'INVALIDATED')
        AND NOT EXISTS (
          SELECT 1 FROM competitive_qualification q
          WHERE q.session_id = s.id
            AND q.result_revision = CASE WHEN s.status = 'INVALIDATED' THEN -1 ELSE r.correction_count END
        )
      ORDER BY r.scored_at ASC
      LIMIT ${limit}`;
    const out: CompetitionRun[] = [];
    for (const d of due) {
      const r = await this.processSession(d.id);
      if (r) out.push(r);
    }
    return out;
  }

  async processSession(sessionId: string): Promise<CompetitionRun | null> {
    try {
      return await this.db.client.$transaction(async (tx: Tx) => {
        const head: any = await tx.assessment_session.findUnique({ where: { id: sessionId }, select: { student_id: true } });
        if (!head) return null;
        await tx.$queryRaw`SELECT id FROM student WHERE id = ${head.student_id}::uuid FOR UPDATE`;
        const session: any = await tx.assessment_session.findUnique({
          where: { id: sessionId },
          include: { result: true, instance: { include: { items: { include: { response: true } } } } },
        });
        if (!session || !session.result || !ACTIVE_STATUSES.includes(session.status)) return null;
        const revision = session.status === 'INVALIDATED' ? -1 : session.result.correction_count;
        if (await tx.competitive_qualification.findUnique({ where: { session_id_result_revision: { session_id: sessionId, result_revision: revision } } })) return null;

        const { row: policyRow, policy } = await this.policy(tx);
        const inst = session.instance;
        const studentId: string = session.student_id;
        const finishedAt: Date = session.submitted_at ?? session.result.scored_at;

        const seen = await this.seenBefore(tx, studentId, inst.id, inst.assembled_at, inst.items.map((i: any) => i.question_id));
        const previous: any = await tx.competitive_qualification.findFirst({
          where: { student_id: studentId, subject_id: inst.subject_id, blueprint_code: inst.blueprint_code, qualified: true, finished_at: { lt: finishedAt }, NOT: { session_id: sessionId } },
          orderBy: [{ finished_at: 'desc' }, { created_at: 'desc' }],
        });
        const q = qualify(
          {
            mode: session.mode,
            blueprint: inst.blueprint_code,
            competitiveEligible: session.result.competitive_eligible,
            invalidated: session.status === 'INVALIDATED',
            items: inst.items.map((i: any) => ({
              difficulty: i.difficulty as Difficulty,
              correct: i.response?.state === 'LOCKED' && i.response.is_correct === true,
              excluded: !!i.excluded,
              seenBefore: seen.has(i.question_id),
            })),
            previousAccuracy: previous ? previous.accuracy : null,
          },
          policy,
        );

        const earlier = await tx.competitive_qualification.count({ where: { session_id: sessionId } });
        const unit = { curriculum_version_id: inst.curriculum_version_id, grade_id: inst.grade_id, subject_id: inst.subject_id };
        const qual: any = await tx.competitive_qualification.create({
          data: {
            session_id: sessionId,
            result_revision: revision,
            student_id: studentId,
            policy_version_id: policyRow.id,
            ...unit,
            blueprint_code: inst.blueprint_code,
            qualified: q.qualified,
            reasons: q.reasons,
            eligible_questions: q.eligibleQuestions,
            fresh_questions: q.freshQuestions,
            correct: q.correct,
            accuracy: q.accuracy,
            weighted_accuracy: q.weightedAccuracy,
            difficulty_score: q.difficultyScore,
            cp: q.cp,
            parts: q.parts as unknown as Prisma.InputJsonValue,
            finished_at: finishedAt,
          },
        });

        const sum = await tx.cp_event.aggregate({ where: { session_id: sessionId }, _sum: { amount: true } });
        const entry = ledgerEntry(sum._sum.amount ?? 0, q.cp, earlier === 0);
        if (entry) {
          await tx.cp_event.create({
            data: { student_id: studentId, session_id: sessionId, qualification_id: qual.id, policy_version_id: policyRow.id, ...unit, kind: entry.kind, amount: entry.amount, earned_at: finishedAt },
          });
          await this.outbox.publish(tx, {
            aggregateType: 'student',
            aggregateId: studentId,
            eventType: 'competition.cp_recorded.v1',
            payload: { studentId, sessionId, kind: entry.kind, amount: entry.amount, total: q.cp, resultRevision: revision },
            idempotencyKey: `competition.cp_recorded.v1:${qual.id}`,
          });
        }

        let xp = 0;
        if (session.status === 'SUBMITTED' && !(await tx.xp_event.findUnique({ where: { session_id: sessionId } }))) {
          xp = xpFor(inst.items.filter((i: any) => i.response?.state === 'LOCKED').length, policy);
          if (xp > 0) {
            await tx.xp_event.create({ data: { student_id: studentId, session_id: sessionId, policy_version_id: policyRow.id, amount: xp, mode: session.mode, earned_at: finishedAt } });
          }
        }
        await this.ensureProfile(tx, studentId);
        return { sessionId, qualified: q.qualified, cp: q.cp, ledger: entry, xp };
      });
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  // ── the student's view ────────────────────────────────────────────────────

  async view(accountId: string, now = new Date()): Promise<CompeteView> {
    const studentId = await this.exam.studentFor(accountId);
    const db = this.db.client as any;
    const { row: policyRow, policy } = await this.policy(db);
    const profile = await this.ensureProfile(db, studentId);
    const minor = await this.isMinor(db, studentId);
    const week = weekOf(now, policy);
    const units = await this.exam.listUnits(accountId);
    const svs: any[] = units.length
      ? await db.curriculum_subject_version.findMany({ where: { id: { in: units.map((u) => u.subjectVersionId) } }, select: { id: true, curriculum_version_id: true, grade_id: true, subject_id: true } })
      : [];
    const boards: BoardView[] = [];
    if (svs.length) {
      const cohort = { curriculum_version_id: svs[0].curriculum_version_id, grade_id: svs[0].grade_id };
      const quals: any[] = await db.competitive_qualification.findMany({
        where: { ...cohort, finished_at: { gte: week.start, lt: week.end } },
        orderBy: { created_at: 'asc' },
      });
      const latest = new Map<string, any>();
      for (const q of quals) latest.set(q.session_id, q);
      const counted = [...latest.values()].filter((q) => q.qualified);
      const events: any[] = await db.cp_event.findMany({ where: { ...cohort, earned_at: { gte: week.start, lt: week.end } }, select: { student_id: true, subject_id: true, amount: true } });
      const students = [...new Set([...counted.map((q) => q.student_id), ...events.map((e) => e.student_id), studentId])];
      const shown = await this.shownToOthers(db, students);
      const handles = new Map<string, string>(
        ((await db.public_profile.findMany({ where: { student_id: { in: students } }, select: { student_id: true, handle: true } })) as any[]).map((p) => [p.student_id, p.handle]),
      );

      const board = (scope: 'COHORT' | 'SUBJECT', title: string, subject: { id: string; code: string } | null): BoardView => {
        const inScope = (x: { subject_id: string }) => !subject || x.subject_id === subject.id;
        const standings = new Map<string, Standing>();
        const get = (id: string): Standing =>
          standings.get(id) ?? (standings.set(id, { studentId: id, cp: 0, qualified: 0, eligibleQuestions: 0, accuracy: 0, latestAt: new Date(0), difficulty: 0 }), standings.get(id)!);
        for (const e of events.filter(inScope)) get(e.student_id).cp += e.amount;
        const sums = new Map<string, { acc: number; diff: number }>();
        for (const q of counted.filter(inScope)) {
          const s = get(q.student_id);
          s.qualified++;
          s.eligibleQuestions += q.eligible_questions;
          if (q.finished_at > s.latestAt) s.latestAt = q.finished_at;
          const t = sums.get(q.student_id) ?? { acc: 0, diff: 0 };
          sums.set(q.student_id, { acc: t.acc + q.accuracy, diff: t.diff + q.difficulty_score });
        }
        for (const [id, t] of sums) {
          const s = get(id);
          s.accuracy = t.acc / s.qualified;
          s.difficulty = t.diff / s.qualified;
        }
        const me = get(studentId);
        // Ranks are worked out among students others may see, plus the viewer: a hidden student is never a gap.
        const ranked = rank([...standings.values()].filter((s) => s.studentId === studentId || shown.has(s.studentId)), policy);
        const mine = ranked.find((r) => r.studentId === studentId) ?? null;
        const listed = ranked.slice(0, policy.ranking.boardSize);
        if (mine && !listed.includes(mine)) listed.push(mine);
        return {
          scope,
          title,
          subjectCode: subject?.code ?? null,
          entries: listed.map((r) => ({ rank: r.rank, handle: handles.get(r.studentId) ?? 'Learner', cp: r.cp, you: r.studentId === studentId })),
          rankedCount: ranked.length,
          you: { cp: me.cp, qualified: me.qualified, eligibleQuestions: me.eligibleQuestions, rank: mine?.rank ?? null, needs: stillNeeded(me, policy) },
        };
      };

      const cohortTitle = units[0] ? `All subjects · ${units[0].curriculumCode} ${units[0].gradeCode.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase())}` : 'All subjects';
      boards.push(board('COHORT', cohortTitle, null));
      for (const u of units) {
        const sv = svs.find((x) => x.id === u.subjectVersionId);
        if (sv) boards.push(board('SUBJECT', u.subjectName, { id: sv.subject_id, code: u.subjectCode }));
      }
    }
    const xpWeek = await db.xp_event.aggregate({ where: { student_id: studentId, earned_at: { gte: week.start, lt: week.end } }, _sum: { amount: true } });
    const xpTotal = await db.xp_event.aggregate({ where: { student_id: studentId }, _sum: { amount: true } });
    const waiting: Array<{ n: bigint | number }> = await db.$queryRaw`
      SELECT count(*) AS n
      FROM assessment_session s
      JOIN assessment_result r ON r.session_id = s.id
      WHERE s.student_id = ${studentId}::uuid
        AND s.status IN ('SUBMITTED', 'INVALIDATED')
        AND NOT EXISTS (
          SELECT 1 FROM competitive_qualification q
          WHERE q.session_id = s.id AND q.result_revision = CASE WHEN s.status = 'INVALIDATED' THEN -1 ELSE r.correction_count END
        )`;
    return {
      policy: policyRow.code,
      week: { start: week.start.toISOString(), end: week.end.toISOString() },
      handle: profile.handle,
      shownToOthers: !minor && profile.shown_to_others !== false,
      canChangeVisibility: !minor,
      xp: { week: xpWeek._sum.amount ?? 0, total: xpTotal._sum.amount ?? 0 },
      boards,
      pending: Number(waiting[0]?.n ?? 0),
    };
  }

  /** An adult may hide from (or return to) other students' boards. Not available to minors in Release 1. */
  async setShown(accountId: string, shown: boolean): Promise<{ shownToOthers: boolean }> {
    const studentId = await this.exam.studentFor(accountId);
    const db = this.db.client as any;
    if (await this.isMinor(db, studentId)) throw new ExamConflictError('Students who are minors are not shown to other students on leaderboards yet, so there is nothing to change');
    await this.ensureProfile(db, studentId);
    await db.public_profile.update({ where: { student_id: studentId }, data: { shown_to_others: shown } });
    return { shownToOthers: shown };
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async policy(db: any): Promise<{ row: any; policy: CompetitionPolicy }> {
    const row = await db.competitive_scoring_policy.findFirst({ where: { status: 'ACTIVE' } });
    if (!row) throw new Error('no ACTIVE competition policy: competitive points are not recorded until one exists');
    return { row, policy: parseCompetitionPolicy(row.params) };
  }

  /** Questions of this test the student met in an earlier test or practice (shown to them, not only assembled). */
  private async seenBefore(tx: Tx, studentId: string, instanceId: string, assembledAt: Date, questionIds: string[]): Promise<Set<string>> {
    if (!questionIds.length) return new Set();
    const rows: any[] = await tx.assessment_instance_question.findMany({
      where: {
        question_id: { in: questionIds },
        instance: { student_id: studentId, id: { not: instanceId }, assembled_at: { lt: assembledAt } },
        response: { presented_at: { not: null } },
      },
      select: { question_id: true },
    });
    return new Set(rows.map((r) => r.question_id));
  }

  /** Minor status from the current age classification. No classification is treated as a minor (fail closed). */
  private async isMinor(db: any, studentId: string): Promise<boolean> {
    const c = await db.age_classification.findFirst({ where: { student_id: studentId, superseded_at: null }, select: { is_minor: true } });
    return c ? c.is_minor === true : true;
  }

  private async shownToOthers(db: any, studentIds: string[]): Promise<Set<string>> {
    const [classes, profiles]: [any[], any[]] = await Promise.all([
      db.age_classification.findMany({ where: { student_id: { in: studentIds }, superseded_at: null }, select: { student_id: true, is_minor: true } }),
      db.public_profile.findMany({ where: { student_id: { in: studentIds } }, select: { student_id: true, shown_to_others: true } }),
    ]);
    const adult = new Set(classes.filter((c) => c.is_minor === false).map((c) => c.student_id));
    const hidden = new Set(profiles.filter((p) => p.shown_to_others === false).map((p) => p.student_id));
    return new Set(studentIds.filter((id) => adult.has(id) && !hidden.has(id)));
  }

  /**
   * The student's public handle, made on first need. ON CONFLICT DO NOTHING, so a concurrent request (or, very rarely,
   * a handle already taken) never aborts the caller's transaction; a taken handle is simply tried again.
   */
  private async ensureProfile(db: any, studentId: string): Promise<{ handle: string; shown_to_others: boolean | null }> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const existing = await db.public_profile.findUnique({ where: { student_id: studentId } });
      if (existing) return existing;
      const handle = publicHandle(() => randomInt(0, 1_000_000) / 1_000_000);
      await db.$executeRaw`INSERT INTO public_profile (student_id, handle, created_at, updated_at) VALUES (${studentId}::uuid, ${handle}, now(), now()) ON CONFLICT DO NOTHING`;
    }
    throw new Error('could not create a unique public handle');
  }
}
