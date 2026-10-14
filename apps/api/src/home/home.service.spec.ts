import { ExamNotPermittedError } from '../exam/exam.errors';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';
import { ForbiddenException } from '@nestjs/common';

function build(over: { ctx?: any; units?: any[]; mine?: any[]; focus?: any[] } = {}) {
  const exam: any = {
    studentFor: jest.fn(async () => 'stu-1'),
    listUnits: jest.fn(async () => over.units ?? [{ subjectVersionId: 'sv', subjectCode: 'PHY', subjectName: 'Physics', ready: true, chosenChapters: 0, tests: [{ code: 'QUICK10', name: 'Quick 10', total: 10, ready: true }] }]),
    listMine: jest.fn(async () => over.mine ?? []),
  };
  const client: any = {
    student: { findUnique: jest.fn(async () => ({ display_name: 'Asha' })) },
    student_academic_context: { findUnique: jest.fn(async () => (over.ctx === undefined ? { curriculum_code: 'ICSE', grade_code: 'GRADE_8' } : over.ctx)) },
  };
  const recs: any = { forStudent: jest.fn(async () => over.focus ?? []) };
  return { exam, recs, service: new HomeService({ client } as any, exam, recs) };
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
      focus: [],
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

  it('a retest after practice comes before practice and before another test', async () => {
    const done = [{ assessmentId: 'a1', mode: 'TEST', status: 'SUBMITTED', subjectCode: 'PHY', subjectName: 'Physics', blueprint: 'QUICK10', startedAt: '2026-10-01T00:00:00Z', submittedAt: '2026-10-01T00:10:00Z', correct: 4, total: 10 }];
    const focus = [
      { id: 'p1', kind: 'PRACTICE', subjectName: 'Physics', objectives: [{}, {}], createdAt: '2026-10-02T00:00:00Z' },
      { id: 'r1', kind: 'RETEST', subjectName: 'Physics', objectives: [{}], createdAt: '2026-10-03T00:00:00Z' },
    ];
    const b = build({ mine: done, focus });
    const h = await b.service.home('acct');
    expect(b.recs.forStudent).toHaveBeenCalledWith('stu-1', expect.any(Array));
    expect(h.focus).toHaveLength(2);
    expect(h.nextAction).toEqual({ kind: 'RETEST', recommendationId: 'r1', subjectName: 'Physics', objectives: 1, reason: 'You practised one objective in Physics. A short retest shows what has stuck.' });
    const only = await build({ mine: done, focus: [focus[0]] }).service.home('acct');
    expect(only.nextAction).toMatchObject({ kind: 'PRACTICE', recommendationId: 'p1', objectives: 2, reason: 'Practise 2 objectives in Physics, chosen from your recent answers.' });
  });
});
