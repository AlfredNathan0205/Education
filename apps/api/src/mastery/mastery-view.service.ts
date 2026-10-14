import { Injectable } from '@nestjs/common';
import { pickRole } from '../authz/roles';
import { AuthzService } from '../authz/authz.service';
import type { CurriculumRole } from '../curriculum/curriculum-state';
import { DatabaseService } from '../database/database.service';
import { ExamService } from '../exam/exam.service';
import { ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { MASTERY_V1, parsePolicy, rollup, type Label, type MasteryPolicy } from './mastery-domain';

export interface MasteryObjectiveView {
  path: string;
  code: string;
  statement: string;
  label: Label;
  /** How many answers count towards it (not a score). */
  answers: number;
}

export interface MasteryChapterView {
  code: string;
  title: string;
  label: Label;
  objectives: number;
  started: number;
  /** Objectives with enough evidence to say anything about. */
  reportable: number;
  items: MasteryObjectiveView[];
}

export interface MasterySubjectView {
  subjectVersionId: string;
  subjectCode: string;
  subjectName: string;
  objectives: number;
  started: number;
  reportable: number;
  chapters: MasteryChapterView[];
}

export interface MasteryView {
  policy: string;
  /** Changes waiting to be counted (a test finished in the last moments). */
  pending: number;
  subjects: MasterySubjectView[];
}

const STAFF_ROLES: readonly CurriculumRole[] = ['REVIEWER', 'APPROVER', 'SUPER_ADMIN'];

/**
 * What a student sees about their own learning: labels only (spec: the gate decides what may be said; raw model
 * confidence is not shown), objective by objective and chapter by chapter, for the subjects of their own cohort.
 * Staff can see the numbers behind a student's states for academic support; every such view is audited.
 */
@Injectable()
export class MasteryViewService {
  constructor(
    private readonly db: DatabaseService,
    private readonly exam: ExamService,
    private readonly authz: AuthzService,
  ) {}

  async mine(accountId: string): Promise<MasteryView> {
    const studentId = await this.exam.studentFor(accountId);
    const units = await this.exam.listUnits(accountId);
    const db = this.db.client as any;
    const policyRow = await db.mastery_policy_version.findFirst({ where: { status: 'ACTIVE' } });
    const policy: MasteryPolicy = policyRow ? parsePolicy(policyRow.params) : MASTERY_V1;
    const subjects: MasterySubjectView[] = [];
    for (const u of units) {
      const sv = await db.curriculum_subject_version.findUnique({
        where: { id: u.subjectVersionId },
        select: {
          curriculum_version_id: true,
          grade_id: true,
          subject_id: true,
          chapters: {
            orderBy: { position: 'asc' },
            select: {
              code: true,
              title: true,
              topics: {
                orderBy: { position: 'asc' },
                select: {
                  code: true,
                  micro_concepts: {
                    orderBy: { position: 'asc' },
                    select: { code: true, learning_objectives: { orderBy: { position: 'asc' }, select: { code: true, statement: true } } },
                  },
                },
              },
            },
          },
        },
      });
      if (!sv) continue;
      const states: any[] = await db.student_mastery_state.findMany({
        where: { student_id: studentId, curriculum_version_id: sv.curriculum_version_id, grade_id: sv.grade_id, subject_id: sv.subject_id },
      });
      const byPath = new Map(states.map((s) => [s.objective_path, s]));
      const chapters: MasteryChapterView[] = sv.chapters.map((c: any) => {
        const items: MasteryObjectiveView[] = [];
        const roll: Array<{ label: Label; reportable: boolean; mastery: number; effectiveEvidence: number }> = [];
        for (const t of c.topics)
          for (const m of t.micro_concepts)
            for (const o of m.learning_objectives) {
              const path = `${c.code}/${t.code}/${m.code}/${o.code}`;
              const s = byPath.get(path);
              const label: Label = s?.label ?? 'NOT_STARTED';
              items.push({ path, code: o.code, statement: o.statement, label, answers: s?.evidence_count ?? 0 });
              roll.push({ label, reportable: !!s?.reportable, mastery: s?.mastery ?? 0.5, effectiveEvidence: s?.effective_evidence ?? 0 });
            }
        const r = rollup(roll, policy);
        return { code: c.code, title: c.title, label: r.label, objectives: r.total, started: r.started, reportable: r.reportable, items };
      });
      subjects.push({
        subjectVersionId: u.subjectVersionId,
        subjectCode: u.subjectCode,
        subjectName: u.subjectName,
        objectives: chapters.reduce((a, c) => a + c.objectives, 0),
        started: chapters.reduce((a, c) => a + c.started, 0),
        reportable: chapters.reduce((a, c) => a + c.reportable, 0),
        chapters,
      });
    }
    const waiting: Array<{ n: bigint | number }> = await db.$queryRaw`
      SELECT COUNT(*) AS n
      FROM assessment_session s
      JOIN assessment_result r ON r.session_id = s.id
      WHERE s.student_id = ${studentId}::uuid
        AND s.status IN ('SUBMITTED', 'INVALIDATED')
        AND NOT EXISTS (
          SELECT 1 FROM mastery_update_run m
          WHERE m.session_id = s.id
            AND m.result_revision = CASE WHEN s.status = 'INVALIDATED' THEN -1 ELSE r.correction_count END
        )`;
    return { policy: policyRow?.code ?? 'MASTERY_V1', pending: Number(waiting[0]?.n ?? 0), subjects };
  }

  /** The numbers behind one student's mastery, for academic staff. Audited. */
  async forStaff(accountId: string, studentId: string): Promise<{ studentId: string; states: any[]; recentRuns: any[] }> {
    if (!pickRole(await this.authz.curriculumRolesFor(accountId), STAFF_ROLES)) throw new ExamNotPermittedError('only academic staff may see the numbers behind a student\'s mastery');
    const db = this.db.client as any;
    const student = await db.student.findUnique({ where: { id: studentId }, select: { id: true } });
    if (!student) throw new ExamNotFoundError('Student not found');
    await db.audit_event.create({ data: { actor_account_id: accountId, action: 'mastery.viewed_by_staff', subject_type: 'student', subject_id: studentId, metadata: {} } });
    const states = await db.student_mastery_state.findMany({ where: { student_id: studentId }, orderBy: [{ subject_id: 'asc' }, { objective_path: 'asc' }] });
    const recentRuns = await db.mastery_update_run.findMany({ where: { student_id: studentId }, orderBy: { created_at: 'desc' }, take: 20, include: { changes: true } });
    return { studentId, states, recentRuns };
  }
}
