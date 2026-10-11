import {
  evaluateProcessing,
  isAuthorityValid,
  type ConsentGrant,
  type GuardianAuthorityState,
} from './consent-evaluator';

const now = new Date('2026-10-11T12:00:00Z');
const earlier = new Date('2026-09-01T00:00:00Z');
const later = new Date('2026-10-01T00:00:00Z');

const grant = (over: Partial<ConsentGrant> = {}): ConsentGrant => ({
  id: 'g1',
  purposeCode: 'CORE_ASSESSMENT',
  capacity: 'GUARDIAN',
  guardianAuthorityId: 'a1',
  grantedAt: earlier,
  withdrawn: false,
  ...over,
});
const authority = (over: Partial<GuardianAuthorityState> = {}): GuardianAuthorityState => ({
  id: 'a1',
  revokedAt: null,
  verificationStatus: 'VERIFIED',
  verificationExpiresAt: null,
  ...over,
});
const run = (over: Partial<Parameters<typeof evaluateProcessing>[0]> = {}) =>
  evaluateProcessing({
    purposeCode: 'CORE_ASSESSMENT',
    requiresGuardianConsent: true,
    grants: [grant()],
    authorities: [authority()],
    now,
    ...over,
  });

describe('isAuthorityValid', () => {
  it('accepts an unrevoked, verified authority', () =>
    expect(isAuthorityValid(authority(), now)).toBe(true));
  it('rejects a missing authority', () => expect(isAuthorityValid(undefined, now)).toBe(false));
  it('rejects a revoked authority', () =>
    expect(isAuthorityValid(authority({ revokedAt: earlier }), now)).toBe(false));
  it('accepts an authority whose revocation is still in the future', () =>
    expect(isAuthorityValid(authority({ revokedAt: new Date('2027-01-01') }), now)).toBe(true));
  it.each(['PENDING', 'FAILED', 'EXPIRED'] as const)(
    'rejects a %s verification',
    (verificationStatus) =>
      expect(isAuthorityValid(authority({ verificationStatus }), now)).toBe(false),
  );
  it('rejects a verification that has lapsed', () =>
    expect(isAuthorityValid(authority({ verificationExpiresAt: earlier }), now)).toBe(false));
});

describe('evaluateProcessing when guardian consent is required', () => {
  it('allows with a valid guardian grant', () => {
    expect(run()).toEqual({ allowed: true, grantId: 'g1' });
  });

  it('denies with no grants at all', () => {
    expect(run({ grants: [] })).toEqual({ allowed: false, reason: 'NO_CONSENT' });
  });

  it('ignores grants for other purposes', () => {
    expect(run({ grants: [grant({ purposeCode: 'ANALYTICS' })] })).toEqual({
      allowed: false,
      reason: 'NO_CONSENT',
    });
  });

  it("does NOT accept the student's own consent", () => {
    const self = grant({ capacity: 'SELF', guardianAuthorityId: null });
    expect(run({ grants: [self], authorities: [] })).toEqual({
      allowed: false,
      reason: 'GUARDIAN_CONSENT_REQUIRED',
    });
  });

  it('denies once the only grant is withdrawn', () => {
    expect(run({ grants: [grant({ withdrawn: true })] })).toEqual({
      allowed: false,
      reason: 'CONSENT_WITHDRAWN',
    });
  });

  it('denies when the guardian authority was revoked', () => {
    expect(run({ authorities: [authority({ revokedAt: earlier })] })).toEqual({
      allowed: false,
      reason: 'GUARDIAN_AUTHORITY_INVALID',
    });
  });

  it('denies when the grant points at an unknown authority', () => {
    expect(run({ authorities: [] })).toEqual({
      allowed: false,
      reason: 'GUARDIAN_AUTHORITY_INVALID',
    });
  });

  it('denies a guardian grant with no authority id', () => {
    expect(run({ grants: [grant({ guardianAuthorityId: null })] })).toEqual({
      allowed: false,
      reason: 'GUARDIAN_AUTHORITY_INVALID',
    });
  });

  it('re-allows after a fresh valid grant follows a withdrawn one, citing the newest', () => {
    const grants = [grant({ id: 'old', withdrawn: true }), grant({ id: 'new', grantedAt: later })];
    expect(run({ grants })).toEqual({ allowed: true, grantId: 'new' });
  });

  it('picks the newest of several valid grants', () => {
    const grants = [grant({ id: 'a' }), grant({ id: 'b', grantedAt: later })];
    expect(run({ grants })).toEqual({ allowed: true, grantId: 'b' });
  });
});

describe('evaluateProcessing when guardian consent is NOT required', () => {
  const adult = { requiresGuardianConsent: false };

  it("accepts the student's own grant", () => {
    const self = grant({ capacity: 'SELF', guardianAuthorityId: null });
    expect(run({ ...adult, grants: [self], authorities: [] })).toEqual({
      allowed: true,
      grantId: 'g1',
    });
  });

  it('still honours withdrawal', () => {
    const self = grant({ capacity: 'SELF', guardianAuthorityId: null, withdrawn: true });
    expect(run({ ...adult, grants: [self], authorities: [] })).toEqual({
      allowed: false,
      reason: 'CONSENT_WITHDRAWN',
    });
  });

  it('does not count a guardian grant whose authority is invalid', () => {
    expect(run({ ...adult, authorities: [authority({ revokedAt: earlier })] })).toEqual({
      allowed: false,
      reason: 'GUARDIAN_AUTHORITY_INVALID',
    });
  });
});
