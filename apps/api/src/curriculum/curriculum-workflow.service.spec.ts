import { memoryDb } from '../testing/memory-db';
import { CurriculumWorkflowService } from './curriculum-workflow.service';

const SV = '11111111-1111-4111-8111-111111111111';

function setup(state = 'APPROVED', roles: Record<string, string[]> = { editor: ['EDITOR'], approver: ['APPROVER'], both: ['EDITOR', 'APPROVER'] }) {
  const db = memoryDb();
  db.seed('curriculum_subject_version', [
    { id: SV, curriculum_version_id: 'cv', grade_id: 'g', subject_id: 's', revision: 1, state, last_edited_by: 'editor', supersedes_id: null, activated_at: null, curriculum_version: { label: '2026-27', curriculum: { code: 'ICSE' } }, grade: { code: 'GRADE_8' }, subject: { code: 'CHEMISTRY', name: 'Chemistry' } },
  ]);
  db.seed('curriculum_event_log', [
    { subject_version_id: SV, event_type: 'created', actor_kind: 'HUMAN', actor_account_id: 'editor', from_state: null, to_state: 'DRAFT', note: null, occurred_at: new Date('2026-10-01') },
    { subject_version_id: SV, event_type: 'content_replaced', actor_kind: 'HUMAN', actor_account_id: 'both', from_state: 'DRAFT', to_state: 'DRAFT', note: null, occurred_at: new Date('2026-10-02') },
    { subject_version_id: SV, event_type: 'state_changed', actor_kind: 'HUMAN', actor_account_id: 'approver', from_state: 'ADMIN_REVIEW', to_state: 'APPROVED', note: 'Checked against the syllabus', occurred_at: new Date('2026-10-03') },
  ]);
  db.seed('curriculum_evidence_pack', [{ id: 'pack', subject_version_id: SV, status: 'VERIFIED', verified_by: 'approver', verification_note: 'Matches CISCE 2026', verified_at: new Date('2026-10-02'), created_at: new Date('2026-10-01'), references: [{ source_title: 'CISCE syllabus', source_url: 'https://cisce.org/x', locator: 'p. 12', retrieved_at: null, created_at: new Date() }] }]);
  db.seed('chapter', [{ subject_version_id: SV, code: 'CH1', title: 'Matter', position: 1, topics: [{ micro_concepts: [{ learning_objectives: [{ id: 'o1' }, { id: 'o2' }] }] }] }]);
  db.seed('authentication_identity', [
    { account_id: 'editor', kind: 'EMAIL', identifier_normalized: 'ed@example.com' },
    { account_id: 'approver', kind: 'EMAIL', identifier_normalized: 'ap@example.com' },
  ]);
  let current = state;
  const curriculum = { getState: jest.fn(async () => current) };
  const admin = {
    activate: jest.fn(async () => void (current = 'ACTIVE')),
    approve: jest.fn(async () => void (current = 'APPROVED')),
    transition: jest.fn(async (_a: string, _id: string, to: string) => void (current = to)),
    verifyEvidencePack: jest.fn(async () => undefined),
    addEvidenceReference: jest.fn(async () => ({ referenceId: 'r2' })),
    createSubjectVersion: jest.fn(async () => ({ id: 'new', revision: 1 })),
    createCorrectionRevision: jest.fn(async () => ({ id: 'corr', revision: 2 })),
    submitForValidation: jest.fn(async () => ({ passed: true, findings: [] })),
  };
  const authz = { curriculumRolesFor: jest.fn(async (a: string) => roles[a] ?? []) };
  return { db, admin, service: new CurriculumWorkflowService({ client: db } as any, curriculum as any, admin as any, authz as any) };
}

