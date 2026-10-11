import type { DatabaseService } from '../database/database.service';
import type { OutboxService } from '../outbox/outbox.service';
import { CurriculumConflictError, CurriculumForbiddenError } from './curriculum.errors';
import { CurriculumTransitionError, type CurriculumActor } from './curriculum-state';
import { CurriculumService } from './curriculum.service';

/**
 * Runs the service against an in-memory fake of the Prisma client: verifies guard rails
 * and orchestration, NOT SQL. Typing and schema are checked by CI (prisma generate + tsc).
 */

const human = (role: any, id = 'acct-1'): CurriculumActor => ({ kind: 'HUMAN', accountId: id, role });
const ai: CurriculumActor = { kind: 'AI', accountId: null, role: 'AI_RESEARCH' };

const sv = (over: Record<string, unknown> = {}) => ({
  id: 'sv1', state: 'DRAFT', revision: 1,
  curriculum_version_id: 'cv', grade_id: 'g', subject_id: 's', ...over,
});

function makeFakes() {
  const client: Record<string, any> = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    curriculum: { upsert: jest.fn().mockResolvedValue({ id: 'c' }) },
    curriculum_version: { upsert: jest.fn().mockResolvedValue({ id: 'cv' }) },
    grade: { upsert: jest.fn().mockResolvedValue({ id: 'g' }) },
    subject: { upsert: jest.fn().mockResolvedValue({ id: 's' }) },
    curriculum_subject_version: {
      findFirst: jest.fn(), findUnique: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'sv-new' }), update: jest.fn(),
    },
    curriculum_evidence_pack: {
      findFirst: jest.fn(), create: jest.fn().mockResolvedValue({ id: 'pk' }), update: jest.fn(),
    },
    curriculum_evidence_reference: {
      create: jest.fn().mockResolvedValue({ id: 'ref-new' }), count: jest.fn(), findMany: jest.fn().mockResolvedValue([]),
    },
    chapter: { deleteMany: jest.fn(), create: jest.fn(), count: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    curriculum_validation_run: { create: jest.fn() },
    curriculum_approval_record: { create: jest.fn() },
    curriculum_activation_record: { create: jest.fn() },
    curriculum_event_log: { create: jest.fn().mockResolvedValue({ id: 'log1' }) },
  };
  client.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(client));
  const outbox = { publish: jest.fn() };
  const service = new CurriculumService(
    { client } as unknown as DatabaseService,
    outbox as unknown as OutboxService,
  );
  return { client, outbox, service };
}

const stateUpdates = (client: Record<string, any>) =>
  client.curriculum_subject_version.update.mock.calls
    .map((c: any[]) => c[0].data.state)
    .filter(Boolean);

describe('createSubjectVersion', () => {
  const key = {
    curriculumCode: 'X', curriculumName: 'X', versionLabel: 'v', gradeCode: 'G8', subjectCode: 'S', subjectName: 'S',
  };
  it('creates revision 1 in DRAFT', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findFirst.mockResolvedValue(null);
    await expect(service.createSubjectVersion(key, human('EDITOR'))).resolves.toEqual({ id: 'sv-new', revision: 1 });
    expect(client.curriculum_subject_version.create.mock.calls[0][0].data.state).toBe('DRAFT');
  });
  it('refuses when the unit already has a revision', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findFirst.mockResolvedValue(sv());
    await expect(service.createSubjectVersion(key, human('EDITOR'))).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('refuses a reviewer / approver (not an editor)', async () => {
    const { service } = makeFakes();
    await expect(service.createSubjectVersion(key, human('APPROVER'))).rejects.toBeInstanceOf(CurriculumForbiddenError);
  });
});

describe('replaceContent', () => {
  it('reopens validation when edited after VALIDATED', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'VALIDATED' }));
    await expect(service.replaceContent('sv1', { chapters: [] }, human('EDITOR'))).resolves.toEqual({
      state: 'VALIDATION_PENDING',
    });
    expect(stateUpdates(client)).toEqual(['VALIDATION_PENDING']);
  });
  it('reopens validation when edited after APPROVED', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'APPROVED' }));
    await service.replaceContent('sv1', { chapters: [] }, human('EDITOR'));
    expect(stateUpdates(client)).toEqual(['VALIDATION_PENDING']);
  });
  it('is refused on an ACTIVE version and touches nothing', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'ACTIVE' }));
    await expect(service.replaceContent('sv1', { chapters: [] }, human('EDITOR'))).rejects.toBeInstanceOf(
      CurriculumTransitionError,
    );
    expect(client.chapter.deleteMany).not.toHaveBeenCalled();
  });
  it('is refused for a reviewer', async () => {
    const { service } = makeFakes();
    await expect(service.replaceContent('sv1', { chapters: [] }, human('REVIEWER'))).rejects.toBeInstanceOf(
      CurriculumForbiddenError,
    );
  });
});

