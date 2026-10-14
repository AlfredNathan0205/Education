import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  objectiveState,
  parsePolicy,
  sliceState,
  weightsFor,
  type Cognitive,
  type Difficulty,
  type Health,
  type MasteryPolicy,
  type ObjectiveState,
} from './mastery-domain';

type Tx = Prisma.TransactionClient;

export interface RunSummary {
  sessionId: string;
  runId: string;
  evidenceAdded: number;
  evidenceInvalidated: number;
  objectivesChanged: number;
}

interface ObjectiveKey {
  studentId: string;
  curriculumVersionId: string;
  gradeId: string;
  subjectId: string;
  path: string;
}

/**
 * Turns finished tests into mastery (spec update order: validate result -> mappings -> exposure -> evidence weights ->
 * immutable evidence -> objective state/confidence -> difficulty/cognitive -> trajectory -> claim gates).
 *
 * Asynchronous by design: a test's result never waits for mastery, and a failure here never undoes it. A reconciler
 * finds every scored, rescored or invalidated test that has no run for its current result revision and processes it.
 * A run is unique per (session, result revision), so retries and a second worker never add evidence twice.
 */
@Injectable()
export class MasteryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  /** Processes up to `limit` tests that are due. Returns what each run did. */
  async reconcile(limit = 50): Promise<RunSummary[]> {
    const due = await this.db.client.$queryRaw<Array<{ id: string }>>`
      SELECT s.id
      FROM assessment_session s
      JOIN assessment_result r ON r.session_id = s.id
      WHERE s.status IN ('SUBMITTED', 'INVALIDATED')
        AND NOT EXISTS (
          SELECT 1 FROM mastery_update_run m
          WHERE m.session_id = s.id
            AND m.result_revision = CASE WHEN s.status = 'INVALIDATED' THEN -1 ELSE r.correction_count END
        )
      ORDER BY r.scored_at ASC
      LIMIT ${limit}`;
    const out: RunSummary[] = [];
    for (const d of due) {
      const r = await this.processSession(d.id);
      if (r) out.push(r);
    }
    return out;
  }

  /** One test, in one transaction under the student's row lock. Returns null when there is nothing to do. */
  async processSession(sessionId: string): Promise<RunSummary | null> {
    try {
      return await this.db.client.$transaction(async (tx: Tx) => {
        const head: any = await tx.assessment_session.findUnique({ where: { id: sessionId }, select: { student_id: true } });
        if (!head) return null;
        // One student at a time: two runs for the same student must not recompute the same objective concurrently.
        await tx.$queryRaw`SELECT id FROM student WHERE id = ${head.student_id}::uuid FOR UPDATE`;
        const session: any = await tx.assessment_session.findUnique({
          where: { id: sessionId },
          include: { result: true, instance: { include: { items: { include: { response: true } } } } },
        });
        if (!session || !session.result || (session.status !== 'SUBMITTED' && session.status !== 'INVALIDATED')) return null;
        const revision = session.status === 'INVALIDATED' ? -1 : session.result.correction_count;
        if (await tx.mastery_update_run.findUnique({ where: { session_id_result_revision: { session_id: sessionId, result_revision: revision } } })) return null;

        const policyRow: any = await tx.mastery_policy_version.findFirst({ where: { status: 'ACTIVE' } });
        if (!policyRow) throw new Error('no ACTIVE mastery policy: mastery is not updated until one exists');
        const policy = parsePolicy(policyRow.params);
        const inst = session.instance;
        const studentId: string = session.student_id;

        const existing: any[] = await tx.mastery_evidence_event.findMany({ where: { session_id: sessionId } });
        const byItem = new Map(existing.map((e) => [e.instance_question_id, e]));
        const now = new Date();
        const touched = new Set<string>();

        // Invalidate evidence whose item no longer counts (or the whole test, when it was invalidated).
        let invalidated = 0;
        for (const item of inst.items) {
          const e = byItem.get(item.id);
          if (!e || e.invalidated_at) continue;
          const reason = session.status === 'INVALIDATED' ? 'SESSION_INVALIDATED' : item.excluded === 'INVALIDATED' ? 'ITEM_INVALIDATED' : item.excluded ? 'TECHNICAL_FAILURE' : null;
          if (!reason) continue;
          await tx.mastery_evidence_event.update({ where: { id: e.id }, data: { invalidated_at: now, invalidation_reason: reason } });
          touched.add(e.objective_path);
          invalidated++;
        }

        // Add evidence for every locked, counted answer that has none yet.
        let added = 0;
        if (session.status === 'SUBMITTED') {
          const fresh = inst.items.filter((i: any) => !i.excluded && i.response?.state === 'LOCKED' && i.response.is_correct !== null && !byItem.has(i.id));
          if (fresh.length) {
            const los = await this.objectiveIds(tx, inst.subject_version_id);
            const revs: any[] = await tx.question_revision.findMany({ where: { id: { in: fresh.map((i: any) => i.question_revision_id) } }, select: { id: true, cognitive: true } });
            const health: any[] = await tx.question_bank_state.findMany({ where: { question_id: { in: fresh.map((i: any) => i.question_id) } }, select: { question_id: true, health: true } });
            const quarantined: any[] = await tx.question_revision.findMany({
              where: { id: { in: fresh.map((i: any) => i.question_revision_id) }, state: 'QUARANTINED' },
              select: { id: true },
            });
            for (const item of fresh) {
              const repeat =
                (await tx.mastery_evidence_event.count({ where: { student_id: studentId, question_id: item.question_id, invalidated_at: null, NOT: { session_id: sessionId } } })) > 0;
              const h: Health | null = quarantined.some((q) => q.id === item.question_revision_id)
                ? 'QUARANTINED'
                : ((health.find((x) => x.question_id === item.question_id)?.health as Health | undefined) ?? null);
              const w = weightsFor({ mode: session.mode, testSize: inst.items.length, health: h, repeat }, policy);
              await tx.mastery_evidence_event.create({
                data: {
                  student_id: studentId,
                  curriculum_version_id: inst.curriculum_version_id,
                  grade_id: inst.grade_id,
                  subject_id: inst.subject_id,
                  objective_path: item.objective_path,
                  learning_objective_id: los.get(item.objective_path) ?? null,
                  subject_version_id: inst.subject_version_id,
                  session_id: sessionId,
                  instance_question_id: item.id,
                  question_id: item.question_id,
                  question_revision_id: item.question_revision_id,
                  mode: session.mode,
                  blueprint_code: inst.blueprint_code,
                  score: item.response.is_correct ? 1 : 0,
                  difficulty: item.difficulty,
                  cognitive: revs.find((r) => r.id === item.question_revision_id)?.cognitive ?? null,
                  w_independence: w.independence,
                  w_context: w.context,
                  w_quality: w.quality,
                  weight: w.weight,
                  policy_version_id: policyRow.id,
                  answered_at: item.response.locked_at ?? session.submitted_at ?? now,
                },
              });
              touched.add(item.objective_path);
              added++;
            }
          }
        }

        const run = await tx.mastery_update_run.create({
          data: { session_id: sessionId, result_revision: revision, student_id: studentId, policy_version_id: policyRow.id, evidence_added: added, evidence_invalidated: invalidated, objectives_changed: 0 },
        });

        let changed = 0;
        for (const path of [...touched].sort()) {
          const key = { studentId, curriculumVersionId: inst.curriculum_version_id, gradeId: inst.grade_id, subjectId: inst.subject_id, path };
          if (await this.recompute(tx, key, policy, policyRow.id, run.id, now)) changed++;
        }
        if (touched.size) await this.recomputeSlices(tx, studentId, inst.subject_id, policy);
        await tx.mastery_update_run.update({ where: { id: run.id }, data: { objectives_changed: changed } });
        await this.outbox.publish(tx, {
          aggregateType: 'student',
          aggregateId: studentId,
          eventType: 'mastery.updated.v1',
          payload: { studentId, sessionId, runId: run.id, resultRevision: revision, evidenceAdded: added, evidenceInvalidated: invalidated, objectivesChanged: changed },
          idempotencyKey: `mastery.updated.v1:${run.id}`,
        });
        return { sessionId, runId: run.id, evidenceAdded: added, evidenceInvalidated: invalidated, objectivesChanged: changed };
      });
    } catch (e) {
      // Another worker processed the same revision first.
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  /** Recomputes one objective from all its valid evidence. Returns true when the stored state changed. */
  private async recompute(tx: Tx, k: ObjectiveKey, policy: MasteryPolicy, policyId: string, runId: string, now: Date): Promise<boolean> {
    const rows: any[] = await tx.mastery_evidence_event.findMany({
      where: { student_id: k.studentId, curriculum_version_id: k.curriculumVersionId, grade_id: k.gradeId, subject_id: k.subjectId, objective_path: k.path, invalidated_at: null },
      orderBy: { answered_at: 'asc' },
      select: { score: true, weight: true, w_quality: true, mode: true, question_id: true, session_id: true, answered_at: true },
    });
    const s: ObjectiveState = objectiveState(
      rows.map((r) => ({ score: r.score, weight: r.weight, wQuality: r.w_quality, mode: r.mode, questionId: r.question_id, sessionId: r.session_id, at: r.answered_at })),
      policy,
      now,
    );
    const where = {
      student_id_curriculum_version_id_grade_id_subject_id_objective_path: {
        student_id: k.studentId,
        curriculum_version_id: k.curriculumVersionId,
        grade_id: k.gradeId,
        subject_id: k.subjectId,
        objective_path: k.path,
      },
    };
    const before: any = await tx.student_mastery_state.findUnique({ where });
    const data = {
      policy_version_id: policyId,
      alpha: s.alpha,
      beta: s.beta,
      mastery: s.mastery,
      confidence: s.confidence,
      effective_evidence: s.effectiveEvidence,
      evidence_count: s.evidenceCount,
      families: s.families,
      sessions: s.sessions,
      controlled_evidence: s.controlledEvidence,
      label: s.label,
      reportable: s.reportable,
      last_evidence_at: s.lastEvidenceAt,
    };
    await tx.student_mastery_state.upsert({
      where,
      create: { student_id: k.studentId, curriculum_version_id: k.curriculumVersionId, grade_id: k.gradeId, subject_id: k.subjectId, objective_path: k.path, ...data },
      update: data,
    });
    const same = before && before.label === s.label && before.mastery === s.mastery && before.confidence === s.confidence;
    if (same) return false;
    await tx.mastery_state_change.create({
      data: {
        run_id: runId,
        student_id: k.studentId,
        objective_path: k.path,
        subject_id: k.subjectId,
        before_label: before?.label ?? null,
        after_label: s.label,
        before_mastery: before?.mastery ?? null,
        after_mastery: s.mastery,
        before_confidence: before?.confidence ?? null,
        after_confidence: s.confidence,
      },
    });
    return true;
  }

  /** Difficulty and cognitive slices for one student and subject, from all valid evidence. */
  private async recomputeSlices(tx: Tx, studentId: string, subjectId: string, policy: MasteryPolicy): Promise<void> {
    const rows: any[] = await tx.mastery_evidence_event.findMany({
      where: { student_id: studentId, subject_id: subjectId, invalidated_at: null },
      select: { score: true, weight: true, difficulty: true, cognitive: true },
    });
    for (const d of ['EASY', 'MEDIUM', 'HARD'] as Difficulty[]) {
      const s = sliceState(rows.filter((r) => r.difficulty === d), policy);
      const data = { mastery: s.mastery, effective_evidence: s.effectiveEvidence, evidence_count: s.evidenceCount };
      await tx.student_difficulty_state.upsert({
        where: { student_id_subject_id_difficulty: { student_id: studentId, subject_id: subjectId, difficulty: d } },
        create: { student_id: studentId, subject_id: subjectId, difficulty: d, ...data },
        update: data,
      });
    }
    for (const c of ['C1', 'C2', 'C3', 'C4'] as Cognitive[]) {
      const s = sliceState(rows.filter((r) => r.cognitive === c), policy);
      const data = { mastery: s.mastery, effective_evidence: s.effectiveEvidence, evidence_count: s.evidenceCount };
      await tx.student_cognitive_state.upsert({
        where: { student_id_subject_id_cognitive: { student_id: studentId, subject_id: subjectId, cognitive: c } },
        create: { student_id: studentId, subject_id: subjectId, cognitive: c, ...data },
        update: data,
      });
    }
  }

  /** "chapter/topic/concept/objective" -> learning_objective.id in one curriculum revision. */
  private async objectiveIds(tx: Tx, subjectVersionId: string): Promise<Map<string, string>> {
    const chapters: any[] = await tx.chapter.findMany({
      where: { subject_version_id: subjectVersionId },
      select: { code: true, topics: { select: { code: true, micro_concepts: { select: { code: true, learning_objectives: { select: { id: true, code: true } } } } } } },
    });
    const out = new Map<string, string>();
    for (const c of chapters) for (const t of c.topics) for (const m of t.micro_concepts) for (const o of m.learning_objectives) out.set(`${c.code}/${t.code}/${m.code}/${o.code}`, o.id);
    return out;
  }
}
