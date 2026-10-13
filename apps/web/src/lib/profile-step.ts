import type { AcademicView, StudentProfile } from './client-api';

export type ProfileStep = 'DOB' | 'GUARDIAN_NEEDED' | 'NAME' | 'GRADE' | 'SCHOOL' | 'READY';

/**
 * Which onboarding step the student is on, derived from server state only.
 * Fail closed: until age is classified, or whenever guardian consent is required,
 * nothing further is collected. Choosing a school is optional: `schoolSkipped` is
 * only this visit's choice, and nothing is stored when a student skips.
 */
export function profileStep(
  p: StudentProfile,
  academic: AcademicView | null = null,
  schoolSkipped = false,
): ProfileStep {
  if (!p.ageClassified) return 'DOB';
  if (p.requiresGuardianConsent) return 'GUARDIAN_NEEDED';
  if (!p.displayName) return 'NAME';
  if (!academic) return 'GRADE'; // academic state still loading; GRADE is the safe first screen
  if (!academic.grade) return 'GRADE';
  if (!academic.school && !schoolSkipped) return 'SCHOOL';
  return 'READY';
}
