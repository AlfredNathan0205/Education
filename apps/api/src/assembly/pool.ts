import type { Prisma } from '@exam-app/database';
import type { Candidate } from './assembly-engine';

type Tx = Prisma.TransactionClient;

export interface UnitRef {
  id: string;
  curriculum_version_id: string;
  grade_id: string;
  subject_id: string;
}

export interface PoolText {
  code: string;
  stem: string;
}

export interface ServablePool {
  items: Candidate[];
  /** Served questions whose objective is no longer in this curriculum revision; never used. */
  excluded: number;
  /** Only when asked for (previews): the question code and wording by revision id. */
  text: Map<string, PoolText>;
}

/**
 * Every question that may be served for a unit (Step 9 rule: APPROVED and PUBLISHED and not DEGRADED, on an objective
 * that exists in this curriculum revision), with what assembly ranks on. `studentId` null = a preview, no exposure.
 * Sorted by revision id so an assembly does not depend on the order the database returns rows in.
 */
export async function loadServablePool(db: Tx, unit: UnitRef, studentId: string | null, withText = false): Promise<ServablePool> {
  const chapters = await db.chapter.findMany({
    where: { subject_version_id: unit.id },
    select: { code: true, topics: { select: { code: true, micro_concepts: { select: { code: true, learning_objectives: { select: { code: true } } } } } } },
  });
  const paths = new Set<string>();
  for (const c of chapters) for (const t of c.topics) for (const m of t.micro_concepts) for (const o of m.learning_objectives) paths.add(`${c.code}/${t.code}/${m.code}/${o.code}`);

  const revs: any[] = await db.question_revision.findMany({
    where: {
      state: 'APPROVED',
      // Approved is not published: only a version a person has published is served, and not one marked DEGRADED.
      publication: { is: { state: 'PUBLISHED' } },
      question: {
        curriculum_version_id: unit.curriculum_version_id,
        grade_id: unit.grade_id,
        subject_id: unit.subject_id,
        NOT: { bank_state: { is: { health: 'DEGRADED' } } },
      },
    },
    select: {
      id: true,
      difficulty: true,
      cognitive: true,
      question_type: true,
      stem_hash: true,
      stem: withText,
      question: { select: { id: true, code: true, objective_path: true, bank_state: { select: { health: true } } } },
    },
  });
  const usable = revs.filter((r) => paths.has(r.question.objective_path)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const seen = new Map<string, Date>();
  if (studentId !== null && usable.length) {
    const exposures = await db.student_question_exposure.findMany({
      where: { student_id: studentId, question_id: { in: usable.map((r) => r.question.id) } },
      select: { question_id: true, last_seen_at: true },
    });
    for (const e of exposures) seen.set(e.question_id, e.last_seen_at);
  }
  const text = new Map<string, PoolText>();
  if (withText) for (const r of usable) text.set(r.id, { code: r.question.code, stem: r.stem });
  return {
    items: usable.map((r) => ({
      revisionId: r.id,
      questionId: r.question.id,
      objectivePath: r.question.objective_path,
      difficulty: r.difficulty,
      stemHash: r.stem_hash,
      lastSeenAt: seen.get(r.question.id) ?? null,
      cognitive: r.cognitive ?? null,
      questionType: r.question_type ?? 'MCQ',
      health: r.question.bank_state?.health ?? null,
    })),
    excluded: revs.length - usable.length,
    text,
  };
}
