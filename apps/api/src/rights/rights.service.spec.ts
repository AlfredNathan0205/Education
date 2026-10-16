import { memoryDb } from '../testing/memory-db';
import { RetentionService } from './retention.service';
import { RightsService } from './rights.service';
import { parseTombstones } from './cli/tombstones';

const T0 = new Date('2026-10-16T10:00:00Z');
const days = (n: number) => new Date(T0.getTime() + n * 86_400_000);
const IDS = {
  aA: 'aaaaaaaa-0000-4000-8000-00000000000a', sA: 'aaaaaaaa-0000-4000-8000-0000000000a5',
  aM: 'bbbbbbbb-0000-4000-8000-00000000000b', sM: 'bbbbbbbb-0000-4000-8000-0000000000b5',
  aG: 'cccccccc-0000-4000-8000-00000000000c', aP: 'dddddddd-0000-4000-8000-00000000000d',
  aX: 'eeeeeeee-0000-4000-8000-00000000000e', sB: 'ffffffff-0000-4000-8000-0000000000f5',
};

function world() {
  const db = memoryDb({ unique: { deletion_tombstone: [['subject_type', 'subject_id']] } });
  const old = new Date('2026-01-01T00:00:00Z');
  db.seed('account', [IDS.aA, IDS.aM, IDS.aG, IDS.aP, IDS.aX].map((id) => ({ id, status: 'ACTIVE', created_at: old, erased_at: null, last_sign_in_at: old, inactive_flagged_at: null })));
  db.seed('student', [
    { id: IDS.sA, display_name: 'Asha', erased_at: null },
    { id: IDS.sM, display_name: 'Kiran', erased_at: null },
    { id: IDS.sB, display_name: 'Bo', erased_at: null },
  ]);
  db.seed('account_student_access', [
    { account_id: IDS.aA, student_id: IDS.sA, access_kind: 'SELF', revoked_at: null },
    { account_id: IDS.aM, student_id: IDS.sM, access_kind: 'SELF', revoked_at: null },
  ]);
  db.seed('authentication_identity', [
    { account_id: IDS.aA, kind: 'EMAIL', identifier_normalized: 'asha@example.com' },
    { account_id: IDS.aM, kind: 'EMAIL', identifier_normalized: 'kiran@example.com' },
    { account_id: IDS.aP, kind: 'EMAIL', identifier_normalized: 'parent@example.com' },
  ]);
  db.seed('auth_session', [
    { account_id: IDS.aA, token_hash: 'h1', created_at: old, expires_at: days(10), revoked_at: null, last_seen_at: null },
    { account_id: IDS.aM, token_hash: 'h2', created_at: old, expires_at: days(10), revoked_at: null, last_seen_at: null },
  ]);
  db.seed('otp_challenge', [{ identifier_normalized: 'asha@example.com', code_hash: 'c', expires_at: old }]);
  db.seed('age_classification', [
    { student_id: IDS.sA, date_of_birth: new Date('2000-05-05'), is_minor: false, superseded_at: null },
    { student_id: IDS.sM, date_of_birth: new Date('2013-05-05'), is_minor: true, superseded_at: null },
  ]);
  db.seed('student_academic_context', [{ student_id: IDS.sA, curriculum_code: 'ICSE', grade_code: 'GRADE_8' }]);
  db.seed('student_school_association', [{ student_id: IDS.sA, school_id: 'sch', state: 'ACTIVE', ended_at: null }]);
  db.seed('consent_record', [{ id: 'cr-a', student_id: IDS.sA, granted_by_account_id: IDS.aA, capacity: 'SELF' }]);
  db.seed('assessment_session', [{ id: 'sess-a', student_id: IDS.sA }]);
  db.seed('student_response', [{ session_id: 'sess-a', selected_slot: 2, is_correct: true, idempotency_key: 'k-secret' }]);
  db.seed('assessment_instance', [{ student_id: IDS.sA, seed: 'seed-secret', assembly_report: { x: 1 }, blueprint_code: 'QUICK10' }]);
  db.seed('assessment_result', [{ student_id: IDS.sA, session_id: 'sess-a', total: 10, correct: 7 }]);
  db.seed('cp_event', [{ student_id: IDS.sA, amount: 40, earned_at: T0 }]);
  db.seed('xp_event', [{ student_id: IDS.sA, amount: BigInt(12), earned_at: T0 }]);
  db.seed('student_mastery_state', [{ student_id: IDS.sA, objective_path: 'P/1', label: 'SECURE' }]);
  db.seed('public_profile', [{ student_id: IDS.sA, handle: 'BrightOwl42', shown_to_others: true }]);
  db.seed('friend_code', [{ student_id: IDS.sA, code: 'ABC123', expires_at: T0, used_by_student_id: null }]);
  db.seed('friend_code_attempt', [{ student_id: IDS.sA, ok: false, at: T0 }]);
  db.seed('friendship', [{ id: 'fr-1', student_low: IDS.sA, student_high: IDS.sB, status: 'ACTIVE', ended_at: null }]);
  db.seed('challenge', [{ id: 'ch-1', challenger_student_id: IDS.sB, opponent_student_id: IDS.sA, status: 'PENDING' }]);
  db.seed('student_block', [{ blocker_student_id: IDS.sB, blocked_student_id: IDS.sA }]);
  db.seed('subscription', [{ id: 'sub-1', student_id: IDS.sA, source: 'BETA', status: 'ACTIVE', ended_at: null }]);
  db.seed('entitlement_grant', [{ id: 'g-1', student_id: IDS.sA, reason: 'Asha asked at the school fair', revoked_at: null, revoked_by_account_id: null }]);
  db.seed('parent_share_invitation', [{ student_id: IDS.sA, email_normalized: 'parent@example.com', token_hash: 't', status: 'ACCEPTED', accepted_by_account_id: IDS.aP }]);
  db.seed('parent_view_grant', [{ id: 'pv-1', student_id: IDS.sA, viewer_account_id: IDS.aP, consent_record_id: 'cr-share', ended_at: null }]);
  db.seed('student_report', [{ student_id: IDS.sA, week_start: T0 }]);
  db.seed('guardian_relationship', [{ id: 'rel-m', guardian_account_id: IDS.aG, student_id: IDS.sM, status: 'VERIFIED' }]);
  db.seed('guardian_authority', [{ id: 'auth-m', guardian_relationship_id: 'rel-m', revoked_at: null }]);
  db.seed('guardian_invitation', [{ student_id: IDS.sM, guardian_email_normalized: 'mum@example.com', token_hash: 't2' }]);
  db.seed('role_assignment', [{ account_id: IDS.aX, role_id: 'r', revoked_at: null }]);

  // The guardian G approves the minor M. Other services are mocked: their own tests cover them.
  const privacy = {
    listGuardianApprovals: jest.fn(async (acct: string) => (acct === IDS.aG ? [{ consentRecordId: 'cr-m', studentId: IDS.sM, displayName: 'Kiran', label: 'Kiran', grantedAt: T0 }] : [])),
    withdrawAllForErasure: jest.fn(async () => 1),
  };
  const analytics = { forget: jest.fn(async () => 3), heldFor: jest.fn(async () => 5) };
  const outbox = { publish: jest.fn(async () => undefined) };
  const rights = new RightsService({ client: db } as any, privacy as any, analytics as any, outbox as any);
  return { db, rights, privacy, analytics, outbox };
}