describe('addEvidenceReference', () => {
  it('un-verifies a verified pack and reopens validation', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'VALIDATED' }));
    client.curriculum_evidence_pack.findFirst.mockResolvedValue({ id: 'pk', status: 'VERIFIED' });
    await service.addEvidenceReference('sv1', { sourceTitle: 'Official doc' }, human('EDITOR'));
    expect(client.curriculum_evidence_pack.update.mock.calls[0][0].data.status).toBe('DRAFT');
    expect(stateUpdates(client)).toEqual(['VALIDATION_PENDING']);
  });
  it('creates the pack on first reference', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv());
    client.curriculum_evidence_pack.findFirst.mockResolvedValue(null);
    await service.addEvidenceReference('sv1', { sourceTitle: 'Official doc' }, ai);
    expect(client.curriculum_evidence_pack.create).toHaveBeenCalled();
  });
});

describe('verifyEvidencePack', () => {
  it('requires a human reviewer-or-above and a note', async () => {
    const { service } = makeFakes();
    await expect(service.verifyEvidencePack('sv1', 'ok', ai)).rejects.toBeInstanceOf(CurriculumForbiddenError);
    await expect(service.verifyEvidencePack('sv1', 'ok', human('EDITOR'))).rejects.toBeInstanceOf(CurriculumForbiddenError);
    await expect(service.verifyEvidencePack('sv1', '  ', human('REVIEWER'))).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('refuses an empty pack', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv());
    client.curriculum_evidence_pack.findFirst.mockResolvedValue({ id: 'pk', references: [] });
    await expect(service.verifyEvidencePack('sv1', 'checked', human('REVIEWER'))).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('marks VERIFIED with who and why', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv());
    client.curriculum_evidence_pack.findFirst.mockResolvedValue({ id: 'pk', references: [{ id: 'r' }] });
    await service.verifyEvidencePack('sv1', 'checked against source', human('REVIEWER', 'rev-9'));
    expect(client.curriculum_evidence_pack.update.mock.calls[0][0].data).toMatchObject({
      status: 'VERIFIED', verified_by: 'rev-9', verification_note: 'checked against source',
    });
  });
});

describe('transition', () => {
  it('refuses the targets that have dedicated, more strictly guarded operations', async () => {
    const { service } = makeFakes();
    for (const to of ['VALIDATED', 'APPROVED', 'ACTIVE', 'SUPERSEDED'] as const) {
      await expect(service.transition('sv1', to, human('SUPER_ADMIN'))).rejects.toBeInstanceOf(CurriculumTransitionError);
    }
  });
  it('refuses to request validation without evidence and content', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv());
    client.curriculum_evidence_reference.count.mockResolvedValue(0);
    client.chapter.count.mockResolvedValue(3);
    await expect(service.transition('sv1', 'VALIDATION_PENDING', human('EDITOR'))).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('moves DRAFT -> VALIDATION_PENDING when evidence and content exist', async () => {
    const { client, outbox, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv());
    client.curriculum_evidence_reference.count.mockResolvedValue(2);
    client.chapter.count.mockResolvedValue(3);
    await service.transition('sv1', 'VALIDATION_PENDING', human('EDITOR'));
    expect(stateUpdates(client)).toEqual(['VALIDATION_PENDING']);
    expect(outbox.publish).toHaveBeenCalledTimes(1);
  });
});

describe('runValidation', () => {
  const pending = () => sv({ state: 'VALIDATION_PENDING' });
  it('only runs in VALIDATION_PENDING', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'DRAFT' }));
    await expect(service.runValidation('sv1')).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('fails an empty tree, records the run, and sends it back to CHANGES_REQUIRED', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(pending());
    const out = await service.runValidation('sv1');
    expect(out.passed).toBe(false);
    expect(client.curriculum_validation_run.create.mock.calls[0][0].data.status).toBe('FAILED');
    expect(stateUpdates(client)).toEqual(['CHANGES_REQUIRED']);
  });
  it('passes a valid tree and moves to VALIDATED', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(pending());
    client.curriculum_evidence_reference.findMany.mockResolvedValue([{ id: 'r1' }]);
    const base = (c: string) => ({ code: c, position: 0, provenance: 'OFFICIAL_EXPLICIT', evidence_reference_id: 'r1', rationale: null });
    client.chapter.findMany.mockResolvedValue([
      { ...base('C'), title: 'c', topics: [{ ...base('T'), title: 't', micro_concepts: [
        { ...base('M'), title: 'm', learning_objectives: [{ ...base('L'), statement: 's' }] },
      ] }] },
    ]);
    const out = await service.runValidation('sv1');
    expect(out.passed).toBe(true);
    expect(stateUpdates(client)).toEqual(['VALIDATED']);
  });
});

