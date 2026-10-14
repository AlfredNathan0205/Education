import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExamService } from '../exam/exam.service';
import { FIRST_TEST_MESSAGE, nextBestAction, summarise, type HomeAttempt, type NextAction, type SubjectSummary } from './home-domain';

export interface HomeView {
  displayName: string | null;
  cohort: { curriculumCode: string; gradeCode: string } | null;
  /** True when the student's curriculum and grade have at least one subject served. */
  supported: boolean;
  nextAction: NextAction;
  /** No finished test yet: the first one builds the mastery profile. */
  firstExperience: boolean;
  firstExperienceMessage: string;
  subjects: SubjectSummary[];
  inProgress: HomeAttempt[];
}

/**
 * One call for the student's Home. Same gate as tests (profile, age, consent): a student who may not take tests gets
 * the same 403 and message. Leaderboards and challenges are not here yet (Steps 15 and 16).
 */
@Injectable()
export class HomeService {
  constructor(
    private readonly db: DatabaseService,
    private readonly exam: ExamService,
  ) {}

  async home(accountId: string): Promise<HomeView> {
    const studentId = await this.exam.studentFor(accountId);
    const db = this.db.client as any;
    const [student, ctx] = await Promise.all([
      db.student.findUnique({ where: { id: studentId }, select: { display_name: true } }),
      db.student_academic_context.findUnique({ where: { student_id: studentId } }),
    ]);
    const units = await this.exam.listUnits(accountId);
    const attempts = (await this.exam.listMine(accountId)) as HomeAttempt[];
    return {
      displayName: student?.display_name ?? null,
      cohort: ctx ? { curriculumCode: ctx.curriculum_code, gradeCode: ctx.grade_code } : null,
      supported: units.length > 0,
      nextAction: nextBestAction({ hasCohort: !!ctx, units, attempts }),
      firstExperience: !attempts.some((a) => a.status === 'SUBMITTED'),
      firstExperienceMessage: FIRST_TEST_MESSAGE,
      subjects: summarise(units, attempts),
      inProgress: attempts.filter((a) => a.status === 'IN_PROGRESS'),
    };
  }
}
