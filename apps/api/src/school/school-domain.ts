/**
 * Pure rules for Domain 04 (School & Academic Plan), first cut. No I/O.
 *
 * Invariant (INVARIANTS_AND_POLICIES): no school access merely from a student-selected
 * association. An association is the student's statement about where they study; it is
 * never authority for a school to see anything. Reporting authority is a separate,
 * later concern.
 */

export type AssociationState = 'UNVERIFIED' | 'STUDENT_SELECTED' | 'VERIFIED' | 'SCHOOL_CONFIRMED';

/**
 * Launch cohort is a product decision stated by the PM (ICSE Grade 8, UAE first). It is
 * code, not legal data. Widening it is a deliberate change reviewed like any other.
 */
export const LAUNCH_COHORT: ReadonlyArray<{ curriculumCode: string; gradeCode: string; label: string }> = [
  { curriculumCode: 'ICSE', gradeCode: 'GRADE_8', label: 'ICSE · Grade 8' },
];

export function isLaunchCohort(curriculumCode: string, gradeCode: string): boolean {
  return LAUNCH_COHORT.some((c) => c.curriculumCode === curriculumCode && c.gradeCode === gradeCode);
}

/** An association by itself never grants a school any access, whatever its state. */
export function associationGrantsSchoolAccess(_state: AssociationState): false {
  return false;
}

/** What a student's own selection produces: a registry school is STUDENT_SELECTED, free text is UNVERIFIED. */
export function stateForStudentChoice(choice: 'REGISTRY_SCHOOL' | 'FREE_TEXT'): AssociationState {
  return choice === 'REGISTRY_SCHOOL' ? 'STUDENT_SELECTED' : 'UNVERIFIED';
}

export class InvalidSchoolInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidSchoolInputError';
  }
}

const SCHOOL_NAME = /^[\p{L}\p{M}\p{N}][\p{L}\p{M}\p{N} .,'&()\-/]{1,199}$/u;

/** Trim, collapse whitespace, bound length, reject markup-ish characters. */
export function normalizeSchoolName(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidSchoolInputError('School name must be text');
  const name = raw.trim().replace(/\s+/g, ' ');
  if (!SCHOOL_NAME.test(name)) {
    throw new InvalidSchoolInputError('Enter the school name using letters and numbers, 2 to 200 characters');
  }
  return name;
}

export function normalizeCountryCode(raw: unknown): string {
  if (typeof raw !== 'string' || !/^[A-Za-z]{2}$/.test(raw.trim())) {
    throw new InvalidSchoolInputError('Country must be a 2-letter code, e.g. AE');
  }
  return raw.trim().toUpperCase();
}

/** Coarse geography only: a city name, never an address or coordinates. */
export function normalizeCity(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null;
  if (typeof raw !== 'string') throw new InvalidSchoolInputError('City must be text');
  const city = raw.trim().replace(/\s+/g, ' ');
  if (!/^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,99}$/u.test(city)) throw new InvalidSchoolInputError('Enter a city name');
  return city;
}

/** Search text is only ever used as a bound parameter; limit its size and trim it. */
export function normalizeSearchQuery(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidSchoolInputError('Search text must be text');
  const q = raw.trim().replace(/\s+/g, ' ');
  if (q.length < 2 || q.length > 100) throw new InvalidSchoolInputError('Type at least 2 letters to search');
  // No SQL LIKE wildcards or markup: same safe alphabet as school names.
  if (!/^[\p{L}\p{M}\p{N} .,'&()\-/]+$/u.test(q)) throw new InvalidSchoolInputError('Use letters and numbers to search');
  return q;
}