describe('RightsService: what each person may do', () => {
  it('an adult student may export and delete; a minor is sent to their guardian', async () => {
    const { rights } = world();
    expect(await rights.overview(IDS.aA, T0)).toMatchObject({ waitDays: 14, me: { subjectType: 'STUDENT', erasure: null, block: null }, children: [] });
    expect(await rights.overview(IDS.aM, T0)).toMatchObject({ me: { block: 'MINOR_ASKS_GUARDIAN', blockMessage: expect.stringMatching(/parent or guardian/) } });
  });

  it('a guardian sees each child they approve; they cannot delete themselves while they approve one', async () => {
    const { rights } = world();
    const o = await rights.overview(IDS.aG, T0);
    expect(o.me).toMatchObject({ subjectType: 'ACCOUNT', block: 'GUARDIAN_OF_CHILDREN' });
    expect(o.children).toEqual([{ studentId: IDS.sM, label: 'Kiran', erasure: null }]);
    await expect(rights.requestErasure(IDS.aG, null, T0)).rejects.toThrow(/approve a child/);
  });

  it('an administrator cannot delete their own account', async () => {
    const { rights } = world();
    await expect(rights.requestErasure(IDS.aX, null, T0)).rejects.toThrow(/administrator role/);
  });
});

describe('RightsService: export', () => {
  it("an adult's copy has their data as stored, without secrets, with other people's addresses masked, and is audited", async () => {
    const { db, rights } = world();
    const b: any = await rights.exportFor(IDS.aA, null, T0);
    expect(b).toMatchObject({ format: 'exam-app-export/v1', about: 'STUDENT', student: { id: IDS.sA, display_name: 'Asha' }, counts: { friendships: 1, challenges: 0, analyticsEvents: 5 } });
    expect(b.accounts[0].identities[0]).toMatchObject({ identifier_normalized: 'asha@example.com' });
    expect(b.tables.assessment_result).toHaveLength(1);
    expect(b.tables.student_response[0]).toMatchObject({ selected_slot: 2, is_correct: true });
    expect(b.tables.xp_event[0].amount).toBe('12');
    expect(b.tables.parent_share_invitation[0].email_normalized).toBe('p•••@example.com');
    const text = JSON.stringify(b);
    for (const secret of ['k-secret', 'seed-secret', 'token_hash', 'code_hash', 'parent@example.com', '"h1"']) expect(text).not.toContain(secret);
    expect(db.rows('privacy_request')).toEqual([expect.objectContaining({ kind: 'EXPORT', status: 'COMPLETED', capacity: 'SELF', subject_id: IDS.sA })]);
    expect(db.rows('audit_event')).toEqual([expect.objectContaining({ action: 'privacy.export.downloaded', actor_account_id: IDS.aA, subject_id: IDS.sA })]);
  });

  it('three copies a day, then a polite refusal', async () => {
    const { rights } = world();
    for (let i = 0; i < 3; i++) await rights.exportFor(IDS.aA, null, T0);
    await expect(rights.exportFor(IDS.aA, null, T0)).rejects.toThrow(/3 times a day/);
    await expect(rights.exportFor(IDS.aA, null, days(1.01))).resolves.toBeDefined();
  });

  it("a guardian downloads a child's copy; nobody else can", async () => {
    const { rights } = world();
    const b: any = await rights.exportFor(IDS.aG, IDS.sM, T0);
    expect(b).toMatchObject({ about: 'STUDENT', student: { id: IDS.sM } });
    expect(b.tables.guardian_invitation[0].guardian_email_normalized).toBe('m•••@example.com');
    await expect(rights.exportFor(IDS.aP, IDS.sM, T0)).rejects.toThrow('Not found');
    await expect(rights.exportFor(IDS.aA, IDS.sM, T0)).rejects.toThrow('Not found');
  });

  it("a parent's own copy is about their account", async () => {
    const { rights } = world();
    const b: any = await rights.exportFor(IDS.aP, null, T0);
    expect(b).toMatchObject({ about: 'ACCOUNT', accounts: [{ identities: [{ identifier_normalized: 'parent@example.com' }] }] });
    expect(b.tables.parent_view_grant).toHaveLength(1);
  });
});

