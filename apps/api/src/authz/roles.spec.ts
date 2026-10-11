import { isAssignableRole, pickRole, toCurriculumRoles } from './roles';

describe('roles', () => {
  it('AI_RESEARCH is not assignable to a human account', () => {
    expect(isAssignableRole('AI_RESEARCH')).toBe(false);
    expect(isAssignableRole('toString')).toBe(false);
    expect(isAssignableRole('CURRICULUM_APPROVER')).toBe(true);
  });
  it('maps stored codes to curriculum roles and ignores unknown codes', () => {
    expect(toCurriculumRoles(['CURRICULUM_EDITOR', 'junk', 'CURRICULUM_EDITOR']).sort()).toEqual(['EDITOR']);
  });
  it('picks the least-privileged held role that is allowed', () => {
    expect(pickRole(['APPROVER', 'EDITOR'], ['EDITOR', 'SUPER_ADMIN'])).toBe('EDITOR');
    expect(pickRole(['SUPER_ADMIN'], ['EDITOR', 'SUPER_ADMIN'])).toBe('SUPER_ADMIN');
  });
  it('returns null when no held role is allowed', () => {
    expect(pickRole(['REVIEWER'], ['APPROVER', 'SUPER_ADMIN'])).toBeNull();
    expect(pickRole([], ['EDITOR'])).toBeNull();
    expect(pickRole(['EDITOR'], [])).toBeNull();
  });
});
