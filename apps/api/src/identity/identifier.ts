export type IdentityKind = 'EMAIL' | 'PHONE';

export class InvalidIdentifierError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidIdentifierError';
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_PATTERN = /^\+[1-9]\d{7,14}$/;
const MAX_EMAIL_LENGTH = 320;

/**
 * Canonical form of a login identifier. Used for both storage and lookup, so
 * "A@X.com " and "a@x.com" are the same identity.
 */
export function normalizeIdentifier(kind: IdentityKind, raw: string): string {
  if (typeof raw !== 'string') throw new InvalidIdentifierError('identifier must be a string');
  const value = raw.trim();

  if (kind === 'EMAIL') {
    const email = value.toLowerCase();
    if (email.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(email)) {
      throw new InvalidIdentifierError('invalid email address');
    }
    return email;
  }

  const phone = value.replace(/[\s\-().]/g, '');
  if (!E164_PATTERN.test(phone)) {
    throw new InvalidIdentifierError(
      'phone number must be in international format, e.g. +971501234567',
    );
  }
  return phone;
}

/** For logs only: never write a full identifier to a log line. */
export function maskIdentifier(kind: IdentityKind, normalized: string): string {
  if (kind === 'EMAIL') {
    const [local, domain] = normalized.split('@');
    return `${local.slice(0, 1)}***@${domain}`;
  }
  return `${normalized.slice(0, 4)}****${normalized.slice(-2)}`;
}