describe('CurriculumWorkflowService', () => {
  it('the detail page: evidence, content, editors, history with names, and the actions for this person', async () => {
    const { service } = setup();
    const d = await service.detail('approver', SV);
    expect(d.unit).toMatchObject({ curriculumCode: 'ICSE', subjectName: 'Chemistry', state: 'APPROVED' });
    expect(d.evidence).toMatchObject({ status: 'VERIFIED', verifiedBy: 'ap@example.com', references: [{ number: 1, title: 'CISCE syllabus', locator: 'p. 12' }] });
    expect(d.content).toMatchObject({ chapters: 1, objectives: 2, chapterList: [{ code: 'CH1', title: 'Matter', objectives: 2 }] });
    expect(d.editors.sort()).toEqual(['both', 'ed@example.com']);
    expect(d.history[0]).toMatchObject({ type: 'state_changed', actor: 'ap@example.com', note: 'Checked against the syllabus' });
    expect(d.actions.activate).toEqual({ allowed: true });
    expect((await service.detail('both', SV)).actions.activate).toMatchObject({ allowed: false, reason: expect.stringMatching(/You edited this revision/) });
    await expect(service.detail('student', SV)).rejects.toThrow(/curriculum role/);
  });

  it('activation: refused for anyone who edited the revision, allowed for another approver, audited with the note', async () => {
    const { db, service, admin } = setup();
    await expect(service.activate('both', SV, { note: 'Ready for the alpha' })).rejects.toThrow(/you edited this revision/);
    await expect(service.activate('editor', SV, { note: 'Ready for the alpha' })).rejects.toThrow(/you edited this revision/);
    await expect(service.activate('approver', SV, { note: 'short' })).rejects.toThrow(/activation note/);
    expect(admin.activate).not.toHaveBeenCalled();
    await expect(service.activate('approver', SV, { note: 'Ready for the alpha after review' })).resolves.toEqual({ state: 'ACTIVE' });
    expect(admin.activate).toHaveBeenCalledWith('approver', SV);
    expect(db.rows('audit_event')).toEqual([expect.objectContaining({ action: 'curriculum.activated', actor_account_id: 'approver', metadata: { note: 'Ready for the alpha after review' } })]);
  });

  it('only an approved curriculum is activated; only a suspended one resumed (same editor rule)', async () => {
    const live = setup('ACTIVE');
    await expect(live.service.activate('approver', SV, { note: 'Ready for the alpha after review' })).rejects.toThrow(/Only an approved curriculum/);
    await expect(live.service.resume('approver', SV, { note: 'Fixed and checked again' })).rejects.toThrow(/Only a suspended/);
    await live.service.suspend('approver', SV, { note: 'Wrong answer key in chapter 3' });
    expect(live.admin.transition).toHaveBeenCalledWith('approver', SV, 'SUSPENDED', 'Wrong answer key in chapter 3');
    await expect(live.service.resume('both', SV, { note: 'Fixed and checked again' })).rejects.toThrow(/you edited/);
    await expect(live.service.resume('approver', SV, { note: 'Fixed and checked again' })).resolves.toEqual({ state: 'ACTIVE' });
    expect(live.db.rows('audit_event').map((a: any) => a.action)).toEqual(['curriculum.suspended', 'curriculum.resumed']);
  });

  it('creating a subject: codes are normalised and checked', async () => {
    const { service, admin } = setup();
    await expect(service.create('editor', { curriculumCode: 'icse', curriculumName: 'ICSE', versionLabel: '2026-27', gradeCode: 'grade_8', subjectCode: 'Biology', subjectName: 'Biology' })).resolves.toEqual({ id: 'new', revision: 1 });
    expect(admin.createSubjectVersion).toHaveBeenCalledWith('editor', { curriculumCode: 'ICSE', curriculumName: 'ICSE', versionLabel: '2026-27', gradeCode: 'GRADE_8', subjectCode: 'BIOLOGY', subjectName: 'Biology' });
    await expect(service.create('editor', { curriculumCode: 'IC SE', curriculumName: 'ICSE', versionLabel: '2026-27', gradeCode: 'G8', subjectCode: 'BIO', subjectName: 'Biology' })).rejects.toThrow(/Curriculum code/);
    await expect(service.create('editor', { curriculumCode: 'ICSE', curriculumName: 'I', versionLabel: '2026-27', gradeCode: 'G8', subjectCode: 'BIO', subjectName: 'Biology' })).rejects.toThrow(/Curriculum name/);
  });

  it('evidence: a title, and a real link if one is given; notes for verify, send back and approve', async () => {
    const { service, admin } = setup('DRAFT');
    await expect(service.addEvidence('editor', SV, { title: 'CISCE Chemistry syllabus 2026', url: 'cisce.org', locator: '' })).rejects.toThrow(/http/);
    await service.addEvidence('editor', SV, { title: 'CISCE Chemistry syllabus 2026', url: 'https://cisce.org/syllabus.pdf', locator: 'pages 4-9', retrievedAt: '2026-10-01' });
    expect(admin.addEvidenceReference).toHaveBeenCalledWith('editor', SV, { sourceTitle: 'CISCE Chemistry syllabus 2026', sourceUrl: 'https://cisce.org/syllabus.pdf', locator: 'pages 4-9', retrievedAt: new Date('2026-10-01') });
    await expect(service.verifyEvidence('approver', SV, { note: 'ok' })).rejects.toThrow(/Say what you checked/);
    await expect(service.requestChanges('approver', SV, {})).rejects.toThrow(/what needs changing/);
    await service.approve('approver', SV, { note: 'Every chapter matches the syllabus' });
    expect(admin.approve).toHaveBeenCalledWith('approver', SV, 'Every chapter matches the syllabus');
  });
});
