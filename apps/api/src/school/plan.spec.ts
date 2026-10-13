import type { DatabaseService } from '../database/database.service';
import type { OutboxService } from '../outbox/outbox.service';
import { GuardianConsentRequiredError, type StudentService } from '../student/student.service';
import { ChapterCatalogueService } from './chapter-catalogue.service';
import { normalizeAcademicYear, normalizePlanLabel, parseSelection } from './plan-domain';
import { ChapterNotFoundError, GradeNotSetError, PlanEmptyError, PlanNotEditableError } from './plan.errors';
import { InvalidSchoolInputError } from './school-domain';
import { SchoolPlanService } from './school-plan.service';
import { StudentChaptersService } from './student-chapters.service';
import { CliUsageError, runSchoolsCli } from './cli/schools-cli';

const CAT_ROWS = [
  { revision: 2, subject: { code: 'PHYSICS', name: 'Physics' }, chapters: [{ code: 'FORCE', title: 'Force' }, { code: 'ENERGY', title: 'Energy' }] },
  { revision: 1, subject: { code: 'PHYSICS', name: 'Physics' }, chapters: [{ code: 'OLD', title: 'Old' }] },
  { revision: 1, subject: { code: 'CHEM', name: 'Chemistry' }, chapters: [{ code: 'MATTER', title: 'Matter' }] },
];

function client() {
  const c: any = {
    curriculum_subject_version: { findMany: jest.fn().mockResolvedValue(CAT_ROWS) },
    school: { findFirst: jest.fn().mockResolvedValue({ id: 's1', name: 'Test School' }) },
    school_academic_plan: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    school_plan_entry: { findFirst: jest.fn().mockResolvedValue(null), count: jest.fn().mockResolvedValue(0), create: jest.fn(), deleteMany: jest.fn() },
    student_academic_context: { findUnique: jest.fn().mockResolvedValue({ curriculum_code: 'ICSE', grade_code: 'GRADE_8' }) },
    student_chapter_selection: { findMany: jest.fn().mockResolvedValue([]), deleteMany: jest.fn(), createMany: jest.fn() },
    student_school_association: { findFirst: jest.fn().mockResolvedValue(null) },
    audit_event: { create: jest.fn() },
  };
  c.$transaction = jest.fn((cb: any) => cb(c));
  return c;
}
const cfg = { allowUnactivatedCurriculum: false, resumeHours: 24 };

function operatorSide() {
  const c = client();
  const catalogue = new ChapterCatalogueService({ client: c } as unknown as DatabaseService, cfg);
  return { c, service: new SchoolPlanService({ client: c } as unknown as DatabaseService, catalogue) };
}

describe('plan-domain', () => {
  it('accepts consecutive academic years only', () => {
    expect(normalizeAcademicYear('2026-27')).toBe('2026-27');
    expect(normalizeAcademicYear('2099-00')).toBe('2099-00');
    for (const bad of ['2026', '2026-28', '26-27', '2026/27', 5, undefined]) expect(() => normalizeAcademicYear(bad)).toThrow(InvalidSchoolInputError);
  });
  it('keeps the school wording, trims, and refuses markup', () => {
    expect(normalizePlanLabel('  Term   1 ', 'Term', 40, true)).toBe('Term 1');
    expect(normalizePlanLabel(undefined, 'Assessment', 60, false)).toBe('');
    expect(() => normalizePlanLabel('<b>x</b>', 'Term', 40, true)).toThrow(InvalidSchoolInputError);
    expect(() => normalizePlanLabel('', 'Term', 40, true)).toThrow(InvalidSchoolInputError);
    expect(() => normalizePlanLabel('x'.repeat(41), 'Term', 40, true)).toThrow(InvalidSchoolInputError);
  });
  it('parses and deduplicates a selection, bounded', () => {
    expect(parseSelection([{ subjectCode: 'PHYSICS', chapterCode: 'FORCE' }, { subjectCode: 'PHYSICS', chapterCode: 'FORCE' }])).toHaveLength(1);
    expect(() => parseSelection('x')).toThrow(InvalidSchoolInputError);
    expect(() => parseSelection([{ subjectCode: 'a b', chapterCode: 'x' }])).toThrow(InvalidSchoolInputError);
    expect(() => parseSelection(Array.from({ length: 201 }, (_, i) => ({ subjectCode: 'P', chapterCode: `C${i}` })))).toThrow(InvalidSchoolInputError);
  });
});

