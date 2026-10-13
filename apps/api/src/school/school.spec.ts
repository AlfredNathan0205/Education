import { BadRequestException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import type { OutboxService } from '../outbox/outbox.service';
import { GuardianConsentRequiredError, StudentNotFoundError, type StudentService } from '../student/student.service';
import { CandidateNotPendingError, NotInLaunchCohortError, SchoolNotFoundError } from './school.errors';
import { SchoolRegistryService } from './school-registry.service';
import { InvalidSchoolInputError } from './school-domain';
import { parseSchoolChoice } from './student-school.controller';
import { StudentSchoolService } from './student-school.service';
import { CliUsageError, runSchoolsCli } from './cli/schools-cli';

function fakeClient() {
  const client: any = {
    school: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
    school_alias: { findFirst: jest.fn(), create: jest.fn() },
    school_branch: { findFirst: jest.fn(), create: jest.fn() },
    school_candidate: { findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), update: jest.fn() },
    student_school_association: { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    student_academic_context: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn() },
    audit_event: { create: jest.fn() },
  };
  client.$transaction = jest.fn((cb: any) => cb(client));
  return client;
}

function studentSide() {
  const client = fakeClient();
  const students = {
    ownStudentId: jest.fn().mockResolvedValue('st1'),
    studentIdForDataCollection: jest.fn().mockResolvedValue('st1'),
  };
  const outbox = { publish: jest.fn() };
  const service = new StudentSchoolService(
    { client } as unknown as DatabaseService,
    students as unknown as StudentService,
    outbox as unknown as OutboxService,
  );
  return { client, students, outbox, service };
}