describe('RightsService: erasure requests', () => {
  it('waits 14 days, can be cancelled, and asking twice returns the same request', async () => {
    const { db, rights, outbox } = world();
    const r = await rights.requestErasure(IDS.aA, null, T0);
    expect(r.dueAt).toBe(days(14).toISOString());
    expect(await rights.requestErasure(IDS.aA, null, T0)).toEqual(r);
    expect((await rights.overview(IDS.aA, T0)).me.erasure).toMatchObject({ requestId: r.requestId, canCancel: true });
    expect(outbox.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'privacy.erasure.requested.v1' }));
    await expect(rights.cancelErasure(IDS.aP, r.requestId, T0)).rejects.toThrow('Not found');
    await expect(rights.cancelErasure(IDS.aA, r.requestId, days(1))).resolves.toEqual({ cancelled: true });
    await expect(rights.cancelErasure(IDS.aA, r.requestId, days(1))).rejects.toThrow(/already cancelled/);
    expect(db.rows('privacy_request')[0]).toMatchObject({ status: 'CANCELLED', cancelled_by_account_id: IDS.aA });
    expect(await rights.runDue(days(15))).toEqual({ completed: 0, failed: 0 });
    expect(db.rows('student').find((s: any) => s.id === IDS.sA).display_name).toBe('Asha');
  });

  it("a guardian asks for a minor; the minor's own account cannot cancel it", async () => {
    const { rights } = world();
    const r = await rights.requestErasure(IDS.aG, IDS.sM, T0);
    expect((await rights.overview(IDS.aG, T0)).children[0].erasure).toMatchObject({ requestId: r.requestId });
    await expect(rights.cancelErasure(IDS.aM, r.requestId, T0)).rejects.toThrow('Not found');
  });
});

