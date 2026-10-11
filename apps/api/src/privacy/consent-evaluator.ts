/**
 * Pure consent evaluation. Active consent is DERIVED from append-only grants and
 * withdrawals; nothing here reads or writes the database.
 *
 * Downstream domains must ask "may this purpose be processed for this student
 * right now?" through this evaluation rather than reading consent tables.
 */

export type ConsentCapacity = 'SELF' | 'GUARDIAN';
export type GuardianVerificationStatus = 'PENDING' | 'VERIFIED' | 'FAILED' | 'EXPIRED';

export interface ConsentGrant {
  id: string;
  purposeCode: string;
  capacity: ConsentCapacity;
  guardianAuthorityId: string | null;
  grantedAt: Date;
  withdrawn: boolean;
}

export interface GuardianAuthorityState {
  id: string;
  revokedAt: Date | null;
  verificationStatus: GuardianVerificationStatus;
  verificationExpiresAt: Date | null;
}

export type DenialReason =
  'NO_CONSENT' | 'CONSENT_WITHDRAWN' | 'GUARDIAN_CONSENT_REQUIRED' | 'GUARDIAN_AUTHORITY_INVALID';

export type ProcessingDecision =
  { allowed: true; grantId: string } | { allowed: false; reason: DenialReason };

/** A guardian authority is usable only if unrevoked and backed by a live, VERIFIED verification. */
export function isAuthorityValid(
  authority: GuardianAuthorityState | undefined,
  now: Date,
): boolean {
  if (!authority) return false;
  if (authority.revokedAt !== null && authority.revokedAt.getTime() <= now.getTime()) return false;
  if (authority.verificationStatus !== 'VERIFIED') return false;
  if (
    authority.verificationExpiresAt !== null &&
    authority.verificationExpiresAt.getTime() <= now.getTime()
  ) {
    return false;
  }
  return true;
}

export function evaluateProcessing(input: {
  purposeCode: string;
  requiresGuardianConsent: boolean;
  grants: ConsentGrant[];
  authorities: GuardianAuthorityState[];
  now: Date;
}): ProcessingDecision {
  const { purposeCode, requiresGuardianConsent, authorities, now } = input;
  const grants = input.grants.filter((g) => g.purposeCode === purposeCode);

  if (grants.length === 0) return { allowed: false, reason: 'NO_CONSENT' };

  const active = grants.filter((g) => !g.withdrawn);
  if (active.length === 0) return { allowed: false, reason: 'CONSENT_WITHDRAWN' };

  const authorityById = new Map(authorities.map((a) => [a.id, a]));
  const guardianGrants = active.filter((g) => g.capacity === 'GUARDIAN');
  const validGuardianGrants = guardianGrants.filter(
    (g) =>
      g.guardianAuthorityId !== null &&
      isAuthorityValid(authorityById.get(g.guardianAuthorityId), now),
  );

  const newest = (list: ConsentGrant[]): ConsentGrant =>
    list.reduce((a, b) => (b.grantedAt.getTime() > a.grantedAt.getTime() ? b : a));

  if (requiresGuardianConsent) {
    // Only a valid guardian grant satisfies the requirement; the student's own grant does not.
    if (validGuardianGrants.length > 0)
      return { allowed: true, grantId: newest(validGuardianGrants).id };
    return {
      allowed: false,
      reason:
        guardianGrants.length > 0 ? 'GUARDIAN_AUTHORITY_INVALID' : 'GUARDIAN_CONSENT_REQUIRED',
    };
  }

  const validSelfGrants = active.filter((g) => g.capacity === 'SELF');
  const valid = [...validSelfGrants, ...validGuardianGrants];
  if (valid.length > 0) return { allowed: true, grantId: newest(valid).id };
  return { allowed: false, reason: 'GUARDIAN_AUTHORITY_INVALID' };
}