describe('StudentSchoolService.setGrade', () => {
  it('refuses a cohort that is not launched, before touching anything', async () => {
    const { client, students, service } = studentSide();
    await expect(service.setGrade('a', 'CBSE', 'GRADE_8')).rejects.toBeInstanceOf(NotInLaunchCohortError);
    await expect(service.setGrade('a', 'ICSE', 'GRADE_9')).rejects.toBeInstanceOf(NotInLaunchCohortError);
    expect(students.studentIdForDataCollection).not.toHaveBeenCalled();
    expect(client.student_academic_context.upsert).not.toHaveBeenCalled();
  });

  it('is refused while guardian consent is required, and stores nothing', async () => {
    const { client, students, service } = studentSide();
    students.studentIdForDataCollection.mockRejectedValue(new GuardianConsentRequiredError());
    await expect(service.setGrade('a', 'ICSE', 'GRADE_8')).rejects.toBeInstanceOf(GuardianConsentRequiredError);
    expect(client.student_academic_context.upsert).not.toHaveBeenCalled();
    expect(client.audit_event.create).not.toHaveBeenCalled();
  });

  it('stores the launch grade with an event and audit row', async () => {
    const { client, outbox, service } = studentSide();
    client.student_academic_context.upsert.mockResolvedValue({ curriculum_code: 'ICSE', grade_code: 'GRADE_8' });
    client.student_academic_context.findUnique.mockResolvedValue({ curriculum_code: 'ICSE', grade_code: 'GRADE_8' });
    const out = await service.setGrade('a', 'ICSE', 'GRADE_8');
    expect(out.grade).toEqual({ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', label: 'ICSE · Grade 8' });
    expect(outbox.publish.mock.calls[0][1]).toMatchObject({ eventType: 'student.academic_context.set.v1' });
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });
});

describe('StudentSchoolService.selectSchool', () => {
  it('is refused while guardian consent is required', async () => {
    const { client, students, service } = studentSide();
    students.studentIdForDataCollection.mockRejectedValue(new GuardianConsentRequiredError());
    await expect(service.selectSchool('a', { schoolId: 's1' })).rejects.toBeInstanceOf(GuardianConsentRequiredError);
    expect(client.student_school_association.create).not.toHaveBeenCalled();
  });

  it('a registry school gives STUDENT_SELECTED and never anything stronger', async () => {
    const { client, service } = studentSide();
    client.school.findFirst.mockResolvedValue({ id: 's1', name: 'Test School' });
    client.student_school_association.create.mockResolvedValue({ id: 'as1' });
    await service.selectSchool('a', { schoolId: 's1' });
    expect(client.student_school_association.create.mock.calls[0][0].data).toMatchObject({
      student_id: 'st1', school_id: 's1', candidate_id: null, state: 'STUDENT_SELECTED',
    });
  });

  it('an unknown, retired or other-country school id is rejected', async () => {
    const { client, service } = studentSide();
    client.school.findFirst.mockResolvedValue(null);
    await expect(service.selectSchool('a', { schoolId: 'nope' })).rejects.toBeInstanceOf(SchoolNotFoundError);
    expect(client.student_school_association.create).not.toHaveBeenCalled();
  });

  it('a branch must belong to the chosen school', async () => {
    const { client, service } = studentSide();
    client.school.findFirst.mockResolvedValue({ id: 's1' });
    client.school_branch.findFirst.mockResolvedValue(null);
    await expect(service.selectSchool('a', { schoolId: 's1', branchId: 'other-branch' })).rejects.toBeInstanceOf(SchoolNotFoundError);
    expect(client.school_branch.findFirst.mock.calls[0][0].where).toMatchObject({ id: 'other-branch', school_id: 's1' });
  });

  it('free text becomes a PENDING candidate and an UNVERIFIED association', async () => {
    const { client, service } = studentSide();
    client.school.findFirst.mockResolvedValue(null);
    client.school_candidate.findFirst.mockResolvedValue(null);
    client.school_candidate.create.mockResolvedValue({ id: 'c1' });
    client.student_school_association.create.mockResolvedValue({ id: 'as1' });
    await service.selectSchool('a', { schoolName: '  My   Local School ' });
    expect(client.school_candidate.create.mock.calls[0][0].data).toMatchObject({ name_as_entered: 'My Local School' });
    expect(client.student_school_association.create.mock.calls[0][0].data).toMatchObject({
      school_id: null, candidate_id: 'c1', state: 'UNVERIFIED',
    });
  });

  it('free text that exactly matches a registry school uses the registry school', async () => {
    const { client, service } = studentSide();
    client.school.findFirst.mockResolvedValue({ id: 's1', name: 'Test School' });
    client.student_school_association.create.mockResolvedValue({ id: 'as1' });
    await service.selectSchool('a', { schoolName: 'test school' });
    expect(client.school_candidate.create).not.toHaveBeenCalled();
    expect(client.student_school_association.create.mock.calls[0][0].data).toMatchObject({ school_id: 's1', state: 'STUDENT_SELECTED' });
  });

  it('rejects markup in free text', async () => {
    const { service } = studentSide();
    await expect(service.selectSchool('a', { schoolName: '<img src=x>' })).rejects.toBeInstanceOf(InvalidSchoolInputError);
  });

  it('changing school ends the open association with CHANGED (history kept) and adds a new one', async () => {
    const { client, service } = studentSide();
    client.school.findFirst.mockResolvedValue({ id: 's2' });
    client.student_school_association.findFirst.mockResolvedValue({ id: 'old', school_id: 's1', branch_id: null, candidate_id: null });
    client.student_school_association.create.mockResolvedValue({ id: 'new' });
    await service.selectSchool('a', { schoolId: 's2' });
    expect(client.student_school_association.updateMany.mock.calls[0][0]).toMatchObject({
      where: { student_id: 'st1', ended_at: null }, data: { end_reason: 'CHANGED' },
    });
    expect(client.student_school_association.create).toHaveBeenCalledTimes(1);
  });

  it('choosing the same school again changes nothing', async () => {
    const { client, outbox, service } = studentSide();
    client.school.findFirst.mockResolvedValue({ id: 's1' });
    client.student_school_association.findFirst.mockResolvedValue({ id: 'old', school_id: 's1', branch_id: null, candidate_id: null });
    await service.selectSchool('a', { schoolId: 's1' });
    expect(client.student_school_association.create).not.toHaveBeenCalled();
    expect(client.student_school_association.updateMany).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('events and audit carry ids and state, never a school name or free text', async () => {
    const { client, outbox, service } = studentSide();
    client.school.findFirst.mockResolvedValue(null);
    client.school_candidate.findFirst.mockResolvedValue(null);
    client.school_candidate.create.mockResolvedValue({ id: 'c1' });
    client.student_school_association.create.mockResolvedValue({ id: 'as1' });
    await service.selectSchool('a', { schoolName: 'Sunrise Academy' });
    const logged = JSON.stringify([outbox.publish.mock.calls, client.audit_event.create.mock.calls]);
    expect(logged).not.toContain('Sunrise');
    expect(outbox.publish.mock.calls[0][1].payload).toEqual({ studentId: 'st1', associationId: 'as1', state: 'UNVERIFIED' });
  });
});

describe('StudentSchoolService.leaveSchool and reads', () => {
  it('leaving ends the open association with LEFT and audits it', async () => {
    const { client, service } = studentSide();
    client.student_school_association.findFirst.mockResolvedValue({ id: 'old', state: 'STUDENT_SELECTED' });
    await service.leaveSchool('a');
    expect(client.student_school_association.update.mock.calls[0][0].data).toMatchObject({ end_reason: 'LEFT' });
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });

  it('leaving with no open association is a no-op', async () => {
    const { client, service } = studentSide();
    await service.leaveSchool('a');
    expect(client.student_school_association.update).not.toHaveBeenCalled();
  });

  it('reading requires a student but not guardian consent', async () => {
    const { students, service } = studentSide();
    await service.getAcademic('a');
    expect(students.ownStudentId).toHaveBeenCalled();
    expect(students.studentIdForDataCollection).not.toHaveBeenCalled();
    students.ownStudentId.mockRejectedValue(new StudentNotFoundError());
    await expect(service.getAcademic('a')).rejects.toBeInstanceOf(StudentNotFoundError);
  });

  it('the view marks free-text associations as awaiting review and shows the student their own text', async () => {
    const { client, service } = studentSide();
    client.student_school_association.findFirst.mockResolvedValue({
      state: 'UNVERIFIED', candidate_id: 'c1', school: null, branch: null, candidate: { name_as_entered: 'My School' },
    });
    const out = await service.getAcademic('a');
    expect(out.school).toEqual({ state: 'UNVERIFIED', name: 'My School', branchName: null, awaitingReview: true });
  });

  it('search only returns ACTIVE schools of the default country, bounded, using a validated query', async () => {
    const { client, service } = studentSide();
    await service.search('high school');
    const args = client.school.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ status: 'ACTIVE' });
    expect(args.take).toBe(20);
    await expect(service.search('50%')).rejects.toBeInstanceOf(InvalidSchoolInputError);
  });
});

describe('SchoolRegistryService', () => {
  const make = () => {
    const client = fakeClient();
    return { client, service: new SchoolRegistryService({ client } as unknown as DatabaseService) };
  };

  it('addSchool normalises, audits with the operator, and is idempotent', async () => {
    const { client, service } = make();
    client.school.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 's1' });
    client.school.create.mockResolvedValue({ id: 's1' });
    expect(await service.addSchool({ name: '  Test  School ', countryCode: 'ae', city: ' Dubai ', operator: 'alfred' })).toEqual({ id: 's1', created: true });
    expect(client.school.create.mock.calls[0][0].data).toEqual({ name: 'Test School', country_code: 'AE', city: 'Dubai' });
    expect(client.audit_event.create.mock.calls[0][0].data.metadata).toMatchObject({ operator: 'alfred' });
    expect(await service.addSchool({ name: 'Test School', countryCode: 'AE', operator: 'alfred' })).toEqual({ id: 's1', created: false });
    expect(client.school.create).toHaveBeenCalledTimes(1);
  });

  it('rejects coordinates as a city and bad country codes', async () => {
    const { service } = make();
    await expect(service.addSchool({ name: 'Test School', countryCode: 'AE', city: '25.2,55.3', operator: 'o' })).rejects.toBeInstanceOf(InvalidSchoolInputError);
    await expect(service.addSchool({ name: 'Test School', countryCode: 'UAE', operator: 'o' })).rejects.toBeInstanceOf(InvalidSchoolInputError);
  });

  it('alias and branch require an existing school', async () => {
    const { client, service } = make();
    client.school.findUnique.mockResolvedValue(null);
    await expect(service.addAlias({ schoolId: 'x', alias: 'Test Alias', operator: 'o' })).rejects.toBeInstanceOf(SchoolNotFoundError);
    await expect(service.addBranch({ schoolId: 'x', name: 'Branch One', operator: 'o' })).rejects.toBeInstanceOf(SchoolNotFoundError);
  });

  it('retire hides the school but is idempotent', async () => {
    const { client, service } = make();
    client.school.findUnique.mockResolvedValueOnce({ id: 's1', status: 'ACTIVE' }).mockResolvedValueOnce({ id: 's1', status: 'RETIRED' });
    expect(await service.retireSchool({ schoolId: 's1', operator: 'o' })).toEqual({ retired: true });
    expect(await service.retireSchool({ schoolId: 's1', operator: 'o' })).toEqual({ retired: false });
    expect(client.school.update).toHaveBeenCalledTimes(1);
  });

  it('accepting a candidate adds an alias and moves only OPEN associations', async () => {
    const { client, service } = make();
    client.school_candidate.findUnique.mockResolvedValue({ id: 'c1', status: 'PENDING', name_as_entered: 'Sunrise Acad' });
    client.school.findUnique.mockResolvedValue({ id: 's1', name: 'Sunrise Academy' });
    client.school_alias.findFirst.mockResolvedValue(null);
    await service.resolveCandidate({ candidateId: 'c1', decision: { action: 'accept', schoolId: 's1' }, operator: 'alfred' });
    expect(client.school_alias.create.mock.calls[0][0].data).toEqual({ school_id: 's1', alias: 'Sunrise Acad' });
    expect(client.student_school_association.updateMany.mock.calls[0][0]).toEqual({
      where: { candidate_id: 'c1', ended_at: null },
      data: { school_id: 's1', candidate_id: null, state: 'STUDENT_SELECTED' },
    });
    expect(client.audit_event.create.mock.calls[0][0].data.action).toBe('school.registry.candidate_accepted');
  });

  it('rejecting a candidate ends open associations so the student can choose again', async () => {
    const { client, service } = make();
    client.school_candidate.findUnique.mockResolvedValue({ id: 'c1', status: 'PENDING', name_as_entered: 'xyz' });
    await service.resolveCandidate({ candidateId: 'c1', decision: { action: 'reject' }, operator: 'alfred' });
    expect(client.student_school_association.updateMany.mock.calls[0][0]).toMatchObject({
      where: { candidate_id: 'c1', ended_at: null }, data: { end_reason: 'CANDIDATE_REJECTED' },
    });
  });

  it('an unknown or already-resolved candidate is refused', async () => {
    const { client, service } = make();
    client.school_candidate.findUnique.mockResolvedValue(null);
    await expect(service.resolveCandidate({ candidateId: 'c1', decision: { action: 'reject' }, operator: 'o' })).rejects.toBeInstanceOf(CandidateNotPendingError);
    client.school_candidate.findUnique.mockResolvedValue({ id: 'c1', status: 'ACCEPTED' });
    await expect(service.resolveCandidate({ candidateId: 'c1', decision: { action: 'reject' }, operator: 'o' })).rejects.toBeInstanceOf(CandidateNotPendingError);
  });
});

