import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { bankStatus, healthBlockers, isServable, publishBlockers, summariseBank, type PublishFacts } from './publication-domain';
import { PublicationController, healthInput } from './publication.controller';
import { PublicationConflictError, PublicationForbiddenError } from './publication.errors';
import { PublicationService } from './publication.service';
import { BankUsageError, runBankCli } from './cli/publication-cli';

const ok: PublishFacts = {
  revisionState: 'APPROVED', answerVerified: true, checksPassed: true, objectiveExists: true, curriculumState: 'ACTIVE',
  allowUnactivatedCurriculum: false, publication: null, actorIsHuman: true,
};

describe('publishBlockers', () => {
  it('lets an approved, verified, checked question in an active curriculum through', () => {
    expect(publishBlockers(ok)).toEqual([]);
  });
  it('refuses anything that is not approved', () => {
    for (const s of ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUIRED', 'QUARANTINED', 'RETIRED', 'SUPERSEDED'] as const) {
      expect(publishBlockers({ ...ok, revisionState: s })[0]).toMatch(/only an approved question/);
    }
  });
  it('refuses the AI', () => {
    expect(publishBlockers({ ...ok, actorIsHuman: false })).toContain('only a person can publish a question');
  });
  it('refuses a missing key confirmation, failed checks, a vanished objective and an inactive curriculum', () => {
    expect(publishBlockers({ ...ok, answerVerified: false }).join()).toMatch(/answer key/);
    expect(publishBlockers({ ...ok, checksPassed: false }).join()).toMatch(/automatic checks/);
    expect(publishBlockers({ ...ok, objectiveExists: false }).join()).toMatch(/objective/);
    expect(publishBlockers({ ...ok, curriculumState: 'APPROVED' }).join()).toMatch(/not active/);
  });
  it('the local-testing switch allows an inactive curriculum and nothing else', () => {
    expect(publishBlockers({ ...ok, curriculumState: 'DRAFT', allowUnactivatedCurriculum: true })).toEqual([]);
    expect(publishBlockers({ ...ok, curriculumState: 'DRAFT', allowUnactivatedCurriculum: true, answerVerified: false })).toHaveLength(1);
  });
  it('refuses a version that is already published, but allows one that was withdrawn', () => {
    expect(publishBlockers({ ...ok, publication: 'PUBLISHED' }).join()).toMatch(/already published/);
    expect(publishBlockers({ ...ok, publication: 'WITHDRAWN' })).toEqual([]);
  });
});

describe('bank status and serving', () => {
  it('reads quarantine and retirement from the revision', () => {
    expect(bankStatus('QUARANTINED', 'PUBLISHED', 'HEALTHY')).toBe('QUARANTINED');
    expect(bankStatus('RETIRED', 'PUBLISHED', null)).toBe('RETIRED');
    expect(bankStatus('SUPERSEDED', 'WITHDRAWN', null)).toBe('RETIRED');
  });
  it('approved but unpublished is not in the bank', () => {
    expect(bankStatus('APPROVED', null, null)).toBe('NOT_PUBLISHED');
    expect(bankStatus('APPROVED', 'WITHDRAWN', null)).toBe('WITHDRAWN');
    expect(bankStatus('APPROVED', 'PUBLISHED', null)).toBe('NEW');
    expect(bankStatus('APPROVED', 'PUBLISHED', 'WATCH')).toBe('WATCH');
  });
  it('only approved, published and not degraded is served', () => {
    expect(isServable('APPROVED', 'PUBLISHED', null)).toBe(true);
    expect(isServable('APPROVED', 'PUBLISHED', 'WATCH')).toBe(true);
    expect(isServable('APPROVED', 'PUBLISHED', 'DEGRADED')).toBe(false);
    expect(isServable('APPROVED', null, null)).toBe(false);
    expect(isServable('APPROVED', 'WITHDRAWN', null)).toBe(false);
    expect(isServable('QUARANTINED', 'PUBLISHED', null)).toBe(false);
    expect(isServable('IN_REVIEW', 'PUBLISHED', null)).toBe(false);
  });
  it('health changes need a settable value, a real change and a note', () => {
    expect(healthBlockers(null, 'WATCH', 10)).toEqual([]);
    expect(healthBlockers('WATCH', 'WATCH', 10)[0]).toMatch(/already/);
    expect(healthBlockers(null, 'NEW', 10)[0]).toMatch(/must be one of/);
    expect(healthBlockers(null, 'WATCH', 2)[0]).toMatch(/note/);
  });
  it('summarises a unit, counting what awaits publication', () => {
    const s = summariseBank([
      { state: 'APPROVED', publication: 'PUBLISHED', health: null },
      { state: 'APPROVED', publication: null, health: null },
      { state: 'APPROVED', publication: 'WITHDRAWN', health: null },
      { state: 'DRAFT', publication: null, health: null },
      { state: 'QUARANTINED', publication: 'WITHDRAWN', health: null },
    ]);
    expect(s.total).toBe(5);
    expect(s.awaitingPublication).toBe(2);
    expect(s.byStatus).toMatchObject({ NEW: 1, NOT_PUBLISHED: 2, WITHDRAWN: 1, QUARANTINED: 1 });
  });
});

