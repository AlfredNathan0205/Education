/**
 * Domain 01c — authorization skeleton. Pure role catalog and helpers.
 * Human accounts can hold these curriculum roles. AI_RESEARCH is not assignable to an
 * account: the AI acts only as an AI actor and can never approve or activate.
 */
import type { CurriculumRole } from '../curriculum/curriculum-state';

export const ASSIGNABLE_ROLES = {
  CURRICULUM_EDITOR: { curriculumRole: 'EDITOR', description: 'May create and edit curriculum content and evidence.' },
  CURRICULUM_REVIEWER: { curriculumRole: 'REVIEWER', description: 'May review validated curriculum and verify evidence packs.' },
  CURRICULUM_APPROVER: { curriculumRole: 'APPROVER', description: 'May approve and activate curriculum versions.' },
  SUPER_ADMIN: { curriculumRole: 'SUPER_ADMIN', description: 'All curriculum roles, and may grant or revoke roles.' },
} as const satisfies Record<string, { curriculumRole: CurriculumRole; description: string }>;

export type AssignableRoleCode = keyof typeof ASSIGNABLE_ROLES;

export function isAssignableRole(code: string): code is AssignableRoleCode {
  return Object.prototype.hasOwnProperty.call(ASSIGNABLE_ROLES, code);
}

/** Map stored role codes to curriculum roles, ignoring anything unknown. */
export function toCurriculumRoles(codes: readonly string[]): CurriculumRole[] {
  const out = new Set<CurriculumRole>();
  for (const c of codes) if (isAssignableRole(c)) out.add(ASSIGNABLE_ROLES[c].curriculumRole);
  return [...out];
}

/** First held role that is in the allowed set, preferring the least privileged. */
export function pickRole(held: readonly CurriculumRole[], allowed: readonly CurriculumRole[]): CurriculumRole | null {
  const order: CurriculumRole[] = ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'];
  for (const r of order) if (held.includes(r) && allowed.includes(r)) return r;
  return null;
}