describe('parseSchoolChoice', () => {
  it('accepts exactly one of schoolId or schoolName', () => {
    expect(parseSchoolChoice({ schoolId: 's1' })).toEqual({ schoolId: 's1' });
    expect(parseSchoolChoice({ schoolId: 's1', branchId: 'b1' })).toEqual({ schoolId: 's1', branchId: 'b1' });
    expect(parseSchoolChoice({ schoolName: 'My School' })).toEqual({ schoolName: 'My School' });
  });
  it.each([[{}], [{ schoolId: 's', schoolName: 'n' }], [{ schoolId: 5 }], [null], [[]], ['x']])('rejects %p', (v) => {
    expect(() => parseSchoolChoice(v)).toThrow(BadRequestException);
  });
});

describe('schools CLI', () => {
  const registry = () => ({
    addSchool: jest.fn().mockResolvedValue({ id: 's1', created: true }),
    addAlias: jest.fn().mockResolvedValue({ added: true }),
    addBranch: jest.fn().mockResolvedValue({ id: 'b1', created: true }),
    retireSchool: jest.fn().mockResolvedValue({ retired: true }),
    listSchools: jest.fn().mockResolvedValue([]),
    listPendingCandidates: jest.fn().mockResolvedValue([]),
    resolveCandidate: jest.fn().mockResolvedValue(undefined),
  });

  it('refuses to run without an operator name', async () => {
    await expect(runSchoolsCli(['list'], { registry: registry(), operator: ' ' })).rejects.toBeInstanceOf(CliUsageError);
  });
  it('add passes name, country, city and the operator', async () => {
    const r = registry();
    expect(await runSchoolsCli(['add', 'Test School', 'ae', 'Dubai'], { registry: r, operator: 'alfred' })).toContain('Added school s1');
    expect(r.addSchool).toHaveBeenCalledWith({ name: 'Test School', countryCode: 'ae', city: 'Dubai', operator: 'alfred' });
  });
  it('accept and reject map to resolveCandidate', async () => {
    const r = registry();
    await runSchoolsCli(['accept', 'c1', 's1'], { registry: r, operator: 'o' });
    await runSchoolsCli(['reject', 'c2'], { registry: r, operator: 'o' });
    expect(r.resolveCandidate).toHaveBeenNthCalledWith(1, { candidateId: 'c1', decision: { action: 'accept', schoolId: 's1' }, operator: 'o' });
    expect(r.resolveCandidate).toHaveBeenNthCalledWith(2, { candidateId: 'c2', decision: { action: 'reject' }, operator: 'o' });
  });
  it('wrong argument counts and unknown commands show usage', async () => {
    const r = registry();
    for (const argv of [[], ['nope'], ['add'], ['add', 'Name'], ['alias', 'x'], ['accept', 'c1'], ['list', 'extra'], ['retire']]) {
      await expect(runSchoolsCli(argv, { registry: r, operator: 'o' })).rejects.toBeInstanceOf(CliUsageError);
    }
  });
  it('list reports an empty registry plainly', async () => {
    expect(await runSchoolsCli(['list'], { registry: registry(), operator: 'o' })).toBe('No schools in the registry yet.');
  });
});