// ------------------------------------------------------------------ service

function make(opts: { roles?: string[]; rev?: any; unitState?: string; allow?: boolean } = {}) {
  const publications: any[] = [];
  const events: any[] = [];
  const states: any[] = [];
  const rev = {
    id: 'r1', question_id: 'q1', state: 'APPROVED', answer_verified: true,
    question: { code: 'Q1', objective_path: 'C1/T1/M1/O1', curriculum_version_id: 'cv', grade_id: 'g', subject_id: 's' },
    get publication() { return publications.find((p) => p.revision_id === 'r1') ?? null; },
    validation_runs: [{ passed: true }],
    ...opts.rev,
  };
  const client: any = {
    $queryRaw: jest.fn(async () => []),
    question_revision: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === rev.id ? rev : null)),
      findMany: jest.fn(async () => [{ id: 'r1', question: { code: 'Q1' } }]),
    },
    curriculum_subject_version: { findFirst: jest.fn(async () => ({ id: 'sv', state: opts.unitState ?? 'ACTIVE' })) },
    question_publication: {
      findUnique: jest.fn(async ({ where }: any) => publications.find((p) => p.revision_id === where.revision_id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(publications.find((p) => p.revision_id === where.revision_id), data)),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const existing = publications.find((p) => p.revision_id === where.revision_id);
        if (existing) return Object.assign(existing, update);
        publications.push({ ...create });
        return create;
      }),
    },
    question_publication_event: { create: jest.fn(async ({ data }: any) => events.push(data)) },
    question_bank_state: {
      findUnique: jest.fn(async ({ where }: any) => states.find((s) => s.question_id === where.question_id) ?? null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const e = states.find((s) => s.question_id === where.question_id);
        if (e) return Object.assign(e, update);
        states.push(create);
        return create;
      }),
    },
  };
  client.$transaction = jest.fn((cb: any) => cb(client));
  const authz: any = { curriculumRolesFor: jest.fn(async () => opts.roles ?? ['APPROVER']) };
  const questions: any = {
    objectivePaths: jest.fn(async () => new Map([['O1', ['C1/T1/M1/O1']]])),
    unitIdentity: jest.fn(async () => ({ curriculumVersionId: 'cv', gradeId: 'g', subjectId: 's', latestRevisionId: 'sv', latestRevisionState: 'ACTIVE' })),
  };
  const service = new PublicationService({ client } as any, authz, questions, { allowUnactivatedCurriculum: opts.allow ?? false, resumeHours: 24 });
  return { service, publications, events, states, rev, client, authz };
}

