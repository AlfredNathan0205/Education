import {
  OTP_LENGTH,
  OTP_MAX_PER_HOUR,
  OTP_RESEND_COOLDOWN_MS,
  canIssueOtp,
  generateOtpCode,
  generateSessionToken,
  hashOtpCode,
  hashSessionToken,
  precheckOtpAttempt,
  verifyOtpCode,
  withinHourlyOtpLimit,
} from './otp';

const SECRET = 'unit-test-secret';
const ID = 'student@example.com';

describe('OTP codes', () => {
  it('generates fixed-length numeric codes, including leading zeros', () => {
    for (let i = 0; i < 200; i++)
      expect(generateOtpCode()).toMatch(new RegExp(`^\\d{${OTP_LENGTH}}$`));
  });

  it('verifies the right code and rejects a wrong one', () => {
    const hash = hashOtpCode('123456', ID, SECRET);
    expect(verifyOtpCode('123456', hash, ID, SECRET)).toBe(true);
    expect(verifyOtpCode('123457', hash, ID, SECRET)).toBe(false);
  });

  it('binds the hash to the identifier so a code cannot be replayed for another identity', () => {
    const hash = hashOtpCode('123456', ID, SECRET);
    expect(verifyOtpCode('123456', hash, 'someone-else@example.com', SECRET)).toBe(false);
  });

  it('does not verify under a different secret', () => {
    const hash = hashOtpCode('123456', ID, SECRET);
    expect(verifyOtpCode('123456', hash, ID, 'another-secret')).toBe(false);
  });

  it('returns false (not throws) for a malformed stored hash', () => {
    expect(verifyOtpCode('123456', 'not-hex', ID, SECRET)).toBe(false);
    expect(verifyOtpCode('123456', '', ID, SECRET)).toBe(false);
  });

  it('never stores the code itself in the hash', () => {
    expect(hashOtpCode('123456', ID, SECRET)).not.toContain('123456');
  });
});

describe('precheckOtpAttempt', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  const base = {
    expiresAt: new Date('2026-10-11T12:10:00Z'),
    attempts: 0,
    maxAttempts: 5,
    consumedAt: null,
  };

  it('allows a fresh challenge', () => expect(precheckOtpAttempt(base, now)).toBe('ALLOWED'));
  it('rejects a consumed challenge', () =>
    expect(precheckOtpAttempt({ ...base, consumedAt: now }, now)).toBe('CONSUMED'));
  it('locks once attempts reach the cap', () =>
    expect(precheckOtpAttempt({ ...base, attempts: 5 }, now)).toBe('LOCKED'));
  it('still allows the last attempt', () =>
    expect(precheckOtpAttempt({ ...base, attempts: 4 }, now)).toBe('ALLOWED'));
  it('expires at the expiry instant', () =>
    expect(precheckOtpAttempt(base, new Date('2026-10-11T12:10:00Z'))).toBe('EXPIRED'));
  it('reports consumed before locked or expired', () =>
    expect(
      precheckOtpAttempt({ ...base, attempts: 9, consumedAt: now }, new Date('2027-01-01')),
    ).toBe('CONSUMED'));
});

describe('canIssueOtp', () => {
  const now = new Date('2026-10-11T12:00:00Z');
  it('allows the first request', () => expect(canIssueOtp(null, now)).toBe(true));
  it('blocks inside the cooldown', () =>
    expect(canIssueOtp(new Date(now.getTime() - (OTP_RESEND_COOLDOWN_MS - 1)), now)).toBe(false));
  it('allows once the cooldown has elapsed', () =>
    expect(canIssueOtp(new Date(now.getTime() - OTP_RESEND_COOLDOWN_MS), now)).toBe(true));
});

describe('session tokens', () => {
  it('generates unique, high-entropy tokens', () => {
    const tokens = new Set(Array.from({ length: 100 }, generateSessionToken));
    expect(tokens.size).toBe(100);
    for (const t of tokens) expect(t.length).toBeGreaterThanOrEqual(43); // 32 bytes, base64url
  });

  it('hashes deterministically and never returns the token', () => {
    const token = generateSessionToken();
    expect(hashSessionToken(token)).toBe(hashSessionToken(token));
    expect(hashSessionToken(token)).not.toContain(token);
    expect(hashSessionToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('withinHourlyOtpLimit', () => {
  it('allows up to the cap and refuses at it', () => {
    expect(withinHourlyOtpLimit(0)).toBe(true);
    expect(withinHourlyOtpLimit(OTP_MAX_PER_HOUR - 1)).toBe(true);
    expect(withinHourlyOtpLimit(OTP_MAX_PER_HOUR)).toBe(false);
    expect(withinHourlyOtpLimit(OTP_MAX_PER_HOUR + 3)).toBe(false);
  });
});
