import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { computeCoverage, type CoverageItem, type CoverageReport, type ItemState, type ObjectiveInfo } from './coverage-domain';

export class CoverageUnitNotFoundError extends Error {
  constructor() {
    super('No curriculum found for that curriculum, grade and subject');
    this.name = 'CoverageUnitNotFoundError';
  }
}

/**
 * Read-only coverage report for one curriculum, grade and subject. Uses the newest curriculum subject version
 * (whatever its state: coverage is an operator tool, and the bank is built before activation). Only
 * aggregate counts of student exposure are read; no student is identifiable in the result.
 */
@Injectable()
export class CoverageService {
  constructor(private readonly db: DatabaseService) {}

  async report(input: { curriculumCode: string; gradeCode: string; subjectCode: string; targetPerCell: number }): Promise<CoverageReport> {
    const db = this.db.client as any;
    const unit = await db.curriculum_subject_version.findFirst({
      where: {
        grade: { code: input.gradeCode },
        subject: { code: input.subjectCode },
        curriculum_version: { curriculum: { code: input.curriculumCode } },
      },
      orderBy: { revision: 'desc' },
      include: {
        chapters: {
          orderBy: { position: 'asc' },
          include: { topics: { include: { micro_concepts: { include: { learning_objectives: true } } } } },
        },
      },
    });
    if (!unit) throw new CoverageUnitNotFoundError();

    const objectives: ObjectiveInfo[] = [];
    for (const c of unit.chapters) for (const t of c.topics) for (const m of t.micro_concepts) for (const o of m.learning_objectives) {
      objectives.push({ path: `${c.code}/${t.code}/${m.code}/${o.code}`, statement: o.statement });
    }

    const revs = await db.question_revision.findMany({
      where: {
        state: { not: 'SUPERSEDED' },
        question: { curriculum_version_id: unit.curriculum_version_id, grade_id: unit.grade_id, subject_id: unit.subject_id },
      },
      select: { state: true, difficulty: true, question: { select: { id: true, objective_path: true } } },
    });
    const ids = [...new Set((revs as any[]).map((r) => r.question.id as string))];
    const seen = ids.length
      ? await db.student_question_exposure.groupBy({ by: ['question_id'], where: { question_id: { in: ids } }, _sum: { times_seen: true } })
      : [];
    const served = ids.length
      ? await db.assessment_instance_question.groupBy({ by: ['question_id'], where: { question_id: { in: ids } }, _count: { _all: true } })
      : [];
    const seenBy = new Map<string, number>((seen as any[]).map((s) => [s.question_id, s._sum.times_seen ?? 0]));
    const servedBy = new Map<string, number>((served as any[]).map((s) => [s.question_id, s._count._all]));

    const items: CoverageItem[] = (revs as any[]).map((r) => ({
      questionId: r.question.id,
      objectivePath: r.question.objective_path,
      difficulty: r.difficulty,
      state: r.state as ItemState,
      timesSeen: seenBy.get(r.question.id) ?? 0,
      timesServed: servedBy.get(r.question.id) ?? 0,
    }));
    return computeCoverage({ objectives, items, targetPerCell: input.targetPerCell });
  }
}