describe('ChapterCatalogueService', () => {
  it('uses the newest version of each subject and only ACTIVE unless the dev switch is on', async () => {
    const c = client();
    const prod = new ChapterCatalogueService({ client: c } as unknown as DatabaseService, cfg);
    const out = await prod.forCohort('ICSE', 'GRADE_8');
    expect(out.map((s) => s.subjectCode)).toEqual(['CHEM', 'PHYSICS']);
    expect(out[1].chapters.map((x) => x.code)).toEqual(['FORCE', 'ENERGY']);
    expect(c.curriculum_subject_version.findMany.mock.calls[0][0].where.state.in).toEqual(['ACTIVE']);
    const dev = new ChapterCatalogueService({ client: c } as unknown as DatabaseService, { ...cfg, allowUnactivatedCurriculum: true });
    await dev.forCohort('ICSE', 'GRADE_8');
    expect(c.curriculum_subject_version.findMany.mock.calls[1][0].where.state.in).toContain('APPROVED');
  });
});

describe('SchoolPlanService', () => {
  it('refuses a cohort that is not launched and an unknown school', async () => {
    const { c, service } = operatorSide();
    await expect(service.createPlan({ schoolId: 's1', curriculumCode: 'CBSE', gradeCode: 'GRADE_8', academicYear: '2026-27', operator: 'op' })).rejects.toThrow();
    c.school.findFirst.mockResolvedValue(null);
    await expect(service.createPlan({ schoolId: 'x', curriculumCode: 'ICSE', gradeCode: 'GRADE_8', academicYear: '2026-27', operator: 'op' })).rejects.toThrow();
  });
  it('creates a draft once, audited with the operator', async () => {
    const { c, service } = operatorSide();
    c.school_academic_plan.findFirst.mockResolvedValue(null);
    c.school_academic_plan.create.mockResolvedValue({ id: 'p1' });
    expect(await service.createPlan({ schoolId: 's1', curriculumCode: 'ICSE', gradeCode: 'GRADE_8', academicYear: '2026-27', operator: 'op' })).toEqual({ id: 'p1', created: true });
    expect(c.audit_event.create.mock.calls[0][0].data.metadata.operator).toBe('op');
    c.school_academic_plan.findFirst.mockResolvedValue({ id: 'p1' });
    expect((await service.createPlan({ schoolId: 's1', curriculumCode: 'ICSE', gradeCode: 'GRADE_8', academicYear: '2026-27', operator: 'op' })).created).toBe(false);
  });
  it('only accepts chapters that exist in the curriculum', async () => {
    const { c, service } = operatorSide();
    c.school_academic_plan.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT', curriculum_code: 'ICSE', grade_code: 'GRADE_8' });
    await expect(service.addEntry({ planId: 'p1', termLabel: 'Term 1', subjectCode: 'PHYSICS', chapterCode: 'OLD', operator: 'op' })).rejects.toBeInstanceOf(ChapterNotFoundError);
    expect(c.school_plan_entry.create).not.toHaveBeenCalled();
    expect(await service.addEntry({ planId: 'p1', termLabel: 'Term 1', assessmentLabel: 'Unit Test 1', subjectCode: 'PHYSICS', chapterCode: 'FORCE', operator: 'op' })).toEqual({ added: true });
    expect(c.school_plan_entry.create.mock.calls[0][0].data).toMatchObject({ term_label: 'Term 1', assessment_label: 'Unit Test 1', chapter_code: 'FORCE' });
  });
  it('is idempotent for a repeated entry', async () => {
    const { c, service } = operatorSide();
    c.school_academic_plan.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT', curriculum_code: 'ICSE', grade_code: 'GRADE_8' });
    c.school_plan_entry.findFirst.mockResolvedValue({ id: 'e' });
    expect(await service.addEntry({ planId: 'p1', termLabel: 'Term 1', subjectCode: 'PHYSICS', chapterCode: 'FORCE', operator: 'op' })).toEqual({ added: false });
    expect(c.school_plan_entry.create).not.toHaveBeenCalled();
  });
  it('a published plan cannot be edited until reopened', async () => {
    const { c, service } = operatorSide();
    c.school_academic_plan.findFirst.mockResolvedValue({ id: 'p1', status: 'PUBLISHED', curriculum_code: 'ICSE', grade_code: 'GRADE_8' });
    await expect(service.addEntry({ planId: 'p1', termLabel: 'T', subjectCode: 'PHYSICS', chapterCode: 'FORCE', operator: 'op' })).rejects.toBeInstanceOf(PlanNotEditableError);
    await expect(service.removeEntry({ planId: 'p1', termLabel: 'T', subjectCode: 'PHYSICS', chapterCode: 'FORCE', operator: 'op' })).rejects.toBeInstanceOf(PlanNotEditableError);
    expect(await service.reopen({ planId: 'p1', operator: 'op' })).toEqual({ reopened: true });
    expect(c.school_academic_plan.update.mock.calls[0][0].data.status).toBe('DRAFT');
  });
  it('refuses to publish an empty plan', async () => {
    const { c, service } = operatorSide();
    c.school_academic_plan.findFirst.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
    await expect(service.publish({ planId: 'p1', operator: 'op' })).rejects.toBeInstanceOf(PlanEmptyError);
    c.school_plan_entry.count.mockResolvedValue(3);
    expect(await service.publish({ planId: 'p1', operator: 'op' })).toEqual({ published: true });
    expect(c.school_academic_plan.update.mock.calls[0][0].data.status).toBe('PUBLISHED');
  });
});

