import {
  InvalidSchoolInputError,
  LAUNCH_COHORT,
  associationGrantsSchoolAccess,
  isLaunchCohort,
  normalizeCity,
  normalizeCountryCode,
  normalizeSchoolName,
  normalizeSearchQuery,
  stateForStudentChoice,
  type AssociationState,
} from './school-domain';

describe('launch cohort', () => {
  it('is exactly ICSE Grade 8 for now', () => {
    expect(LAUNCH_COHORT).toEqual([{ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', label: 'ICSE · Grade 8' }]);
    expect(isLaunchCohort('ICSE', 'GRADE_8')).toBe(true);
    expect(isLaunchCohort('ICSE', 'GRADE_9')).toBe(false);
    expect(isLaunchCohort('CBSE', 'GRADE_8')).toBe(false);
  });
});

describe('association never grants school access', () => {
  it.each<AssociationState>(['UNVERIFIED', 'STUDENT_SELECTED', 'VERIFIED', 'SCHOOL_CONFIRMED'])('%s', (s) => {
    expect(associationGrantsSchoolAccess(s)).toBe(false);
  });
});

describe('stateForStudentChoice', () => {
  it('registry pick is STUDENT_SELECTED; free text stays UNVERIFIED; a student can never self-assign VERIFIED', () => {
    expect(stateForStudentChoice('REGISTRY_SCHOOL')).toBe('STUDENT_SELECTED');
    expect(stateForStudentChoice('FREE_TEXT')).toBe('UNVERIFIED');
  });
});

describe('input normalisation', () => {
  it('normalises school names', () => {
    expect(normalizeSchoolName("  The  Indian  High School, Dubai ")).toBe('The Indian High School, Dubai');
  });
  it.each([[''], ['a'], ['<script>alert(1)</script>'], ['x'.repeat(201)], [null], [42], ['  ']])('rejects school name %p', (v) => {
    expect(() => normalizeSchoolName(v)).toThrow(InvalidSchoolInputError);
  });
  it('country codes are upper-cased 2-letter codes', () => {
    expect(normalizeCountryCode(' ae ')).toBe('AE');
    expect(() => normalizeCountryCode('UAE')).toThrow(InvalidSchoolInputError);
    expect(() => normalizeCountryCode(undefined)).toThrow(InvalidSchoolInputError);
  });
  it('city is optional, coarse and text only', () => {
    expect(normalizeCity(undefined)).toBeNull();
    expect(normalizeCity('')).toBeNull();
    expect(normalizeCity(' Abu  Dhabi ')).toBe('Abu Dhabi');
    expect(() => normalizeCity('25.2048,55.2708')).toThrow(InvalidSchoolInputError);
    expect(() => normalizeCity('12 Street Name 4')).toThrow(InvalidSchoolInputError);
  });
  it('search text is bounded', () => {
    expect(normalizeSearchQuery(' high  school ')).toBe('high school');
    expect(() => normalizeSearchQuery('a')).toThrow(InvalidSchoolInputError);
    expect(() => normalizeSearchQuery('a'.repeat(101))).toThrow(InvalidSchoolInputError);
    expect(() => normalizeSearchQuery(undefined)).toThrow(InvalidSchoolInputError);
    expect(() => normalizeSearchQuery('50%')).toThrow(InvalidSchoolInputError);
    expect(() => normalizeSearchQuery('a_b')).toThrow(InvalidSchoolInputError);
  });
});
