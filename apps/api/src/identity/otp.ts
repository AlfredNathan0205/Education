import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

export const OTP_LENGTH = 6;
export const OTP_TTL_MS = 10 * 60 * 1000;
export const OTP_MAX_ATTEMPTS = 5;
export const OTP_RESEND_COOLDOWN_MS = 60 * 1000;
/** Shorter than a typical consumer app: children may share devices. Adjust with policy later. */
export const SESSION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

export function generateOtpCode(): string {
  return randomInt(0, 10 ** OTP_LENGTH)
    .toString()
    .padStart(OTP_LENGTH, '0');
}

/**
 * HMAC of the code, bound to the identifier so a code issued for one identity
 * cannot be replayed against another. Only this hash is ever stored.
 */
export function hashOtpCode(code: string, identifierNormalized: string, secret: string): string {
  return createHmac('sha256', secret).update(`${identifierNormalized}:${code}`).digest('hex');
}

export function verifyOtpCode(
  code: string,
  expectedHash: string,
  identifierNormalized: string,
  secret: string,
): boolean {
  const actual = Buffer.from(hashOtpCode(code, identifierNormalized, secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export interface OtpChallengeState {
  expiresAt: Date;
  attempts: number;
  maxAttempts: number;
  consumedAt: Date | null;
}

export type OtpPrecheck = 'ALLOWED' | 'CONSUMED' | 'LOCKED' | 'EXPIRED';

/** Whether an attempt may even be evaluated against this challenge. */
export function precheckOtpAttempt(challenge: OtpChallengeState, now: Date): OtpPrecheck {
  if (challenge.consumedAt !== null) return 'CONSUMED';
  if (challenge.attempts >= challenge.maxAttempts) return 'LOCKED';
  if (now.getTime() >= challenge.expiresAt.getTime()) return 'EXPIRED';
  return 'ALLOWED';
}

/** Resend cooldown: at most one new code per identifier per cooldown window. */
export function canIssueOtp(
  latestCreatedAt: Date | null,
  now: Date,
  cooldownMs: number = OTP_RESEND_COOLDOWN_MS,
): boolean {
  if (latestCreatedAt === null) return true;
  return now.getTime() - latestCreatedAt.getTime() >= cooldownMs;
}

export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url');
}

/** The token is 256 bits of randomness, so a plain SHA-256 is sufficient (no salt/stretching needed). */
export function hashSessionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