describe('PublicationService', () => {
  it('an approver publishes an approved question and the history records who', async () => {
    const h = make();
    await h.service.publish('acc-appr', 'r1');
    expect(h.publications[0]).toMatchObject({ revision_id: 'r1', state: 'PUBLISHED', published_by: 'acc-appr' });
    expect(h.events[0]).toMatchObject({ action: 'PUBLISH', actor_kind: 'HUMAN', actor_account_id: 'acc-appr' });
  });

  it('a reviewer or editor cannot publish', async () => {
    for (const role of ['REVIEWER', 'EDITOR']) {
      const h = make({ roles: [role] });
      await expect(h.service.publish('a', 'r1')).rejects.toBeInstanceOf(PublicationForbiddenError);
      expect(h.publications).toHaveLength(0);
    }
    await expect(make({ roles: [] }).service.publish('a', 'r1')).rejects.toBeInstanceOf(PublicationForbiddenError);
  });

  it('explains every reason a question cannot be published, and writes nothing', async () => {
    const h = make({ rev: { state: 'IN_REVIEW', answer_verified: false }, unitState: 'DRAFT' });
    await expect(h.service.publish('a', 'r1')).rejects.toThrow(PublicationConflictError);
    expect(h.publications).toHaveLength(0);
    const h2 = make({ unitState: 'APPROVED' });
    await expect(h2.service.publish('a', 'r1')).rejects.toThrow(/not active/);
  });

  it('publishing twice is refused, withdrawing then republishing works', async () => {
    const h = make({ roles: ['APPROVER'] });
    await h.service.publish('a', 'r1');
    await expect(h.service.publish('a', 'r1')).rejects.toThrow(/already published/);
    await h.service.withdraw('a', 'r1', { reasonCode: 'ANSWER_WRONG', note: 'Key is doubtful.' });
    expect(h.publications[0]).toMatchObject({ state: 'WITHDRAWN', withdrawn_by: 'a', withdraw_reason_code: 'ANSWER_WRONG' });
    await h.service.publish('a', 'r1');
    expect(h.publications[0]).toMatchObject({ state: 'PUBLISHED', withdrawn_by: null, withdraw_reason_code: null });
    expect(h.events.map((e) => e.action)).toEqual(['PUBLISH', 'WITHDRAW', 'PUBLISH']);
  });

  it('a reviewer may withdraw (the safe direction) but needs a listed reason and a note', async () => {
    const h = make({ roles: ['REVIEWER'] });
    h.publications.push({ revision_id: 'r1', state: 'PUBLISHED' });
    await expect(h.service.withdraw('a', 'r1', { reasonCode: 'NOPE', note: 'long enough' })).rejects.toThrow(/listed reason/);
    await expect(h.service.withdraw('a', 'r1', { reasonCode: 'OTHER', note: 'x' })).rejects.toThrow(/note/);
    await h.service.withdraw('a', 'r1', { reasonCode: 'OTHER', note: 'long enough' });
    expect(h.publications[0].state).toBe('WITHDRAWN');
    await expect(h.service.withdraw('a', 'r1', { reasonCode: 'OTHER', note: 'long enough' })).rejects.toThrow(/not published/);
    await expect(make({ roles: ['EDITOR'] }).service.withdraw('a', 'r1', { reasonCode: 'OTHER', note: 'long enough' })).rejects.toBeInstanceOf(PublicationForbiddenError);
  });

  it('publish-all reports what it published and what it skipped and why', async () => {
    const good = make();
    expect(await good.service.publishUnit('a', 'unit')).toEqual({ published: 1, skipped: [] });
    const bad = make({ rev: { answer_verified: false } });
    const r = await bad.service.publishUnit('a', 'unit');
    expect(r.published).toBe(0);
    expect(r.skipped[0]).toMatchObject({ code: 'Q1' });
    expect(r.skipped[0].reasons.join()).toMatch(/answer key/);
    await expect(make({ roles: ['REVIEWER'] }).service.publishUnit('a', 'unit')).rejects.toBeInstanceOf(PublicationForbiddenError);
  });

  it('health is set by a reviewer with a reason, and only to a real change', async () => {
    const h = make({ roles: ['REVIEWER'] });
    await h.service.setHealth('a', 'r1', { health: 'WATCH', reasonCode: 'LIVE_PERFORMANCE_SIGNAL', note: 'Many students miss it.' });
    expect(h.states[0]).toMatchObject({ question_id: 'q1', health: 'WATCH', changed_by: 'a' });
    await expect(h.service.setHealth('a', 'r1', { health: 'WATCH', reasonCode: 'OTHER', note: 'Again, same thing.' })).rejects.toThrow(/already/);
    await expect(h.service.setHealth('a', 'r1', { health: 'NEW', reasonCode: 'OTHER', note: 'Back to start.' })).rejects.toThrow(/must be one of/);
    await expect(make({ roles: ['EDITOR'] }).service.setHealth('a', 'r1', { health: 'WATCH', reasonCode: 'OTHER', note: 'Some note here.' })).rejects.toBeInstanceOf(PublicationForbiddenError);
  });
});