describe('RightsService: the erasure saga', () => {
  async function erased() {
    const w = world();
    await w.rights.requestErasure(IDS.aA, null, T0);
    expect(await w.rights.runDue(days(13.9))).toEqual({ completed: 0, failed: 0 });
    expect(await w.rights.runDue(days(14))).toEqual({ completed: 1, failed: 0 });
    return w;
  }

  it('deletes the personal data of the student and their account', async () => {
    const { db } = await erased();
    const by = (t: string, f: (r: any) => boolean) => db.rows(t).filter(f);
    expect(by('authentication_identity', (r) => r.account_id === IDS.aA)).toHaveLength(0);
    expect(by('auth_session', (r) => r.account_id === IDS.aA)).toHaveLength(0);
    expect(by('otp_challenge', (r) => r.identifier_normalized === 'asha@example.com')).toHaveLength(0);
    expect(by('age_classification', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('student_school_association', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('public_profile', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('friend_code', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('friend_code_attempt', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('student_block', (r) => r.blocked_student_id === IDS.sA)).toHaveLength(0);
    expect(by('parent_share_invitation', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('parent_view_grant', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('student_report', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(by('account_student_access', (r) => r.student_id === IDS.sA)).toHaveLength(0);
    expect(db.rows('student').find((s: any) => s.id === IDS.sA)).toMatchObject({ display_name: null, erased_at: days(14) });
    expect(db.rows('account').find((a: any) => a.id === IDS.aA)).toMatchObject({ status: 'CLOSED', erased_at: days(14), last_sign_in_at: null });
    expect(db.rows('entitlement_grant')[0]).toMatchObject({ reason: 'Erased', revoked_at: days(14), revoked_by_account_id: IDS.aA });
  });

  it('keeps learning records under the now-anonymous student id, and ends what involved others', async () => {
    const { db, privacy, analytics, outbox } = await erased();
    expect(db.rows('assessment_result')).toHaveLength(1);
    expect(db.rows('cp_event')).toHaveLength(1);
    expect(db.rows('student_mastery_state')).toHaveLength(1);
    expect(db.rows('student_academic_context')).toHaveLength(1);
    expect(db.rows('consent_record')).toHaveLength(1);
    expect(privacy.withdrawAllForErasure).toHaveBeenCalledWith({ studentId: IDS.sA, actorAccountId: IDS.aA }, expect.anything(), days(14));
    expect(analytics.forget).toHaveBeenCalledWith(IDS.sA, expect.anything());
    expect(db.rows('friendship')[0]).toMatchObject({ status: 'ENDED', ended_reason: 'ERASED', ended_by_student_id: IDS.sA });
    expect(db.rows('challenge')[0].status).toBe('CANCELLED');
    expect(db.rows('subscription')[0]).toMatchObject({ status: 'ENDED', ended_reason: 'ERASED' });
    expect(db.rows('subscription_event')[0]).toMatchObject({ type: 'ENDED', reason: 'Erased' });
    expect(db.rows('deletion_tombstone')).toEqual([expect.objectContaining({ subject_type: 'STUDENT', subject_id: IDS.sA, account_ids: [IDS.aA] })]);
    expect(db.rows('privacy_request')[0]).toMatchObject({ status: 'COMPLETED', completed_at: days(14) });
    expect(db.rows('audit_event').map((a: any) => a.action)).toContain('privacy.erasure.completed');
    expect(outbox.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'privacy.erased.v1' }));
    // Other people's data is untouched.
    expect(db.rows('authentication_identity').map((i: any) => i.identifier_normalized).sort()).toEqual(['kiran@example.com', 'parent@example.com']);
    expect(db.rows('student').find((s: any) => s.id === IDS.sB).display_name).toBe('Bo');
  });

  it("a guardian's erasure of a minor ends the guardian link but keeps it as consent evidence", async () => {
    const { db, rights, privacy } = world();
    await rights.requestErasure(IDS.aG, IDS.sM, T0);
    expect(await rights.runDue(days(14))).toEqual({ completed: 1, failed: 0 });
    expect(db.rows('guardian_relationship')[0]).toMatchObject({ status: 'REVOKED' });
    expect(db.rows('guardian_authority')[0].revoked_at).toEqual(days(14));
    expect(db.rows('guardian_invitation')).toHaveLength(0);
    expect(db.rows('account').find((a: any) => a.id === IDS.aM)).toMatchObject({ status: 'CLOSED' });
    expect(db.rows('account').find((a: any) => a.id === IDS.aG)).toMatchObject({ status: 'ACTIVE' });
    expect(privacy.withdrawAllForErasure).toHaveBeenCalledWith({ studentId: IDS.sM, actorAccountId: IDS.aG }, expect.anything(), days(14));
  });

  it('checks again when it runs: a guardian who no longer approves the child cannot erase them', async () => {
    const { db, rights, privacy } = world();
    await rights.requestErasure(IDS.aG, IDS.sM, T0);
    privacy.listGuardianApprovals.mockResolvedValue([]);
    expect(await rights.runDue(days(14))).toEqual({ completed: 0, failed: 1 });
    expect(db.rows('privacy_request')[0]).toMatchObject({ status: 'FAILED', failure_code: 'GUARDIAN_NO_LONGER_APPROVES' });
    expect(db.rows('student').find((s: any) => s.id === IDS.sM).display_name).toBe('Kiran');
  });

  it('a parent erases their own account: their view of a student ends and that sharing consent is withdrawn', async () => {
    const { db, rights, privacy } = world();
    await rights.requestErasure(IDS.aP, null, T0);
    expect(await rights.runDue(days(14))).toEqual({ completed: 1, failed: 0 });
    expect(db.rows('parent_view_grant')).toHaveLength(0);
    expect(db.rows('parent_share_invitation')).toHaveLength(0);
    expect(privacy.withdrawAllForErasure).toHaveBeenCalledWith({ consentRecordIds: ['cr-share'], actorAccountId: IDS.aP }, expect.anything(), days(14));
    expect(db.rows('account').find((a: any) => a.id === IDS.aP)).toMatchObject({ status: 'CLOSED' });
  });

  it('a failure rolls the whole erasure back and is retried, then marked FAILED after 5 attempts', async () => {
    const { db, rights, analytics } = world();
    await rights.requestErasure(IDS.aA, null, T0);
    analytics.forget.mockRejectedValue(Object.assign(new Error('boom'), { name: 'BoomError' }));
    for (let i = 0; i < 4; i++) expect(await rights.runDue(days(14 + i))).toEqual({ completed: 0, failed: 1 });
    expect(db.rows('privacy_request')[0]).toMatchObject({ status: 'PENDING', attempts: 4, failure_code: 'BoomError' });
    expect(db.rows('authentication_identity').some((i: any) => i.account_id === IDS.aA)).toBe(true);
    await rights.runDue(days(20));
    expect(db.rows('privacy_request')[0]).toMatchObject({ status: 'FAILED', attempts: 5 });
  });

  it('a crashed run is picked up again once its one-hour lease is over', async () => {
    const { db, rights } = world();
    await rights.requestErasure(IDS.aA, null, T0);
    Object.assign(db.rows('privacy_request')[0], { status: 'RUNNING', due_at: days(14) });
    expect(await rights.runDue(days(14))).toEqual({ completed: 1, failed: 0 });
  });

  it('ERASURE_ENABLED=false stops the saga (requests still wait)', async () => {
    const { rights } = world();
    await rights.requestErasure(IDS.aA, null, T0);
    process.env.ERASURE_ENABLED = 'false';
    try {
      expect(await rights.runDue(days(15))).toEqual({ completed: 0, failed: 0 });
    } finally {
      delete process.env.ERASURE_ENABLED;
    }
    expect(await rights.runDue(days(15))).toEqual({ completed: 1, failed: 0 });
  });

  it('after a backup restore, the exported tombstones apply the erasure again', async () => {
    const { db, rights } = await erased();
    const lines = (await rights.tombstones()).map((t) => JSON.stringify(t)).join('\n');
    // Simulate a restore of the old rows.
    db.seed('authentication_identity', [{ account_id: IDS.aA, kind: 'EMAIL', identifier_normalized: 'asha@example.com' }]);
    db.seed('account_student_access', [{ account_id: IDS.aA, student_id: IDS.sA, access_kind: 'SELF', revoked_at: null }]);
    db.seed('age_classification', [{ student_id: IDS.sA, date_of_birth: new Date('2000-05-05'), is_minor: false, superseded_at: null }]);
    Object.assign(db.rows('student').find((s: any) => s.id === IDS.sA), { display_name: 'Asha', erased_at: null });
    Object.assign(db.rows('account').find((a: any) => a.id === IDS.aA), { status: 'ACTIVE', erased_at: null });
    db.rows('deletion_tombstone').length = 0;
    const list = parseTombstones(`${lines}\n\n`);
    expect(await rights.reapply([...list, { subjectType: 'STUDENT', subjectId: '99999999-0000-4000-8000-000000000099' }], days(30))).toEqual({ applied: 1, skipped: 1 });
    expect(db.rows('authentication_identity').some((i: any) => i.account_id === IDS.aA)).toBe(false);
    expect(db.rows('age_classification').some((r: any) => r.student_id === IDS.sA)).toBe(false);
    expect(db.rows('student').find((s: any) => s.id === IDS.sA).display_name).toBeNull();
    expect(db.rows('account').find((a: any) => a.id === IDS.aA).status).toBe('CLOSED');
    expect(db.rows('deletion_tombstone')).toHaveLength(1);
    expect(() => parseTombstones('{"subjectType":"X","subjectId":"1"}')).toThrow(/not a tombstone/);
    expect(() => parseTombstones('nope')).toThrow(/not JSON/);
  });

  it('tombstones hold ids only: no email, number or name', async () => {
    const { db } = await erased();
    const text = JSON.stringify(db.rows('deletion_tombstone'));
    expect(text).not.toMatch(/@|Asha|asha/);
  });
});

describe('RetentionService', () => {
  const NOW = new Date('2027-12-01T00:00:00Z');
  const ago = (d: number) => new Date(NOW.getTime() - d * 86_400_000);

  function setup() {
    const db = memoryDb();
    db.seed('otp_challenge', [{ expires_at: ago(91) }, { expires_at: ago(89) }]);
    db.seed('auth_session', [
      { expires_at: ago(91), revoked_at: null },
      { expires_at: ago(10), revoked_at: ago(95) },
      { expires_at: ago(80), revoked_at: null },
    ]);
    db.seed('friend_code', [{ expires_at: ago(31) }, { expires_at: ago(1) }]);
    db.seed('friend_code_attempt', [{ at: ago(31) }, { at: ago(29) }]);
    db.seed('analytics_event', [{ occurred_at: new Date('2026-10-31T00:00:00Z') }, { occurred_at: new Date('2026-11-02T00:00:00Z') }]);
    db.seed('outbox_event', [
      { created_at: ago(100), published_at: ago(100) },
      { created_at: ago(100), published_at: null },
      { created_at: ago(50), published_at: ago(50) },
    ]);
    db.seed('account', [
      { id: 'old-idle', created_at: new Date('2024-01-01'), last_sign_in_at: new Date('2025-11-30'), erased_at: null, inactive_flagged_at: null },
      { id: 'old-active', created_at: new Date('2024-01-01'), last_sign_in_at: new Date('2026-01-01'), erased_at: null, inactive_flagged_at: null },
      { id: 'never', created_at: new Date('2025-01-01'), last_sign_in_at: null, erased_at: null, inactive_flagged_at: null },
      { id: 'erased', created_at: new Date('2024-01-01'), last_sign_in_at: null, erased_at: new Date('2026-01-01'), inactive_flagged_at: null },
    ]);
    return { db, retention: new RetentionService({ client: db } as any) };
  }

  it('deletes what outlived its period, flags inactive accounts, and records the run', async () => {
    const { db, retention } = setup();
    const counts = await retention.run(NOW);
    expect(counts).toEqual({ otpChallenges: 1, sessions: 2, friendCodes: 1, friendCodeAttempts: 1, analyticsEvents: 1, outboxEvents: 1, inactiveFlagged: 2 });
    expect(db.rows('outbox_event').map((o: any) => o.published_at === null)).toEqual([true, false]);
    expect(db.rows('account').filter((a: any) => a.inactive_flagged_at).map((a: any) => a.id).sort()).toEqual(['never', 'old-idle']);
    expect(db.rows('retention_run')[0]).toMatchObject({ ok: true, counts });
    expect(db.rows('audit_event')[0]).toMatchObject({ action: 'retention.run', metadata: counts });
    // A second run finds nothing more.
    expect(await retention.run(NOW)).toMatchObject({ otpChallenges: 0, sessions: 0, inactiveFlagged: 0 });
  });

  it('never deletes outbox events analytics has not read yet', async () => {
    const { db, retention } = setup();
    db.seed('analytics_cursor', [{ id: 'outbox', last_created_at: ago(120) }]);
    expect((await retention.run(NOW))!.outboxEvents).toBe(0);
  });

  it('RETENTION_ENABLED=false does nothing', async () => {
    const { db, retention } = setup();
    process.env.RETENTION_ENABLED = 'false';
    try {
      expect(await retention.run(NOW)).toBeNull();
    } finally {
      delete process.env.RETENTION_ENABLED;
    }
    expect(db.rows('otp_challenge')).toHaveLength(2);
  });
});
