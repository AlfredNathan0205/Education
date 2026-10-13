import { Inject, Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { EXAM_CONFIG, type ExamConfig } from '../exam/exam-domain';

export interface CatalogueSubject {
  subjectCode: string;
  subjectName: string;
  chapters: Array<{ code: string; title: string }>;
}

const SERVED = ['ACTIVE'];
const DEV = ['DRAFT', 'AI_STRUCTURED', 'VALIDATION_PENDING', 'VALIDATED', 'ADMIN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'ACTIVE', 'ACTIVE_WITH_REVIEW'];

/**
 * Canonical chapters for a curriculum and grade, read from the newest curriculum subject version of each
 * subject that the exam engine would serve (same rule, including the development switch).
 */
@Injectable()
export class ChapterCatalogueService {
  constructor(
    private readonly db: DatabaseService,
    @Inject(EXAM_CONFIG) private readonly config: ExamConfig,
  ) {}

  async forCohort(curriculumCode: string, gradeCode: string): Promise<CatalogueSubject[]> {
    const states = (this.config.allowUnactivatedCurriculum ? DEV : SERVED) as any[];
    const rows = await (this.db.client as any).curriculum_subject_version.findMany({
      where: {
        state: { in: states },
        grade: { code: gradeCode },
        curriculum_version: { curriculum: { code: curriculumCode } },
      },
      orderBy: { revision: 'desc' },
      include: { subject: true, chapters: { orderBy: { position: 'asc' } } },
    });
    const seen = new Set<string>();
    const out: CatalogueSubject[] = [];
    for (const r of rows as any[]) {
      if (seen.has(r.subject.code)) continue;
      seen.add(r.subject.code);
      out.push({
        subjectCode: r.subject.code,
        subjectName: r.subject.name,
        chapters: r.chapters.map((c: any) => ({ code: c.code, title: c.title })),
      });
    }
    return out.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  }

  async has(curriculumCode: string, gradeCode: string, subjectCode: string, chapterCode: string): Promise<boolean> {
    const all = await this.forCohort(curriculumCode, gradeCode);
    return all.some((s) => s.subjectCode === subjectCode && s.chapters.some((c) => c.code === chapterCode));
  }
}
