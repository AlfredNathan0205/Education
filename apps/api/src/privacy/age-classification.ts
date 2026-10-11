import { hasThresholds, type JurisdictionPolicyConfig } from './jurisdiction-policy';

export type ClassificationBasis =
  'POLICY' | 'FAIL_CLOSED_NO_ACTIVE_POLICY' | 'FAIL_CLOSED_INCOMPLETE_POLICY';

export interface AgeClassificationResult {
  ageYears: number;
  isMinor: boolean;
  requiresGuardianConsent: boolean;
  basis: ClassificationBasis;
}

export class InvalidDateOfBirthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidDateOfBirthError';
  }
}

const MAX_PLAUSIBLE_AGE_YEARS = 120;

/**
 * Whole years between a date of birth and a reference date, using UTC calendar
 * fields. A 29 February birthday counts as reached on 1 March in non-leap
 * years, which errs towards the younger (more protected) reading.
 */
export function ageInFullYears(dateOfBirth: Date, asOf: Date): number {
  let years = asOf.getUTCFullYear() - dateOfBirth.getUTCFullYear();
  const monthDiff = asOf.getUTCMonth() - dateOfBirth.getUTCMonth();
  const dayDiff = asOf.getUTCDate() - dateOfBirth.getUTCDate();
  if (monthDiff < 0 || (monthDiff === 0 && dayDiff < 0)) years -= 1;
  return years;
}

/**
 * Classify a student by age under a jurisdiction policy.
 *
 * Fails closed: with no policy, or a policy that has not established both
 * thresholds, the student is treated as a minor who requires guardian consent.
 * The conservative answer therefore never depends on the unresolved legal answer.
 */
export function classifyAge(input: {
  dateOfBirth: Date;
  asOf: Date;
  policy: JurisdictionPolicyConfig | null;
}): AgeClassificationResult {
  const { dateOfBirth, asOf, policy } = input;

  if (Number.isNaN(dateOfBirth.getTime())) {
    throw new InvalidDateOfBirthError('date of birth is not a valid date');
  }
  if (dateOfBirth.getTime() > asOf.getTime()) {
    throw new InvalidDateOfBirthError('date of birth is in the future');
  }
  const ageYears = ageInFullYears(dateOfBirth, asOf);
  if (ageYears > MAX_PLAUSIBLE_AGE_YEARS) {
    throw new InvalidDateOfBirthError('date of birth is implausibly old');
  }

  if (policy === null) {
    return {
      ageYears,
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'FAIL_CLOSED_NO_ACTIVE_POLICY',
    };
  }
  if (!hasThresholds(policy)) {
    return {
      ageYears,
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'FAIL_CLOSED_INCOMPLETE_POLICY',
    };
  }

  return {
    ageYears,
    isMinor: ageYears < (policy.minorAgeThreshold as number),
    requiresGuardianConsent: ageYears < (policy.guardianConsentAgeThreshold as number),
    basis: 'POLICY',
  };
}
