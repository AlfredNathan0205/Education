import { createHash, randomBytes } from 'node:crypto';

/**
 * Pure rules for guardian invitations. No database, no clock: callers pass `now`.
 *
 * The verification method below is only a CODE. Whether it is accepted is decided by the active,
 * counsel-reviewed jurisdiction policy (acceptedGuardianVerificationMethods), never here.
 */

/** The guardian proves they control the invited email address (one-time code) and attests the relationship. */
export const GUARDIAN_METHOD = 'EMAIL_LINK_ATTESTATION';

export const RELATIONSHIPS = ['MOTHER', 'FATHER', 'LEGAL_GUARDIAN'] as const;
export type Relationship = (typeof RELATIONSHIPS)[number];

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** A student may send at most this many invitations in a rolling day (resends included). */
export const MAX_INVITES_PER_STUDENT_PER_DAY = 3;
/** One address may receive at most this many invitations in a rolling day, across all students. */
export const MAX_INVITES_PER_EMAIL_PER_DAY = 3;
/** Minimum gap between two invitations from the same student. */
export const INVITE_COOLDOWN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 32 random bytes as base64url: always 43 characters. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateInviteToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The token has 256 bits of entropy, so a plain SHA-256 is enough; only the hash is stored. */
export function hashInviteToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function isRelationship(value: unknown): value is Relationship {
  return typeof value === 'string' && (RELATIONSHIPS as readonly string[]).includes(value);
}

export type InvitationUse = 'OK' | 'EXPIRED' | 'RESOLVED';

export function invitationUse(
  invitation: { status: string; expiresAt: Date },
  now: Date,
): InvitationUse {
  if (invitation.status !== 'PENDING') return 'RESOLVED';
  if (invitation.expiresAt.getTime() <= now.getTime()) return 'EXPIRED';
  return 'OK';
}

export type InviteRateDecision =
  | { allowed: true }
  | { allowed: false; reason: 'COOLDOWN' | 'STUDENT_DAILY_LIMIT' | 'EMAIL_DAILY_LIMIT' };

/** `studentSent` and `emailReceived` are the creation times of invitations (any status) in the last day. */
export function decideInviteRate(input: {
  studentSent: Date[];
  emailReceived: Date[];
  now: Date;
}): InviteRateDecision {
  const since = input.now.getTime() - DAY_MS;
  const student = input.studentSent.filter((d) => d.getTime() > since);
  const email = input.emailReceived.filter((d) => d.getTime() > since);
  const latest = student.reduce((m, d) => Math.max(m, d.getTime()), 0);
  if (latest > 0 && input.now.getTime() - latest < INVITE_COOLDOWN_MS) {
    return { allowed: false, reason: 'COOLDOWN' };
  }
  if (student.length >= MAX_INVITES_PER_STUDENT_PER_DAY) {
    return { allowed: false, reason: 'STUDENT_DAILY_LIMIT' };
  }
  if (email.length >= MAX_INVITES_PER_EMAIL_PER_DAY) {
    return { allowed: false, reason: 'EMAIL_DAILY_LIMIT' };
  }
  return { allowed: true };
}
