import { InvalidDateOfBirthError, ageInFullYears, classifyAge } from './age-classification';
import { emptyPolicyConfig, type JurisdictionPolicyConfig } from './jurisdiction-policy';

/** Illustrative thresholds for tests only. NOT legal parameters for any real jurisdiction. */
const policy: JurisdictionPolicyConfig = {
  minorAgeThreshold: 18,
  guardianConsentAgeThreshold: 16,
  acceptedDobEvidenceMethods: ['SELF_DECLARED'],
  acceptedGuardianVerificationMethods: ['GUARDIAN_OTP'],
};
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);

describe('ageInFullYears', () => {
  it('counts a birthday only once reached', () => {
    expect(ageInFullYears(d('2012-10-12'), d('2026-10-11'))).toBe(13);
    expect(ageInFullYears(d('2012-10-11'), d('2026-10-11'))).toBe(14);
    expect(ageInFullYears(d('2012-10-10'), d('2026-10-11'))).toBe(14);
  });

  it('handles year boundaries', () => {
    expect(ageInFullYears(d('2012-12-31'), d('2026-01-01'))).toBe(13);
  });

  it('treats a 29 February birthday as reached on 1 March in a non-leap year', () => {
    expect(ageInFullYears(d('2012-02-29'), d('2026-02-28'))).toBe(13);
    expect(ageInFullYears(d('2012-02-29'), d('2026-03-01'))).toBe(14);
  });

  it('is exact on a leap-year birthday in a leap year', () => {
    expect(ageInFullYears(d('2012-02-29'), d('2028-02-29'))).toBe(16);
  });
});

describe('classifyAge with an established policy', () => {
  const asOf = d('2026-10-11');

  it('classifies a young student as a minor requiring guardian consent', () => {
    expect(classifyAge({ dateOfBirth: d('2013-03-01'), asOf, policy })).toEqual({
      ageYears: 13,
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'POLICY',
    });
  });

  it('separates the minor and guardian-consent thresholds', () => {
    expect(classifyAge({ dateOfBirth: d('2009-01-01'), asOf, policy })).toMatchObject({
      ageYears: 17,
      isMinor: true,
      requiresGuardianConsent: false,
      basis: 'POLICY',
    });
  });

  it('classifies an adult as neither', () => {
    expect(classifyAge({ dateOfBirth: d('2000-01-01'), asOf, policy })).toMatchObject({
      isMinor: false,
      requiresGuardianConsent: false,
      basis: 'POLICY',
    });
  });

  it('flips exactly on the threshold birthday', () => {
    expect(classifyAge({ dateOfBirth: d('2008-10-12'), asOf, policy }).isMinor).toBe(true); // 17, birthday tomorrow
    expect(classifyAge({ dateOfBirth: d('2008-10-11'), asOf, policy }).isMinor).toBe(false); // turns 18 today
  });
});

describe('classifyAge fails closed', () => {
  const asOf = d('2026-10-11');

  it('with no policy at all, even for an adult', () => {
    expect(classifyAge({ dateOfBirth: d('1990-01-01'), asOf, policy: null })).toMatchObject({
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'FAIL_CLOSED_NO_ACTIVE_POLICY',
    });
  });

  it('with a policy that has not established thresholds', () => {
    expect(
      classifyAge({ dateOfBirth: d('1990-01-01'), asOf, policy: emptyPolicyConfig() }),
    ).toMatchObject({
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'FAIL_CLOSED_INCOMPLETE_POLICY',
    });
  });

  it('with only one threshold established', () => {
    const half = { ...policy, guardianConsentAgeThreshold: null };
    expect(classifyAge({ dateOfBirth: d('1990-01-01'), asOf, policy: half }).basis).toBe(
      'FAIL_CLOSED_INCOMPLETE_POLICY',
    );
  });
});

describe('classifyAge input validation', () => {
  const asOf = d('2026-10-11');
  it('rejects a future date of birth', () => {
    expect(() => classifyAge({ dateOfBirth: d('2027-01-01'), asOf, policy })).toThrow(
      InvalidDateOfBirthError,
    );
  });
  it('rejects an invalid date', () => {
    expect(() => classifyAge({ dateOfBirth: new Date('nope'), asOf, policy })).toThrow(
      InvalidDateOfBirthError,
    );
  });
  it('rejects an implausibly old date of birth', () => {
    expect(() => classifyAge({ dateOfBirth: d('1800-01-01'), asOf, policy })).toThrow(
      InvalidDateOfBirthError,
    );
  });
});