function studentSide() {
  const c = client();
  const students = { studentIdForDataCollection: jest.fn().mockResolvedValue('st1') };
  const outbox = { publish: jest.fn() };
  const catalogue = new ChapterCatalogueService({ client: c } as unknown as DatabaseService, cfg);
  const service = new StudentChaptersService({ client: c } as unknown as DatabaseService, students as unknown as StudentService, catalogue, outbox as unknown as OutboxService);
  return { c, students, outbox, service };
}

describe('StudentChaptersService', () => {
  it('is refused while guardian consent is required, reading or writing', async () => {
    const { c, students, service } = studentSide();
    students.studentIdForDataCollection.mockRejectedValue(new GuardianConsentRequiredError());
    await expect(service.view('a')).rejects.toBeInstanceOf(GuardianConsentRequiredError);
    await expect(service.setSelection('a', [])).rejects.toBeInstanceOf(GuardianConsentRequiredError);
    expect(c.student_chapter_selection.deleteMany).not.toHaveBeenCalled();
  });
  it('needs a grade first', async () => {
    const { c, service } = studentSide();
    c.student_academic_context.findUnique.mockResolvedValue(null);
    await expect(service.view('a')).rejects.toBeInstanceOf(GradeNotSetError);
  });
  it('rejects a chapter that is not in the student cohort and changes nothing', async () => {
    const { c, service } = studentSide();
    await expect(service.setSelection('a', [{ subjectCode: 'PHYSICS', chapterCode: 'OLD' }])).rejects.toBeInstanceOf(ChapterNotFoundError);
    expect(c.student_chapter_selection.deleteMany).not.toHaveBeenCalled();
  });
  it('replaces the selection with an event and audit row', async () => {
    const { c, outbox, service } = studentSide();
    c.student_chapter_selection.findMany.mockResolvedValue([{ subject_code: 'PHYSICS', chapter_code: 'FORCE' }]);
    const v = await service.setSelection('a', [{ subjectCode: 'PHYSICS', chapterCode: 'FORCE' }]);
    expect(c.student_chapter_selection.createMany.mock.calls[0][0].data).toEqual([{ student_id: 'st1', subject_code: 'PHYSICS', chapter_code: 'FORCE' }]);
    expect(outbox.publish.mock.calls[0][1]).toMatchObject({ eventType: 'student.chapter_selection.set.v1' });
    expect(c.audit_event.create).toHaveBeenCalledTimes(1);
    expect(v.subjects.find((s) => s.subjectCode === 'PHYSICS')!.chapters.find((x) => x.code === 'FORCE')!.selected).toBe(true);
  });
  it('shows a published school plan only as a suggestion and never selects from it', async () => {
    const { c, service } = studentSide();
    c.student_school_association.findFirst.mockResolvedValue({ school_id: 's1', school: { name: 'Test School' } });
    c.school_academic_plan.findFirst.mockResolvedValue({
      academic_year: '2026-27',
      entries: [{ term_label: 'Term 1', assessment_label: '', subject_code: 'PHYSICS', chapter_code: 'ENERGY' }],
    });
    const v = await service.view('a');
    expect(v.schoolPlan?.groups[0]).toMatchObject({ termLabel: 'Term 1' });
    const e = v.subjects.find((s) => s.subjectCode === 'PHYSICS')!.chapters.find((x) => x.code === 'ENERGY')!;
    expect(e).toMatchObject({ suggested: true, selected: false });
    expect(c.school_academic_plan.findFirst.mock.calls[0][0].where.status).toBe('PUBLISHED');
  });
  it('offers no plan to a student whose school is only a free-text candidate', async () => {
    const { c, service } = studentSide();
    c.student_school_association.findFirst.mockResolvedValue({ school_id: null, school: null });
    expect((await service.view('a')).schoolPlan).toBeNull();
    expect(c.school_academic_plan.findFirst).not.toHaveBeenCalled();
  });
});

