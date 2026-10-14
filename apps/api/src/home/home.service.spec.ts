import { ExamNotPermittedError } from '../exam/exam.errors';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { ForbiddenException } from '@nestjs/common';

function build(over: { ctx?: any; units?: any[]; mine?: any[] } = {}) {
  const exam: any = {
    studentFor: jest.fn(async () => 'stu-1'),
    listUnits: jest.fn(async () => over.units ?? [{ subjectVersionId: 'sv', subjectCode: 'PHY', subjectName: 'Physics', ready: true, chosenChapters: 0, tests: [{ code: 'QUICK10', name: 'Quick 10', total: 10, ready: true }] }]),
    listMine: jest.fn(async () => over.mine ?? []),
  };
  const client: any = {
    student: { findUnique: jest.fn(async () => ({ display_name: 'Asha' })) },
    student_academic_context: { findUnique: jest.fn(async () => (over.ctx === undefined ? { curriculum_code: 'ICSE', grade_code: 'GRADE_8' } : over.ctx)) },
  };
  return { exam, service: new HomeService({ client } as any, exam) };
}

describe('HomeService', () => {
  it('puts the next best action, subjects and open tests together', async () => {
    const h = await build().service.home('acct');
    expect(h).toMatchObject({
      displayName: 'Asha',
      cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' },
      supported: true,
      firstExperience: true,
      firstExperienceMessage: 'Building your mastery profile',
      nextAction: { kind: 'FIRST_TEST', subjectName: 'Physics', blueprint: 'QUICK10' },
      inProgress: [],
    });
    expect(h.subjects[0]).toMatchObject({ subjectCode: 'PHY', lastResult: null, completed: 0 });
  });

  it('a student with no grade yet is sent to finish the profile', async () => {
    const h = await build({ ctx: null, units: [] }).service.home('acct');
    expect(h).toMatchObject({ cohort: null, supported: false, nextAction: { kind: 'FINISH_PROFILE' } });
  });

  it('the same gate as tests: refused with the same message', async () => {
    const b = build();
    b.exam.studentFor.mockRejectedValueOnce(new ExamNotPermittedError('A parent or guardian must give consent before you can take a test'));
    const controller = new HomeController(b.service);
    await expect(controller.home({ accountId: 'acct' } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});
