import type { StudentProfile } from './client-api';

export type ProfileStep = 'DOB' | 'GUARDIAN_NEEDED' | 'NAME' | 'READY';

/**
 * Which onboarding step the student is on, derived from server state only.
 * Fail closed: until age is classified, or whenever guardian consent is required,
 * nothing further is collected.
 */
export function profileStep(p: StudentProfile): ProfileStep {
  if (!p.ageClassified) return 'DOB';
  if (p.requiresGuardianConsent) return 'GUARDIAN_NEEDED';
  if (!p.displayName) return 'NAME';
  return 'READY';
}