describe('schools plan CLI', () => {
  const plans: any = {
    createPlan: jest.fn().mockResolvedValue({ id: 'p1', created: true }),
    addEntry: jest.fn().mockResolvedValue({ added: true }),
    removeEntry: jest.fn(), publish: jest.fn().mockResolvedValue({ published: true }), reopen: jest.fn(),
    show: jest.fn().mockResolvedValue({ schoolName: 'S', curriculumCode: 'ICSE', gradeCode: 'GRADE_8', academicYear: '2026-27', status: 'DRAFT', entries: [] }),
    list: jest.fn().mockResolvedValue([]), chapters: jest.fn().mockResolvedValue([]),
  };
  const deps: any = { registry: {}, plans, operator: 'op' };
  it('maps "-" to no assessment and passes the operator', async () => {
    await runSchoolsCli(['plan', 'add', 'p1', 'Term 1', '-', 'PHYSICS', 'FORCE'], deps);
    expect(plans.addEntry).toHaveBeenCalledWith({ planId: 'p1', termLabel: 'Term 1', assessmentLabel: '', subjectCode: 'PHYSICS', chapterCode: 'FORCE', operator: 'op' });
  });
  it('rejects wrong argument counts and unknown subcommands', async () => {
    await expect(runSchoolsCli(['plan', 'add', 'p1'], deps)).rejects.toBeInstanceOf(CliUsageError);
    await expect(runSchoolsCli(['plan', 'nope'], deps)).rejects.toBeInstanceOf(CliUsageError);
    await expect(runSchoolsCli(['plan', 'publish', 'p1'], { ...deps, operator: '' })).rejects.toBeInstanceOf(CliUsageError);
  });
  it('prints an empty plan', async () => {
    expect(await runSchoolsCli(['plan', 'show', 'p1'], deps)).toContain('(no chapters yet)');
  });
});
