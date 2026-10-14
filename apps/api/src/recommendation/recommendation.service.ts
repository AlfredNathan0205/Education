import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamNotFoundError, ExamUnavailableError } from '../exam/exam.errors';
import { ExamService } from '../exam/exam.service';
import { OutboxService } from '../outbox/outbox.service';
import type { Label } from '../mastery/mastery-domain';
import {
  missedTargets,
  parseRecommendationPolicy,
  planRefresh,
  practiceTargets,
  putOffObjectives,
  type Action,
  type ActiveRecommendation,
  type Kind,
  type ReasonCode,
  type RecommendationPolicy,
  type Source,
  type Target,
} from './recommendation-domain';

type Tx = Prisma.TransactionClient;

export interface RefreshSummary {
  runId: string;
  studentId: string;
  created: string[];
  completed: string[];
  reopened: string[];
  superseded: string[];
}

export interface RecommendationObjectiveView {
  path: string;
  statement: string;
  chapterTitle: string;
}

/** What a student sees. Reason codes and answer counts only: never mastery numbers or confidence. */
export interface RecommendationView {
  id: string;
  kind: Kind;
  status: 'OPEN' | 'STARTED';
  source: Source;
  subjectVersionId: string;
  subjectCode: string;
  subjectName: string;
  objectives: RecommendationObjectiveView[];
  reasons: Array<{ path: string; code: ReasonCode; missed?: number }>;
  /** Set while a practice or retest built for it is still open: Start resumes it. */
  inProgressAssessmentId: string | null;
  createdAt: string;
}

export interface UnitRef {
  subjectVersionId: string;
  subjectCode: string;
  subjectName: string;
}

const ACTIVE = ['OPEN', 'STARTED'];

/**
 * Recommendations, practice and retest (Step 14; spec domain 15 "Recommendations": Next Best Action, practice/retest
 * recommendations; Result -> Mastery Evidence -> Diagnostics -> Recommendation).
 *
 * After every mastery run a reconciler refreshes that student's recommendation for the subject (one refresh per run,
 * so retries never act twice). The student can start a recommendation (a PRACTICE set, or a short RETEST after
 * practice), put it off ("not now"), or practise what they missed straight from a finished test. Every action is
 * recorded as an event and published to the outbox.
 */
@Injectable()
export class RecommendationService {
  constructor(
    private readonly db: DatabaseService,
    private readonly exam: ExamService,
    private readonly outbox: OutboxService,
  ) {}

  // ── refresh after mastery ─────────────────────────────────────────────────

  /** Refreshes recommendations for up to `limit` mastery runs that have not been looked at yet. */
  async reconcile(limit = 50): Promise<RefreshSummary[]> {
    const due = await this.db.client.$queryRaw<Array<{ id: string }>>`
      SELECT m.id
      FROM mastery_update_run m
      WHERE NOT EXISTS (SELECT 1 FROM recommendation_refresh f WHERE f.mastery_run_id = m.id)
      ORDER BY m.created_at ASC
      LIMIT ${limit}`;
    const out: RefreshSummary[] = [];
    for (const d of due) {
      const r = await this.refreshForRun(d.id);
      if (r) out.push(r);
    }
    return out;
  }

