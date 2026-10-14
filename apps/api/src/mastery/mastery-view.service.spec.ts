import { ForbiddenException, BadRequestException } from '@nestjs/common';
import { ExamNotPermittedError } from '../exam/exam.errors';
import { MASTERY_V1 } from './mastery-domain';
import { MasteryAdminController } from './mastery.controller';
import { MasteryViewService } from './mastery-view.service';

function build(states: any[] = [], roles: string[] = []) {
  const audits: any[] = [];
  const exam: any = {
    studentFor: jest.fn(async () => 'stu'),
    listUnits: jest.fn(async () => [{ subjectVersionId: 'sv', subjectCode: 'PHY', subjectName: 'Physics' }]),
  };
  const client: any = {
    $queryRaw: jest.fn(async () => [{ n: 1n }]),
    mastery_policy_version: { findFirst: jest.fn(async () => ({ code: 'MASTERY_V1', params: MASTERY_V1 })) },
    curriculum_subject_version: {
      findUnique: jest.fn(async () => ({
        curriculum_version_id: 'cv',
        grade_id: 'g',
        subject_id: 'sub',
        chapters: [
          { code: 'C1', title: 'Motion', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'O1', statement: 'Define speed' }, { code: 'O2', statement: 'Use v = d/t' }] }] }] },
          { code: 'C2', title: 'Force', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'O1', statement: 'Name forces' }] }] }] },
        ],
      })),
    },
    student_mastery_state: { findMany: jest.fn(async () => states) },
    student: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'stu' ? { id: 'stu' } : null)) },
    audit_event: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
    mastery_update_run: { findMany: jest.fn(async () => []) },
  };
  const authz: any = { curriculumRolesFor: jest.fn(async () => roles) };
  return { service: new MasteryViewService({ client } as any, exam, authz), audits };
}

const state = (path: string, label: string, over: any = {}) => ({ objective_path: path, label, reportable: !['NOT_STARTED', 'BUILDING_EVIDENCE'].includes(label), mastery: 0.8, effective_evidence: 6, evidence_count: 7, ...over });

describe('MasteryViewService.mine', () => {
  it('shows every objective of the subject, with labels only, chapter by chapter', async () => {
    const v = await build([state('C1/T1/M1/O1', 'SECURE'), state('C1/T1/M1/O2', 'SECURE', { mastery: 0.75 })]).service.mine('acct');
    expect(v).toMatchObject({ policy: 'MASTERY_V1', pending: 1 });
    const [s] = v.subjects;
    expect(s).toMatchObject({ subjectCode: 'PHY', objectives: 3, started: 2, reportable: 2 });
    expect(s.chapters[0]).toMatchObject({ code: 'C1', title: 'Motion', label: 'SECURE', objectives: 2 });
    expect(s.chapters[0].items[0]).toEqual({ path: 'C1/T1/M1/O1', code: 'O1', statement: 'Define speed', label: 'SECURE', answers: 7 });
    expect(s.chapters[1]).toMatchObject({ code: 'C2', label: 'NOT_STARTED', started: 0 });
    // No raw model numbers reach the student.
    expect(JSON.stringify(v)).not.toMatch(/confidence|alpha|mastery"?:\s*0\./);
  });

  it('an objective with no evidence is Not started, not zero', async () => {
    const v = await build([]).service.mine('acct');
    expect(v.subjects[0].chapters[0].items.every((i) => i.label === 'NOT_STARTED' && i.answers === 0)).toBe(true);
  });
});

describe('MasteryViewService.forStaff', () => {
  it('needs an academic staff role, and every view is audited', async () => {
    await expect(build([], []).service.forStaff('acct', 'stu')).rejects.toBeInstanceOf(ExamNotPermittedError);
    const b = build([state('C1/T1/M1/O1', 'SECURE', { confidence: 81 })], ['REVIEWER']);
    const v = await b.service.forStaff('acct', 'stu');
    expect(v.studentId).toBe('stu');
    expect(b.audits).toEqual([expect.objectContaining({ action: 'mastery.viewed_by_staff', subject_id: 'stu' })]);
  });

  it('the controller checks the id first and maps a refusal to 403', async () => {
    const c = new MasteryAdminController(build([], []).service);
    expect(() => c.student({ accountId: 'a' } as any, 'nope')).toThrow(BadRequestException);
    await expect(c.student({ accountId: 'a' } as any, '11111111-2222-4333-8444-555555555555')).rejects.toBeInstanceOf(ForbiddenException);
  });
});
