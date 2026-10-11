import {
  PolicyActivationError,
  PolicyConfigError,
  assertPolicyActivatable,
  emptyPolicyConfig,
  hasThresholds,
  parsePolicyConfig,
  type JurisdictionPolicyConfig,
} from './jurisdiction-policy';

/** Illustrative values for tests only. NOT legal parameters for any real jurisdiction. */
const complete = (): JurisdictionPolicyConfig => ({
  minorAgeThreshold: 18,
  guardianConsentAgeThreshold: 16,
  acceptedDobEvidenceMethods: ['SELF_DECLARED'],
  acceptedGuardianVerificationMethods: ['GUARDIAN_OTP'],
});

describe('parsePolicyConfig', () => {
  it('accepts a complete config', () => {
    expect(parsePolicyConfig(complete())).toEqual(complete());
  });

  it('accepts an empty config (nothing established yet)', () => {
    expect(parsePolicyConfig(emptyPolicyConfig())).toEqual(emptyPolicyConfig());
  });

  it('de-duplicates methods', () => {
    const cfg = { ...complete(), acceptedDobEvidenceMethods: ['SELF_DECLARED', 'SELF_DECLARED'] };
    expect(parsePolicyConfig(cfg).acceptedDobEvidenceMethods).toEqual(['SELF_DECLARED']);
  });

  it.each([
    ['non-object', 'x'],
    ['array', []],
    ['null', null],
  ])('rejects %s', (_label, raw) => {
    expect(() => parsePolicyConfig(raw)).toThrow(PolicyConfigError);
  });

  it('rejects unknown keys (catches typos like minorAgeThreshhold)', () => {
    expect(() => parsePolicyConfig({ ...complete(), minorAgeThreshhold: 18 })).toThrow(
      /unknown config key/,
    );
  });

  it('rejects missing keys', () => {
    const { minorAgeThreshold: _omit, ...rest } = complete();
    expect(() => parsePolicyConfig(rest)).toThrow(/missing config key: minorAgeThreshold/);
  });

  it.each([[0], [31], [17.5], ['18']])('rejects invalid threshold %p', (bad) => {
    expect(() => parsePolicyConfig({ ...complete(), minorAgeThreshold: bad })).toThrow(
      PolicyConfigError,
    );
  });

  it('rejects method codes that are not UPPER_SNAKE_CASE', () => {
    expect(() =>
      parsePolicyConfig({ ...complete(), acceptedDobEvidenceMethods: ['self declared'] }),
    ).toThrow(PolicyConfigError);
  });
});

describe('hasThresholds', () => {
  it('is false for an empty config and when only one threshold is set', () => {
    expect(hasThresholds(emptyPolicyConfig())).toBe(false);
    expect(hasThresholds({ ...complete(), guardianConsentAgeThreshold: null })).toBe(false);
  });
  it('is true when both are set', () => expect(hasThresholds(complete())).toBe(true));
});

describe('assertPolicyActivatable (the legal gate)', () => {
  const ok = {
    legalReview: 'COUNSEL_REVIEWED' as const,
    legalReviewReference: 'memo-2026-11',
    config: complete(),
  };

  it('passes for a counsel-reviewed, fully established policy', () => {
    expect(() => assertPolicyActivatable(ok)).not.toThrow();
  });

  it('refuses an unreviewed policy even when every parameter is filled in', () => {
    expect(() => assertPolicyActivatable({ ...ok, legalReview: 'UNREVIEWED' })).toThrow(
      /not COUNSEL_REVIEWED/,
    );
  });

  it.each([[null], [''], ['   ']])('refuses a missing review reference %p', (ref) => {
    expect(() => assertPolicyActivatable({ ...ok, legalReviewReference: ref })).toThrow(
      /reference is missing/,
    );
  });

  it('refuses an empty config and lists every unmet condition', () => {
    try {
      assertPolicyActivatable({
        ...ok,
        legalReview: 'UNREVIEWED',
        legalReviewReference: null,
        config: emptyPolicyConfig(),
      });
      throw new Error('expected to throw');
    } catch (e) {
      expect(e).toBeInstanceOf(PolicyActivationError);
      expect((e as PolicyActivationError).reasons).toHaveLength(6);
    }
  });

  it('refuses a guardian threshold above the minor threshold', () => {
    const config = { ...complete(), minorAgeThreshold: 16, guardianConsentAgeThreshold: 18 };
    expect(() => assertPolicyActivatable({ ...ok, config })).toThrow(/cannot exceed/);
  });

  it('refuses a policy that lists no accepted methods', () => {
    const config = {
      ...complete(),
      acceptedDobEvidenceMethods: [],
      acceptedGuardianVerificationMethods: [],
    };
    expect(() => assertPolicyActivatable({ ...ok, config })).toThrow(
      /no accepted DOB evidence methods/,
    );
  });
});
