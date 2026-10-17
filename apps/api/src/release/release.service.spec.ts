import { memoryDb } from '../testing/memory-db';
import { READINESS_V1 } from './readiness-domain';
import { ReadinessService } from './readiness.service';
import { ReleaseService } from './release.service';

const NOW = new Date('2026-10-16T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);
const KEY = { curriculum_version_id: 'cv', grade_id: 'g8', subject_id: 'phy' };
const ROLES: Record<string, string[]> = { approver: ['APPROVER'], admin: ['SUPER_ADMIN'], editor: ['EDITOR'], student: [] };

function setup() {
  const db = memoryDb({ unique: { subject_release: [['curriculum_version_id', 'grade_id', 'subject_id']] } });
  db.seed('curriculum_subject_version', [
    { id: 'sv1', ...KEY, revision: 1, state: 'ACTIVE', curriculum_version: { label: '2026-27', curriculum: { code: 'ICSE' } }, grade: { code: 'GRADE_8' }, subject: { code: 'PHYSICS', name: 'Physics' } },
  ]);
  db.seed('account_student_access', [
    { account_id: 'acc-beta', student_id: 'st-beta', access_kind: 'SELF', revoked_at: null },
    { account_id: 'acc-alpha', student_id: 'st-alpha', access_kind: 'SELF', revoked_at: null },
    { account_id: 'acc-plain', student_id: 'st-plain', access_kind: 'SELF', revoked_at: null },
  ]);
  db.seed('authentication_identity', [
    { account_id: 'acc-beta', kind: 'EMAIL', identifier_normalized: 'beta@example.com' },
    { account_id: 'acc-alpha', kind: 'EMAIL', identifier_normalized: 'alpha@example.com' },
    { account_id: 'approver', kind: 'EMAIL', identifier_normalized: 'lead@example.com' },
  ]);
  const policy = (signed: boolean) => ({ id: 'pol1', code: 'READINESS_V1', status: 'ACTIVE', params: { objective: READINESS_V1.objective, tiers: READINESS_V1.tiers }, signed_off_at: signed ? hoursAgo(48) : null, signed_off_by_name: signed ? 'Dr A Lead' : null, signed_off_reference: signed ? 'Memo 7' : null });
  db.seed('readiness_policy_version', [policy(false)]);
  const report = (id: string, passes: string[], over: Record<string, unknown> = {}) =>
    db.seed('readiness_report', [
      {
        id,
        ...KEY,
        subject_version_id: 'sv1',
        policy_version_id: 'pol1',
        highest_tier: passes.at(-1) ?? 'FOUNDATION_ONLY',
        generated_at: hoursAgo(1),
        result: { tiers: Object.fromEntries(['INTERNAL', 'CONTROLLED', 'GENERAL'].map((t) => [t, { pass: passes.includes(t), checks: [] }])) },
        // The in-memory store does not follow relations: the included policy rides on the row.
        policy: { code: 'READINESS_V1', status: 'ACTIVE', signed_off_at: db.rows('readiness_policy_version')[0].signed_off_at },
        ...over,
      },
    ]);
  const authz = { curriculumRolesFor: jest.fn(async (a: string) => ROLES[a] ?? []) };
  const outbox = { publish: jest.fn(async () => undefined) };
  const release = new ReleaseService({ client: db } as any, authz as any);
  const readiness = new ReadinessService({ client: db } as any, authz as any, release, outbox as any);
  return { db, release, readiness, outbox, report, signOffPolicy: () => Object.assign(db.rows('readiness_policy_version')[0], { signed_off_at: hoursAgo(48), signed_off_by_name: 'Dr A Lead', signed_off_reference: 'Memo 7' }) };
}

describe('ReleaseService: who sees a subject', () => {
  it('no release row means nobody; each tier opens to its audience', async () => {
    const { db, release } = setup();
    await release.grantAccess('admin', { email: 'Beta@Example.com', tier: 'CONTROLLED', reason: 'Private beta invite' }, NOW);
    await release.grantAccess('admin', { email: 'alpha@example.com', tier: 'INTERNAL', reason: 'Alpha tester' }, NOW);
    const sees = async () => ({ beta: await release.visible(db, 'st-beta', KEY), alpha: await release.visible(db, 'st-alpha', KEY), plain: await release.visible(db, 'st-plain', KEY) });
    expect(await sees()).toEqual({ beta: false, alpha: false, plain: false });
    db.seed('subject_release', [{ ...KEY, tier: 'INTERNAL' }]);
    expect(await sees()).toEqual({ beta: false, alpha: true, plain: false });
    db.rows('subject_release')[0].tier = 'CONTROLLED';
    expect(await sees()).toEqual({ beta: true, alpha: true, plain: false });
    db.rows('subject_release')[0].tier = 'GENERAL';
    expect(await sees()).toEqual({ beta: true, alpha: true, plain: true });
  });

  it('switched off (development only), everything served is visible', async () => {
    process.env.RELEASE_GATING_ENABLED = 'false';
    try {
      const { db, release } = setup();
      expect(await release.visible(db, 'st-plain', KEY)).toBe(true);
    } finally {
      delete process.env.RELEASE_GATING_ENABLED;
    }
  });

  it('access: super administrators only; the person must exist; one live grant, replaced; audited; revocable', async () => {
    const { db, release } = setup();
    await expect(release.grantAccess('approver', { email: 'beta@example.com', tier: 'CONTROLLED', reason: 'Beta invite' }, NOW)).rejects.toThrow(/super administrator/);
    await expect(release.grantAccess('admin', { email: 'nobody@example.com', tier: 'CONTROLLED', reason: 'Beta invite' }, NOW)).rejects.toThrow(/sign in once first/);
    await expect(release.grantAccess('admin', { email: 'beta@example.com', tier: 'GENERAL', reason: 'Beta invite' }, NOW)).rejects.toThrow(/INTERNAL or CONTROLLED/);
    await expect(release.grantAccess('admin', { email: 'beta@example.com', tier: 'CONTROLLED', reason: 'x' }, NOW)).rejects.toThrow(/reason/);
    await release.grantAccess('admin', { email: 'beta@example.com', tier: 'CONTROLLED', reason: 'Beta invite' }, NOW);
    await expect(release.grantAccess('admin', { email: 'beta@example.com', tier: 'CONTROLLED', reason: 'Beta invite' }, NOW)).rejects.toThrow(/already have CONTROLLED/);
    expect(await release.grantAccess('admin', { email: 'beta@example.com', tier: 'INTERNAL', reason: 'Moved to alpha' }, NOW)).toMatchObject({ replaced: true });
    const list = await release.listAccess('admin');
    expect(list).toEqual([expect.objectContaining({ email: 'beta@example.com', tier: 'INTERNAL' })]);
    await release.revokeAccess('admin', list[0].id, NOW);
    expect(await release.listAccess('admin')).toEqual([]);
    expect(db.rows('audit_event').map((a: any) => a.action)).toEqual(['release.access_granted', 'release.access_granted', 'release.access_revoked']);
    // The operator CLI path: no account, an operator name instead.
    await expect(release.grantAccess(null, { email: 'beta@example.com', tier: 'CONTROLLED', reason: 'Beta wave 1' }, NOW)).rejects.toThrow(/operator/);
    await release.grantAccess(null, { email: 'beta@example.com', tier: 'CONTROLLED', reason: 'Beta wave 1' }, NOW, 'ops@example.com');
    expect(db.rows('audit_event').at(-1)).toMatchObject({ actor_account_id: null, metadata: { operator: 'ops@example.com' } });
  });
});

describe('ReadinessService: releasing a subject', () => {
  it('an approver releases one step at a time on a fresh passing report; every change is recorded', async () => {
    const { db, readiness, report, outbox } = setup();
    report('r1', ['INTERNAL']);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'INTERNAL', reportId: 'r1', note: 'Alpha content checked by the academic lead' }, NOW)).resolves.toEqual({ tier: 'INTERNAL' });
    expect(db.rows('subject_release')[0]).toMatchObject({ tier: 'INTERNAL', changed_by_account_id: 'approver' });
    expect(db.rows('subject_release_event')[0]).toMatchObject({ from_tier: 'FOUNDATION_ONLY', to_tier: 'INTERNAL', readiness_report_id: 'r1', approver_account_id: 'approver' });
    expect(db.rows('audit_event')[0]).toMatchObject({ action: 'release.promoted', metadata: { from: 'FOUNDATION_ONLY', to: 'INTERNAL', reportId: 'r1' } });
    expect(outbox.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'release.subject_tier_changed.v1' }));
    expect(await readiness.history('editor', 'sv1')).toEqual([expect.objectContaining({ from: 'FOUNDATION_ONLY', to: 'INTERNAL', approver: 'lead@example.com', reportId: 'r1' })]);
  });

  it('refuses editors, failing or stale reports, skipped tiers, and CONTROLLED on a provisional policy', async () => {
    const { readiness, report, signOffPolicy } = setup();
    report('pass-internal', ['INTERNAL']);
    report('fail', []);
    report('stale', ['INTERNAL', 'CONTROLLED', 'GENERAL'], { generated_at: hoursAgo(30) });
    report('pass-all', ['INTERNAL', 'CONTROLLED', 'GENERAL']);
    const note = 'Checked by the academic lead';
    await expect(readiness.changeTier('editor', 'sv1', { to: 'INTERNAL', reportId: 'pass-internal', note }, NOW)).rejects.toThrow(/Only an approver/);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'INTERNAL', reportId: 'fail', note }, NOW)).rejects.toThrow(/does not pass the INTERNAL checks/);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'INTERNAL', reportId: 'stale', note }, NOW)).rejects.toThrow(/24 hours/);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'CONTROLLED', reportId: 'pass-all', note }, NOW)).rejects.toThrow(/one step at a time/);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'INTERNAL', note }, NOW)).rejects.toThrow(/report is required/);
    await readiness.changeTier('approver', 'sv1', { to: 'INTERNAL', reportId: 'pass-all', note }, NOW);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'CONTROLLED', reportId: 'pass-all', note }, NOW)).rejects.toThrow(/signed off by an academic lead/);
    signOffPolicy();
    report('pass-all-signed', ['INTERNAL', 'CONTROLLED', 'GENERAL']);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'CONTROLLED', reportId: 'pass-all-signed', note }, NOW)).resolves.toEqual({ tier: 'CONTROLLED' });
  });

  it('a report for an older curriculum revision no longer counts once a correction is active', async () => {
    const { db, readiness, report } = setup();
    report('r1', ['INTERNAL']);
    db.rows('curriculum_subject_version')[0].state = 'SUPERSEDED';
    db.seed('curriculum_subject_version', [{ id: 'sv2', ...KEY, revision: 2, state: 'ACTIVE' }]);
    await expect(readiness.changeTier('approver', 'sv2', { to: 'INTERNAL', reportId: 'r1', note: 'Checked by the academic lead' }, NOW)).rejects.toThrow(/older curriculum revision/);
  });

  it('taking a subject away needs no report, only a note', async () => {
    const { db, readiness } = setup();
    db.seed('subject_release', [{ ...KEY, tier: 'GENERAL' }]);
    await expect(readiness.changeTier('approver', 'sv1', { to: 'FOUNDATION_ONLY', note: 'Wrong answers found in chapter 3' }, NOW)).resolves.toEqual({ tier: 'FOUNDATION_ONLY' });
    expect(db.rows('audit_event')[0].action).toBe('release.demoted');
  });

  it('the subject list shows the tier, the latest report, and a subject released further than its report supports', async () => {
    const { db, readiness, report } = setup();
    report('r1', ['INTERNAL']);
    db.seed('subject_release', [{ ...KEY, tier: 'CONTROLLED' }]);
    const [u] = await readiness.units('editor', NOW);
    expect(u).toMatchObject({ subjectVersionId: 'sv1', subjectName: 'Physics', tier: 'CONTROLLED', latestReport: { id: 'r1', highest: 'INTERNAL', current: true }, belowTier: true });
    await expect(readiness.units('student', NOW)).rejects.toThrow(/curriculum staff/);
  });
});