// --------------------------------------------------------------- controller

describe('PublicationController', () => {
  const UUID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
  const req = { accountId: 'acc' } as any;
  const make2 = (over: Record<string, jest.Mock> = {}) => {
    const svc: Record<string, jest.Mock> = { publish: jest.fn().mockResolvedValue({}), withdraw: jest.fn().mockResolvedValue(undefined), setHealth: jest.fn().mockResolvedValue(undefined), publishUnit: jest.fn(), summary: jest.fn(), ...over };
    return { c: new PublicationController(svc as any), svc };
  };
  it('validates ids and passes the signed-in account', async () => {
    const { c, svc } = make2();
    expect(() => c.publish(req, 'nope')).toThrow(BadRequestException);
    await c.publish(req, UUID);
    expect(svc.publish).toHaveBeenCalledWith('acc', UUID);
  });
  it('withdraw and health need a listed reason and a note', async () => {
    const { c } = make2();
    await expect(c.withdraw(req, UUID, { reasonCode: 'NOPE', note: 'x' })).rejects.toBeInstanceOf(BadRequestException);
    expect(() => healthInput({ reasonCode: 'OTHER', note: 'long enough' })).toThrow(BadRequestException);
    expect(healthInput({ health: 'WATCH', reasonCode: 'OTHER', note: 'long enough' })).toMatchObject({ health: 'WATCH' });
  });
  it('maps errors to HTTP statuses', async () => {
    await expect(make2({ publish: jest.fn().mockRejectedValue(new PublicationForbiddenError('no')) }).c.publish(req, UUID)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(make2({ publish: jest.fn().mockRejectedValue(new PublicationConflictError('no')) }).c.publish(req, UUID)).rejects.toBeInstanceOf(ConflictException);
  });
});

describe('bank status tool', () => {
  const unit = { curriculumVersionId: 'cv', gradeId: 'g', subjectId: 's' };
  const summary = summariseBank([
    { state: 'APPROVED', publication: 'PUBLISHED', health: null },
    { state: 'APPROVED', publication: null, health: null },
    { state: 'DRAFT', publication: null, health: null },
  ]);
  it('reports what is in the serving bank and what waits', async () => {
    const out = await runBankCli(['status', 'ICSE', 'GRADE_8', 'PHYSICS'], { unit: async () => unit, summary: async () => summary });
    expect(out).toMatch(/serving bank \(approved and published\): 1/);
    expect(out).toMatch(/waiting to be published: 1/);
    expect(out).toMatch(/approver publishes them/);
  });
  it('rejects bad arguments and unknown units', async () => {
    await expect(runBankCli(['status', 'ICSE'], { unit: async () => unit, summary: async () => summary })).rejects.toThrow(BankUsageError);
    await expect(runBankCli(['status', 'A', 'B', 'C'], { unit: async () => null, summary: async () => summary })).rejects.toThrow(/No curriculum/);
  });
});
