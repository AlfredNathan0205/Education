import { ForbiddenException } from '@nestjs/common';
import { memoryDb } from '../testing/memory-db';
import { MfaGuard } from './mfa.guard';
import { MfaService } from './mfa.service';
import { decryptSecret, hotp, mfaKey, stepAt } from './totp';

const T0 = new Date('2026-10-16T10:00:00Z');
const later = (s: number) => new Date(T0.getTime() + s * 1000);

function setup() {
  const db = memoryDb({ unique: { admin_mfa_recovery_code: [['code_hash']], admin_mfa_factor: [['account_id']] } });
  db.seed('role_assignment', [{ account_id: 'admin', role_id: 'r', revoked_at: null }]);
  db.seed('auth_session', [
    { id: 's1', account_id: 'admin', mfa_verified_at: null },
    { id: 's2', account_id: 'admin', mfa_verified_at: null },
    { id: 's3', account_id: 'student', mfa_verified_at: null },
  ]);
  const service = new MfaService({ client: db } as any);
  return { db, service };
}

/** The secret the service stored (as the person's app would hold it). */
function secretOf(db: any): string {
  return decryptSecret(db.rows('admin_mfa_factor')[0].secret_ciphertext, mfaKey({}));
}

async function enrolled() {
  const s = setup();
  await s.service.startEnrolment('admin', T0);
  const { recoveryCodes } = await s.service.confirmEnrolment('admin', 's1', hotp(secretOf(s.db), stepAt(T0)), T0);
  return { ...s, recoveryCodes };
}

describe('MfaService', () => {
  it('only accounts with a role need it or can set it up', async () => {
    const { service } = setup();
    expect(await service.check('student', 's3', T0)).toBe('NOT_PRIVILEGED');
    await expect(service.startEnrolment('student', T0)).rejects.toThrow(/administrator role/);
    expect(await service.check('admin', 's1', T0)).toBe('MFA_REQUIRED');
    expect(await service.status('admin', 's1', T0)).toEqual({ required: true, enrolled: false, pending: false, verified: false, recoveryCodesLeft: 0 });
  });

  it('set-up: a secret shown once, stored encrypted, confirmed by a first code; ten recovery codes; this session passes', async () => {
    const { db, service } = setup();
    const { secret, otpauthUri } = await service.startEnrolment('admin', T0);
    expect(otpauthUri).toContain(`secret=${secret}`);
    const stored = db.rows('admin_mfa_factor')[0];
    expect(stored.status).toBe('PENDING');
    expect(stored.secret_ciphertext).not.toContain(secret);
    await expect(service.confirmEnrolment('admin', 's1', '000000', T0)).rejects.toThrow(/did not work/);
    const { recoveryCodes } = await service.confirmEnrolment('admin', 's1', hotp(secret, stepAt(T0)), T0);
    expect(recoveryCodes).toHaveLength(10);
    expect(db.rows('admin_mfa_recovery_code')).toHaveLength(10);
    expect(JSON.stringify(db.rows('admin_mfa_recovery_code'))).not.toContain(recoveryCodes[0]);
    expect(db.rows('admin_mfa_factor')[0]).toMatchObject({ status: 'ACTIVE', activated_at: T0 });
    expect(await service.check('admin', 's1', T0)).toBe('OK');
    // Another session of the same person still has to pass the check.
    expect(await service.check('admin', 's2', T0)).toBe('MFA_REQUIRED');
    expect(db.rows('audit_event').map((a: any) => a.action)).toEqual(['mfa.enrolment_started', 'mfa.verify_failed', 'mfa.enrolled']);
  });

  it('starting again replaces an unconfirmed secret, but never an active one', async () => {
    const { db, service } = setup();
    const a = await service.startEnrolment('admin', T0);
    const b = await service.startEnrolment('admin', later(10));
    expect(a.secret).not.toBe(b.secret);
    expect(db.rows('admin_mfa_factor')).toHaveLength(1);
    await service.confirmEnrolment('admin', 's1', hotp(b.secret, stepAt(later(10))), later(10));
    await expect(service.startEnrolment('admin', later(20))).rejects.toThrow(/already set up/);
  });

  it('verify: a code from the app passes the session; the same code cannot be used again', async () => {
    const { db, service } = await enrolled();
    const now = later(60);
    const code = hotp(secretOf(db), stepAt(now));
    await expect(service.verify('admin', 's2', { code }, now)).resolves.toMatchObject({ verified: true, recoveryCodesLeft: 10 });
    expect(await service.check('admin', 's2', now)).toBe('OK');
    await expect(service.verify('admin', 's2', { code }, now)).rejects.toThrow(/did not work/);
    // The enrolment code (an earlier step) is refused too.
    await expect(service.verify('admin', 's2', { code: hotp(secretOf(db), stepAt(T0)) }, now)).rejects.toThrow(/did not work/);
  });

  it('a recovery code works once', async () => {
    const { service, recoveryCodes } = await enrolled();
    const now = later(120);
    await expect(service.verify('admin', 's2', { recoveryCode: recoveryCodes[3].toLowerCase() }, now)).resolves.toMatchObject({ recoveryCodesLeft: 9 });
    await expect(service.verify('admin', 's2', { recoveryCode: recoveryCodes[3] }, now)).rejects.toThrow(/did not work/);
    await expect(service.verify('admin', 's2', {}, now)).rejects.toThrow(/Enter the 6-digit code/);
  });

  it('five wrong codes in 15 minutes lock the check, even for a right code', async () => {
    const { db, service } = await enrolled();
    for (let i = 0; i < 5; i++) await expect(service.verify('admin', 's2', { code: '000000' }, later(30 + i))).rejects.toThrow(/did not work/);
    const now = later(40);
    await expect(service.verify('admin', 's2', { code: hotp(secretOf(db), stepAt(now)) }, now)).rejects.toThrow(/Too many wrong codes/);
    const after = later(30 + 15 * 60 + 5);
    await expect(service.verify('admin', 's2', { code: hotp(secretOf(db), stepAt(after)) }, after)).resolves.toMatchObject({ verified: true });
  });

  it('the check expires after MFA_SESSION_HOURS (12)', async () => {
    const { service } = await enrolled();
    expect(await service.check('admin', 's1', later(11 * 3600))).toBe('OK');
    expect(await service.check('admin', 's1', later(12 * 3600 + 1))).toBe('MFA_REQUIRED');
  });

  it('an operator reset removes the authenticator and ends the check on every session', async () => {
    const { db, service } = await enrolled();
    await expect(service.reset('admin', '  ')).rejects.toThrow(/operator/);
    await expect(service.reset('admin', 'ops@example.com', later(5))).resolves.toEqual({ removed: true });
    expect(db.rows('admin_mfa_factor')).toHaveLength(0);
    expect(await service.check('admin', 's1', later(6))).toBe('MFA_REQUIRED');
    expect(db.rows('audit_event').at(-1)).toMatchObject({ action: 'mfa.reset', actor_account_id: null, metadata: { operator: 'ops@example.com' } });
  });
});