describe('ReadinessService: the policy', () => {
  it('sign-off names the academic lead and a reference, once, on the active policy only', async () => {
    const { db, readiness } = setup();
    await expect(readiness.signOff({ code: 'READINESS_V1', approverName: 'Dr', reference: 'Memo 7', operator: 'ops' })).rejects.toThrow(/name and a reference/);
    await readiness.signOff({ code: 'READINESS_V1', approverName: 'Dr A Lead', reference: 'Email of 16 Oct', operator: 'ops' }, NOW);
    expect(db.rows('readiness_policy_version')[0]).toMatchObject({ signed_off_by_name: 'Dr A Lead', signed_off_reference: 'Email of 16 Oct', signed_off_at: NOW });
    await expect(readiness.signOff({ code: 'READINESS_V1', approverName: 'Dr A Lead', reference: 'Again', operator: 'ops' })).rejects.toThrow(/already signed off/);
    expect((await readiness.policyView('editor')).signedOff).toMatchObject({ by: 'Dr A Lead' });
  });

  it('a new version replaces the active one, PROVISIONAL, and must be a valid policy', async () => {
    const { db, readiness } = setup();
    const { code: _c, ...params } = READINESS_V1;
    await expect(readiness.publishPolicy({ code: 'READINESS_V2', params: { ...params, objective: { limited: 9, assessmentReady: 8, robust: 12 } }, operator: 'ops' })).rejects.toThrow(/must not decrease/);
    await expect(readiness.publishPolicy({ code: 'READINESS_V1', params, operator: 'ops' })).rejects.toThrow(/already exists/);
    await readiness.publishPolicy({ code: 'READINESS_V2', params, notes: 'Academic lead changes', operator: 'ops' }, NOW);
    expect(db.rows('readiness_policy_version').map((p: any) => [p.code, p.status, p.signed_off_at ?? null])).toEqual([
      ['READINESS_V1', 'RETIRED', null],
      ['READINESS_V2', 'ACTIVE', null],
    ]);
    expect((await readiness.policyView('editor')).code).toBe('READINESS_V2');
  });
});