describe('approve', () => {
  it('refuses an AI actor and records nothing', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'ADMIN_REVIEW' }));
    await expect(service.approve('sv1', ai)).rejects.toBeInstanceOf(CurriculumTransitionError);
    expect(client.curriculum_approval_record.create).not.toHaveBeenCalled();
  });
  it('refuses from any state other than ADMIN_REVIEW', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'VALIDATED' }));
    await expect(service.approve('sv1', human('APPROVER'))).rejects.toBeInstanceOf(CurriculumTransitionError);
  });
  it('approves to APPROVED, not ACTIVE', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'ADMIN_REVIEW' }));
    await service.approve('sv1', human('APPROVER'));
    expect(stateUpdates(client)).toEqual(['APPROVED']);
    expect(client.curriculum_activation_record.create).not.toHaveBeenCalled();
  });
});

describe('activate', () => {
  const approved = () => sv({ state: 'APPROVED', revision: 2 });
  it('refuses an AI actor', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(approved());
    await expect(service.activate('sv1', ai)).rejects.toBeInstanceOf(CurriculumTransitionError);
    expect(stateUpdates(client)).toEqual([]);
  });
  it('refuses an editor', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(approved());
    await expect(service.activate('sv1', human('EDITOR'))).rejects.toBeInstanceOf(CurriculumTransitionError);
  });
  it('refuses when not APPROVED', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(sv({ state: 'ADMIN_REVIEW' }));
    await expect(service.activate('sv1', human('APPROVER'))).rejects.toBeInstanceOf(CurriculumTransitionError);
  });
  it('refuses an unverified evidence pack and changes nothing', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(approved());
    client.curriculum_evidence_pack.findFirst.mockResolvedValue({ id: 'pk', status: 'DRAFT' });
    await expect(service.activate('sv1', human('APPROVER'))).rejects.toBeInstanceOf(CurriculumConflictError);
    expect(stateUpdates(client)).toEqual([]);
    expect(client.curriculum_activation_record.create).not.toHaveBeenCalled();
  });
  it('activates, supersedes the previously live revision, and records the human', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockImplementation(({ where }: any) =>
      Promise.resolve(where.id === 'sv1' ? approved() : null),
    );
    client.curriculum_evidence_pack.findFirst.mockResolvedValue({ id: 'pk', status: 'VERIFIED' });
    client.curriculum_subject_version.findMany.mockResolvedValue([{ id: 'old', state: 'ACTIVE' }]);
    await service.activate('sv1', human('APPROVER', 'appr-1'));
    const updates = client.curriculum_subject_version.update.mock.calls.map((c: any[]) => [c[0].where.id, c[0].data.state]);
    expect(updates).toEqual(expect.arrayContaining([['old', 'SUPERSEDED'], ['sv1', 'ACTIVE']]));
    expect(client.curriculum_activation_record.create.mock.calls[0][0].data.actor_account_id).toBe('appr-1');
  });
});

describe('createCorrectionRevision', () => {
  const source = (state: string) => ({ ...sv({ state }), evidence_packs: [], chapters: [] });
  it('refuses to correct a revision that is not live', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(source('DRAFT'));
    await expect(service.createCorrectionRevision('sv1', human('EDITOR'))).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('refuses when an open revision already exists', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(source('ACTIVE'));
    client.curriculum_subject_version.findMany.mockResolvedValue([
      { state: 'ACTIVE', revision: 1 }, { state: 'DRAFT', revision: 2 },
    ]);
    await expect(service.createCorrectionRevision('sv1', human('EDITOR'))).rejects.toBeInstanceOf(CurriculumConflictError);
  });
  it('creates the next revision as a DRAFT linked to the source, leaving the source untouched', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findUnique.mockResolvedValue(source('ACTIVE'));
    client.curriculum_subject_version.findMany.mockResolvedValue([{ state: 'ACTIVE', revision: 1 }]);
    const out = await service.createCorrectionRevision('sv1', human('EDITOR'));
    expect(out.revision).toBe(2);
    expect(client.curriculum_subject_version.create.mock.calls[0][0].data).toMatchObject({
      state: 'DRAFT', supersedes_id: 'sv1', revision: 2,
    });
    expect(client.curriculum_subject_version.update).not.toHaveBeenCalled();
  });
});

describe('getActiveTree', () => {
  it('returns null when nothing is ACTIVE, so drafts can never be referenced', async () => {
    const { client, service } = makeFakes();
    client.curriculum_subject_version.findFirst.mockResolvedValue(null);
    await expect(
      service.getActiveTree({ curriculumCode: 'X', versionLabel: 'v', gradeCode: 'G8', subjectCode: 'S' }),
    ).resolves.toBeNull();
    expect(client.curriculum_subject_version.findFirst.mock.calls[0][0].where.state).toBe('ACTIVE');
  });
});
