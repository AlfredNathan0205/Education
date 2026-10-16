import {
  base32Decode,
  base32Encode,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  hotp,
  isMfaFresh,
  mfaEnforced,
  mfaKey,
  mfaSessionHours,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  stepAt,
  verifyTotp,
} from './totp';
import { isAdminPath } from './mfa.guard';

// RFC 6238 appendix B: the SHA-1 seed "12345678901234567890"; its 8-digit codes end in these 6 digits.
const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890'));

describe('TOTP (RFC 6238)', () => {
  it('base32 round-trips and matches the RFC seed', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(RFC_SECRET).toString()).toBe('12345678901234567890');
    expect(base32Decode('gezd gnbv-gy3t')).toEqual(base32Decode('GEZDGNBVGY3T'));
    expect(() => base32Decode('not*base32')).toThrow();
  });

  it.each([
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
  ])('at %i seconds the code is %s', (t, code) => {
    expect(hotp(RFC_SECRET, stepAt(new Date(t * 1000)))).toBe(code);
  });

  it('accepts a code one step either side of now, not two', () => {
    const now = new Date(1111111109 * 1000);
    const s = stepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s), now, null)).toBe(s);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s - 1), now, null)).toBe(s - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s + 1), now, null)).toBe(s + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s - 2), now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, '12345', now, null)).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', now, null)).toBeNull();
  });

  it('never accepts a step already used, or an earlier one', () => {
    const now = new Date(1111111109 * 1000);
    const s = stepAt(now);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s), now, s)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s - 1), now, s - 1)).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, s + 1), now, s)).toBe(s + 1);
  });

  it('makes 160-bit secrets and a standard link with no personal data', () => {
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Decode(s)).toHaveLength(20);
    const uri = otpauthUri(s);
    expect(uri).toBe(`otpauth://totp/Exam%20App%3Aadmin?secret=${s}&issuer=Exam%20App&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('recovery codes', () => {
  it('ten distinct codes in groups of four, hashed after normalising', () => {
    const codes = newRecoveryCodes();
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const c of codes) expect(c).toMatch(/^[A-Z2-7]{4}-[A-Z2-7]{4}-[A-Z2-7]{4}$/);
    expect(hashRecoveryCode(codes[0])).toBe(hashRecoveryCode(` ${codes[0].toLowerCase().replace(/-/g, ' ')} `));
    expect(hashRecoveryCode(codes[0])).not.toBe(hashRecoveryCode(codes[1]));
    expect(hashRecoveryCode(codes[0])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('secret encryption', () => {
  const key = mfaKey({ MFA_ENCRYPTION_KEY: 'k'.repeat(40) });

  it('round-trips, with a fresh IV each time, and never stores the secret in clear', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const b = encryptSecret('JBSWY3DPEHPK3PXP', key);
    expect(a).not.toBe(b);
    expect(a).not.toContain('JBSWY3DPEHPK3PXP');
    expect(a.startsWith('v1:')).toBe(true);
    expect(decryptSecret(a, key)).toBe('JBSWY3DPEHPK3PXP');
  });

  it('refuses a tampered value or the wrong key', () => {
    const a = encryptSecret('JBSWY3DPEHPK3PXP', key);
    const parts = a.split(':');
    const flipped = Buffer.from(parts[3], 'base64');
    flipped[0] ^= 1;
    expect(() => decryptSecret([parts[0], parts[1], parts[2], flipped.toString('base64')].join(':'), key)).toThrow();
    expect(() => decryptSecret(a, mfaKey({ MFA_ENCRYPTION_KEY: 'x'.repeat(40) }))).toThrow();
    expect(() => decryptSecret('v2:a:b:c', key)).toThrow(/format/);
  });

  it('needs a real key in production, of at least 32 characters', () => {
    expect(() => mfaKey({ NODE_ENV: 'production' })).toThrow(/required in production/);
    expect(() => mfaKey({ MFA_ENCRYPTION_KEY: 'short' })).toThrow(/32 characters/);
    expect(mfaKey({})).toHaveLength(32);
  });
});

describe('MFA policy', () => {
  it('a check lasts MFA_SESSION_HOURS (default 12, 1 to 24)', () => {
    expect(mfaSessionHours({})).toBe(12);
    expect(mfaSessionHours({ MFA_SESSION_HOURS: '4' })).toBe(4);
    expect(mfaSessionHours({ MFA_SESSION_HOURS: '48' })).toBe(12);
    const now = new Date('2026-10-16T12:00:00Z');
    expect(isMfaFresh(null, now, 12)).toBe(false);
    expect(isMfaFresh(new Date('2026-10-16T00:00:01Z'), now, 12)).toBe(true);
    expect(isMfaFresh(new Date('2026-10-15T23:59:59Z'), now, 12)).toBe(false);
  });

  it('is enforced by default and cannot be switched off in production', () => {
    expect(mfaEnforced({})).toBe(true);
    expect(mfaEnforced({ MFA_ENFORCED: 'false' })).toBe(false);
    expect(() => mfaEnforced({ MFA_ENFORCED: 'false', NODE_ENV: 'production' })).toThrow(/not allowed in production/);
  });

  it('covers /admin and everything under it, and nothing else', () => {
    for (const p of ['/admin', '/admin/', '/admin/analytics/metrics', '/admin/questions/units?x=1']) expect(isAdminPath(p)).toBe(true);
    for (const p of ['/administrator', '/mfa/verify', '/guardian/approvals', '/', undefined]) expect(isAdminPath(p)).toBe(false);
  });
});