  async refreshForRun(runId: string): Promise<RefreshSummary | null> {
    try {
      return await this.db.client.$transaction(async (tx: Tx) => {
        const run: any = await tx.mastery_update_run.findUnique({ where: { id: runId }, select: { id: true, session_id: true, student_id: true } });
        if (!run) return null;
        await tx.$queryRaw`SELECT id FROM student WHERE id = ${run.student_id}::uuid FOR UPDATE`;
        if (await tx.recommendation_refresh.findUnique({ where: { mastery_run_id: runId } })) return null;
        const { row: policyRow, policy } = await this.policy(tx);
        const session: any = await tx.assessment_session.findUnique({ where: { id: run.session_id }, include: { instance: true } });
        if (!session) return null;
        const unit = { curriculumVersionId: session.instance.curriculum_version_id, gradeId: session.instance.grade_id, subjectId: session.instance.subject_id };
        const now = new Date();

        const states: any[] = await tx.student_mastery_state.findMany({
          where: { student_id: run.student_id, curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId },
        });
        const dismissed: any[] = await tx.recommendation.findMany({
          where: { student_id: run.student_id, subject_id: unit.subjectId, status: 'DISMISSED', closed_at: { not: null } },
          select: { objective_paths: true, closed_at: true },
        });
        const putOff = putOffObjectives(
          dismissed.map((d) => ({ objectivePaths: d.objective_paths, closedAt: d.closed_at })),
          now,
          policy,
        );
        const targets = practiceTargets(
          states.map((s) => ({
            path: s.objective_path,
            label: s.label as Label,
            reportable: s.reportable,
            mastery: s.mastery,
            evidenceCount: s.evidence_count,
            lastEvidenceAt: s.last_evidence_at,
          })),
          putOff,
          policy,
        );
        const active = await this.activeOf(tx, run.student_id, unit);
        const actions = planRefresh(active, targets, policy);
        const summary: RefreshSummary = { runId, studentId: run.student_id, created: [], completed: [], reopened: [], superseded: [] };
        for (const a of actions) await this.apply(tx, a, { studentId: run.student_id, unit, policyId: policyRow.id, runId, now, summary });
        await tx.recommendation_refresh.create({
          data: {
            mastery_run_id: runId,
            student_id: run.student_id,
            policy_version_id: policyRow.id,
            outcome: { created: summary.created, completed: summary.completed, reopened: summary.reopened, superseded: summary.superseded } as Prisma.InputJsonValue,
          },
        });
        return summary;
      });
    } catch (e) {
      // Another worker refreshed this run first.
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  // ── student actions ───────────────────────────────────────────────────────

  /** The student's open and started recommendations, for the subjects of their cohort. */
  async mine(accountId: string): Promise<RecommendationView[]> {
    const studentId = await this.exam.studentFor(accountId);
    const units = await this.exam.listUnits(accountId);
    return this.forStudent(studentId, units);
  }

  /** Same, for a student already gated (Home). Recommendations for subjects outside `units` are not shown. */
  async forStudent(studentId: string, units: UnitRef[]): Promise<RecommendationView[]> {
    const db = this.db.client as any;
    const recs: any[] = await db.recommendation.findMany({
      where: { student_id: studentId, status: { in: ACTIVE } },
      include: { reasons: true, instances: { include: { session: true }, orderBy: { assembled_at: 'desc' }, take: 1 } },
      orderBy: { created_at: 'asc' },
    });
    const out: RecommendationView[] = [];
    for (const r of recs) {
      const svId = await this.exam.servedUnitId(db, { curriculumVersionId: r.curriculum_version_id, gradeId: r.grade_id, subjectId: r.subject_id });
      const unit = units.find((u) => u.subjectVersionId === svId);
      if (!svId || !unit) continue;
      const names = await this.objectiveNames(db, svId);
      const open = r.instances[0]?.session?.status === 'IN_PROGRESS' ? (r.instances[0].session.id as string) : null;
      out.push({
        id: r.id,
        kind: r.kind,
        status: r.status,
        source: r.source,
        subjectVersionId: svId,
        subjectCode: unit.subjectCode,
        subjectName: unit.subjectName,
        objectives: (r.objective_paths as string[]).map((path) => ({ path, statement: names.get(path)?.statement ?? path, chapterTitle: names.get(path)?.chapterTitle ?? '' })),
        reasons: r.reasons
          .map((x: any) => ({ path: x.objective_path, code: x.code as ReasonCode, ...(typeof x.facts?.missed === 'number' ? { missed: x.facts.missed } : {}) }))
          .sort((a: any, b: any) => a.path.localeCompare(b.path)),
        inProgressAssessmentId: open,
        createdAt: r.created_at.toISOString(),
      });
    }
    return out;
  }

  /** Starts (or resumes) the practice set or retest for a recommendation. */
  async start(accountId: string, recommendationId: string): Promise<{ assessmentId: string; resumed: boolean }> {
    const studentId = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
      const rec: any = await tx.recommendation.findFirst({ where: { id: recommendationId, student_id: studentId } });
      if (!rec) throw new ExamNotFoundError('Recommendation not found');
      if (!ACTIVE.includes(rec.status)) throw new ExamConflictError('This recommendation is no longer open');
      const { policy } = await this.policy(tx);
      return this.startIn(tx, studentId, rec, policy);
    });
  }