describe('MfaGuard', () => {
  const ctx = (url: string, auth?: string) =>
    ({ getType: () => 'http', switchToHttp: () => ({ getRequest: () => ({ originalUrl: url, headers: auth ? { authorization: auth } : {} }) }) }) as any;
  const TOKEN = 'Bearer abcdefghijklmnopqrstuvwxyz';

  function guard(check: string, session: any = { accountId: 'a', sessionId: 's' }) {
    const identity = { authenticate: jest.fn(async () => session) };
    const mfa = { check: jest.fn(async () => check) };
    return { g: new MfaGuard(identity as any, mfa as any), identity, mfa };
  }

  it('leaves everything outside /admin alone', async () => {
    const { g, identity } = guard('MFA_REQUIRED');
    await expect(g.canActivate(ctx('/guardian/approvals', TOKEN))).resolves.toBe(true);
    expect(identity.authenticate).not.toHaveBeenCalled();
  });

  it('passes requests with no session or no role on to the route (401 or 403 there)', async () => {
    await expect(guard('MFA_REQUIRED').g.canActivate(ctx('/admin/analytics/metrics'))).resolves.toBe(true);
    await expect(guard('MFA_REQUIRED', null).g.canActivate(ctx('/admin/analytics/metrics', TOKEN))).resolves.toBe(true);
    await expect(guard('NOT_PRIVILEGED').g.canActivate(ctx('/admin/analytics/metrics', TOKEN))).resolves.toBe(true);
    await expect(guard('OK').g.canActivate(ctx('/admin/analytics/metrics', TOKEN))).resolves.toBe(true);
  });

  it('refuses a privileged session that has not passed the check, with the MFA_REQUIRED code', async () => {
    const { g } = guard('MFA_REQUIRED');
    const err = await g.canActivate(ctx('/admin/questions/units', TOKEN)).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ statusCode: 403, code: 'MFA_REQUIRED' });
  });
});
