import {
  INVITE_COOLDOWN_MS,
  INVITE_TOKEN_PATTERN,
  MAX_INVITES_PER_EMAIL_PER_DAY,
  MAX_INVITES_PER_STUDENT_PER_DAY,
  decideInviteRate,
  generateInviteToken,
  hashInviteToken,
  invitationUse,
  isRelationship,
} from './guardian-domain';

const NOW = new Date('2026-10-13T12:00:00Z');
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const HOUR = 3600_000;

describe('invite tokens', () => {
  it('are 43 url-safe characters and different each time', () => {
    const a = generateInviteToken();
    const b = generateInviteToken();
    expect(a).toMatch(INVITE_TOKEN_PATTERN);
    expect(a).not.toBe(b);
  });
  it('hash deterministically to 64 hex characters, and the hash is not the token', () => {
    const t = generateInviteToken();
    expect(hashInviteToken(t)).toBe(hashInviteToken(t));
    expect(hashInviteToken(t)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashInviteToken(t)).not.toContain(t);
  });
  it('the pattern rejects short, long and odd tokens', () => {
    for (const bad of ['', 'abc', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}!`, `${'a'.repeat(42)} `]) {
      expect(bad).not.toMatch(INVITE_TOKEN_PATTERN);
    }
  });
});

describe('relationships', () => {
  it('accepts only the listed ones', () => {
    expect(isRelationship('MOTHER')).toBe(true);
    expect(isRelationship('FRIEND')).toBe(false);
    expect(isRelationship(undefined)).toBe(false);
  });
});

describe('invitationUse', () => {
  const future = new Date(NOW.getTime() + HOUR);
  it('is usable while pending and unexpired', () => {
    expect(invitationUse({ status: 'PENDING', expiresAt: future }, NOW)).toBe('OK');
  });
  it('is expired at the exact expiry instant', () => {
    expect(invitationUse({ status: 'PENDING', expiresAt: NOW }, NOW)).toBe('EXPIRED');
  });
  it.each(['ACCEPTED', 'DECLINED', 'CANCELLED', 'EXPIRED'])('is resolved when %s', (status) => {
    expect(invitationUse({ status, expiresAt: future }, NOW)).toBe('RESOLVED');
  });
});

describe('decideInviteRate', () => {
  it('allows the first invitation', () => {
    expect(decideInviteRate({ studentSent: [], emailReceived: [], now: NOW })).toEqual({ allowed: true });
  });
  it('blocks a second invitation inside the cooldown', () => {
    expect(decideInviteRate({ studentSent: [ago(INVITE_COOLDOWN_MS - 1)], emailReceived: [], now: NOW })).toEqual({ allowed: false, reason: 'COOLDOWN' });
  });
  it('allows one exactly at the cooldown', () => {
    expect(decideInviteRate({ studentSent: [ago(INVITE_COOLDOWN_MS)], emailReceived: [], now: NOW }).allowed).toBe(true);
  });
  it('blocks at the daily limit per student and counts only the last day', () => {
    const full = Array.from({ length: MAX_INVITES_PER_STUDENT_PER_DAY }, (_, i) => ago((i + 1) * HOUR));
    expect(decideInviteRate({ studentSent: full, emailReceived: [], now: NOW })).toEqual({ allowed: false, reason: 'STUDENT_DAILY_LIMIT' });
    const old = Array.from({ length: 10 }, () => ago(25 * HOUR));
    expect(decideInviteRate({ studentSent: old, emailReceived: [], now: NOW }).allowed).toBe(true);
  });
  it('blocks at the daily limit per address, across students', () => {
    const full = Array.from({ length: MAX_INVITES_PER_EMAIL_PER_DAY }, (_, i) => ago((i + 2) * HOUR));
    expect(decideInviteRate({ studentSent: [], emailReceived: full, now: NOW })).toEqual({ allowed: false, reason: 'EMAIL_DAILY_LIMIT' });
  });
});