  /** "Not now": the same objectives are not recommended again for the policy's quiet period. */
  async dismiss(accountId: string, recommendationId: string): Promise<{ dismissed: true }> {
    const studentId = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
      const rec: any = await tx.recommendation.findFirst({ where: { id: recommendationId, student_id: studentId }, include: { instances: { include: { session: true } } } });
      if (!rec) throw new ExamNotFoundError('Recommendation not found');
      if (rec.status === 'DISMISSED') return { dismissed: true as const };
      if (!ACTIVE.includes(rec.status)) throw new ExamConflictError('This recommendation is no longer open');
      if (rec.instances.some((i: any) => i.session?.status === 'IN_PROGRESS')) throw new ExamConflictError('Finish or leave the practice you started first');
      const now = new Date();
      await tx.recommendation.update({ where: { id: rec.id }, data: { status: 'DISMISSED', closed_at: now } });
      await this.event(tx, rec, 'DISMISSED', null, now);
      return { dismissed: true as const };
    });
  }

  /** "Practise what you missed": a practice set on the objectives of the wrong or unanswered questions of a finished test. */
  async practiseMissed(accountId: string, assessmentId: string): Promise<{ assessmentId: string; resumed: boolean; recommendationId: string }> {
    const studentId = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
      const session: any = await tx.assessment_session.findFirst({
        where: { id: assessmentId, student_id: studentId },
        include: { instance: { include: { items: { include: { response: true } } } } },
      });
      if (!session) throw new ExamNotFoundError('Assessment not found');
      if (session.status !== 'SUBMITTED') throw new ExamConflictError('Finish the test first');
      if (session.mode !== 'TEST') throw new ExamConflictError('Practice sets come from tests, not from other practice');
      const { row: policyRow, policy } = await this.policy(tx);
      const inst = session.instance;
      const unit = { curriculumVersionId: inst.curriculum_version_id, gradeId: inst.grade_id, subjectId: inst.subject_id };

      // Asked again for the same test: carry on with the one already made.
      const same: any = await tx.recommendation.findFirst({ where: { student_id: studentId, source_assessment_id: assessmentId, status: { in: ACTIVE } } });
      if (same) return { ...(await this.startIn(tx, studentId, same, policy)), recommendationId: same.id };

      const targets = missedTargets(
        inst.items.map((i: any) => ({ objectivePath: i.objective_path, locked: i.response?.state === 'LOCKED', isCorrect: i.response?.is_correct ?? null, excluded: !!i.excluded })),
        assessmentId,
        policy,
      );
      if (targets.length === 0) throw new ExamUnavailableError('You got every question in this test right: there is nothing to practise from it');

      const active: any = await tx.recommendation.findFirst({
        where: { student_id: studentId, curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId, status: { in: ACTIVE } },
        include: { instances: { include: { session: true } } },
      });
      const now = new Date();
      if (active) {
        if (active.instances.some((i: any) => i.session?.status === 'IN_PROGRESS')) throw new ExamConflictError('Finish the practice or retest you started in this subject first');
        await tx.recommendation.update({ where: { id: active.id }, data: { status: 'SUPERSEDED', closed_at: now } });
        await this.event(tx, active, 'SUPERSEDED', null, now);
      }
      const rec = await this.create(tx, {
        studentId,
        unit,
        policyId: policyRow.id,
        kind: 'PRACTICE',
        source: 'RESULT',
        objectivePaths: targets.map((t) => t.path),
        reasons: targets,
        parentId: null,
        runId: null,
        sourceAssessmentId: assessmentId,
        now,
      });
      return { ...(await this.startIn(tx, studentId, rec, policy)), recommendationId: rec.id as string };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async startIn(tx: Tx, studentId: string, rec: any, policy: RecommendationPolicy): Promise<{ assessmentId: string; resumed: boolean }> {
    const unit = { curriculumVersionId: rec.curriculum_version_id, gradeId: rec.grade_id, subjectId: rec.subject_id };
    const svId = await this.exam.servedUnitId(tx, unit);
    if (!svId) throw new ExamUnavailableError('This subject is not open for tests at the moment');
    const kind: Kind = rec.kind;
    const out = await this.exam.createIn(tx, studentId, {
      subjectVersionId: svId,
      mode: kind === 'PRACTICE' ? 'PRACTICE' : 'TEST',
      blueprint: kind === 'PRACTICE' ? policy.blueprints.practice : policy.blueprints.retest,
      target: { objectives: rec.objective_paths, recommendationId: rec.id },
    });
    if (!out.resumed) {
      const now = new Date();
      if (rec.status !== 'STARTED') await tx.recommendation.update({ where: { id: rec.id }, data: { status: 'STARTED' } });
      await this.event(tx, rec, 'STARTED', out.assessmentId, now);
    }
    return out;
  }

  private async policy(tx: Tx): Promise<{ row: any; policy: RecommendationPolicy }> {
    const row: any = await tx.recommendation_policy_version.findFirst({ where: { status: 'ACTIVE' } });
    if (!row) throw new Error('no ACTIVE recommendation policy: recommendations are not made until one exists');
    return { row, policy: parseRecommendationPolicy(row.params) };
  }

  private async activeOf(tx: Tx, studentId: string, unit: { curriculumVersionId: string; gradeId: string; subjectId: string }): Promise<ActiveRecommendation | null> {
    const rec: any = await tx.recommendation.findFirst({
      where: { student_id: studentId, curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId, status: { in: ACTIVE } },
      include: { instances: { orderBy: { assembled_at: 'desc' }, take: 1, include: { session: { include: { responses: { where: { state: 'LOCKED' }, select: { id: true } } } } } } },
    });
    if (!rec) return null;
    const s = rec.instances[0]?.session ?? null;
    return {
      id: rec.id,
      kind: rec.kind,
      status: rec.status,
      objectivePaths: rec.objective_paths,
      session: s ? { status: s.status, lockedAnswers: s.responses.length } : null,
    };
  }

  private async apply(
    tx: Tx,
    a: Action,
    ctx: { studentId: string; unit: { curriculumVersionId: string; gradeId: string; subjectId: string }; policyId: string; runId: string; now: Date; summary: RefreshSummary },
  ): Promise<void> {
    if (a.type === 'CREATE') {
      const rec = await this.create(tx, {
        studentId: ctx.studentId,
        unit: ctx.unit,
        policyId: ctx.policyId,
        kind: a.kind,
        source: a.source,
        objectivePaths: a.objectivePaths,
        reasons: a.reasons,
        parentId: a.parentId,
        runId: ctx.runId,
        sourceAssessmentId: null,
        now: ctx.now,
      });
      ctx.summary.created.push(rec.id);
      return;
    }
    const rec: any = await tx.recommendation.findUniqueOrThrow({ where: { id: a.id } });
    if (a.type === 'COMPLETE') {
      await tx.recommendation.update({ where: { id: a.id }, data: { status: 'COMPLETED', closed_at: ctx.now } });
      await this.event(tx, rec, 'COMPLETED', null, ctx.now);
      ctx.summary.completed.push(a.id);
    } else if (a.type === 'REOPEN') {
      await tx.recommendation.update({ where: { id: a.id }, data: { status: 'OPEN' } });
      await this.event(tx, rec, 'REOPENED', null, ctx.now);
      ctx.summary.reopened.push(a.id);
    } else {
      await tx.recommendation.update({ where: { id: a.id }, data: { status: 'SUPERSEDED', closed_at: ctx.now } });
      await this.event(tx, rec, 'SUPERSEDED', null, ctx.now);
      ctx.summary.superseded.push(a.id);
    }
  }

  private async create(
    tx: Tx,
    c: {
      studentId: string;
      unit: { curriculumVersionId: string; gradeId: string; subjectId: string };
      policyId: string;
      kind: Kind;
      source: Source;
      objectivePaths: string[];
      reasons: Target[];
      parentId: string | null;
      runId: string | null;
      sourceAssessmentId: string | null;
      now: Date;
    },
  ): Promise<any> {
    const rec: any = await tx.recommendation.create({
      data: {
        student_id: c.studentId,
        curriculum_version_id: c.unit.curriculumVersionId,
        grade_id: c.unit.gradeId,
        subject_id: c.unit.subjectId,
        kind: c.kind,
        source: c.source,
        objective_paths: c.objectivePaths,
        policy_version_id: c.policyId,
        source_run_id: c.runId,
        source_assessment_id: c.sourceAssessmentId,
        parent_id: c.parentId,
        reasons: { create: c.reasons.map((r) => ({ objective_path: r.path, code: r.code, facts: r.facts as Prisma.InputJsonValue })) },
      },
    });
    await this.event(tx, rec, 'CREATED', null, c.now);
    return rec;
  }

  private async event(tx: Tx, rec: any, type: 'CREATED' | 'STARTED' | 'COMPLETED' | 'REOPENED' | 'DISMISSED' | 'SUPERSEDED', assessmentId: string | null, at: Date): Promise<void> {
    const ev: any = await tx.recommendation_event.create({ data: { recommendation_id: rec.id, type, assessment_id: assessmentId, at } });
    await this.outbox.publish(tx, {
      aggregateType: 'recommendation',
      aggregateId: rec.id,
      eventType: `recommendation.${type.toLowerCase()}.v1`,
      payload: { recommendationId: rec.id, studentId: rec.student_id, kind: rec.kind, source: rec.source, objectives: rec.objective_paths, assessmentId },
      idempotencyKey: `recommendation.${type.toLowerCase()}.v1:${ev.id}`,
    });
  }

  private async objectiveNames(db: any, subjectVersionId: string): Promise<Map<string, { statement: string; chapterTitle: string }>> {
    const sv = await db.curriculum_subject_version.findUnique({
      where: { id: subjectVersionId },
      select: {
        chapters: {
          select: {
            code: true,
            title: true,
            topics: {
              select: { code: true, micro_concepts: { select: { code: true, learning_objectives: { select: { code: true, statement: true } } } } },
            },
          },
        },
      },
    });
    const out = new Map<string, { statement: string; chapterTitle: string }>();
    for (const c of sv?.chapters ?? [])
      for (const t of c.topics)
        for (const m of t.micro_concepts)
          for (const o of m.learning_objectives) out.set(`${c.code}/${t.code}/${m.code}/${o.code}`, { statement: o.statement, chapterTitle: c.title });
    return out;
  }
}
