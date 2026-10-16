/**
 * Step 20: time-based one-time codes (RFC 6238 over RFC 4226), as authenticator apps make them: HMAC-SHA1, 30-second
 * steps, 6 digits. Pure functions; the service stores the secret encrypted and the last step used.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Codes one step either side of now are accepted, for clock drift. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('not base32');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new 160-bit secret, base32 (what the person types into their app if they cannot scan). */
export function newTotpSecret(random: (n: number) => Buffer = randomBytes): string {
  return base32Encode(random(20));
}

export function stepAt(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/** The code for one step (RFC 4226 dynamic truncation). */
export function hotp(secretB32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', base32Decode(secretB32)).update(counter).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** TOTP_DIGITS).padStart(TOTP_DIGITS, '0');
}

/**
 * The step a code matches within the window, or null. A step at or before `lastUsedStep` never matches, so a code
 * (or an older one) cannot be used twice.
 */
export function verifyTotp(secretB32: string, code: string, now: Date, lastUsedStep: number | null): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const current = stepAt(now);
  for (let d = -TOTP_WINDOW; d <= TOTP_WINDOW; d++) {
    const step = current + d;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    const expected = Buffer.from(hotp(secretB32, step));
    if (timingSafeEqual(expected, Buffer.from(code))) return step;
  }
  return null;
}

/** The link authenticator apps understand (also what a QR code would hold). No personal data in the label. */
export function otpauthUri(secretB32: string, label = 'admin'): string {
  const issuer = 'Exam App';
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${label}`)}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}

// ── recovery codes ──────────────────────────────────────────────────────────

/** Ten codes like "K7QX-M2PD-9TRA" (60 bits each). Shown once; only hashes are kept. */
export function newRecoveryCodes(random: (n: number) => Buffer = randomBytes): string[] {
  const out: string[] = [];
  for (let i = 0; i < RECOVERY_CODE_COUNT; i++) {
    const s = base32Encode(random(8)).slice(0, 12);
    out.push(`${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`);
  }
  return out;
}

export function normaliseRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z2-7]/g, '');
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(`mfa-recovery:${normaliseRecoveryCode(code)}`).digest('hex');
}

// ── secret encryption (AES-256-GCM) ─────────────────────────────────────────

const DEV_KEY = 'development-only-mfa-key-not-for-production-use';

/** The 32-byte key from MFA_ENCRYPTION_KEY. Required in production (at least 32 characters). */
export function mfaKey(env: Record<string, string | undefined> = process.env): Buffer {
  const raw = env.MFA_ENCRYPTION_KEY;
  if (!raw) {
    if (env.NODE_ENV === 'production') throw new Error('MFA_ENCRYPTION_KEY is required in production');
    return createHash('sha256').update(DEV_KEY).digest();
  }
  if (raw.length < 32) throw new Error('MFA_ENCRYPTION_KEY must be at least 32 characters');
  return createHash('sha256').update(raw).digest();
}

/** "v1:<iv>:<tag>:<ciphertext>", base64 parts. */
export function encryptSecret(plain: string, key: Buffer, random: (n: number) => Buffer = randomBytes): string {
  const iv = random(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [v, iv, tag, ct] = stored.split(':');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('unknown secret format');
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

// ── policy ──────────────────────────────────────────────────────────────────

/** How long a check lasts on a session (MFA_SESSION_HOURS, default 12, 1 to 24). */
export function mfaSessionHours(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.MFA_SESSION_HOURS ?? 12);
  return Number.isInteger(n) && n >= 1 && n <= 24 ? n : 12;
}

/**
 * Whether admin routes need the check (MFA_ENFORCED, default true). It cannot be switched off in production: a
 * production start with MFA_ENFORCED=false fails.
 */
export function mfaEnforced(env: Record<string, string | undefined> = process.env): boolean {
  const off = env.MFA_ENFORCED === 'false';
  if (off && env.NODE_ENV === 'production') throw new Error('MFA_ENFORCED=false is not allowed in production');
  return !off;
}

/** Five wrong codes in 15 minutes locks the check for the rest of that window. */
export const MFA_MAX_FAILURES = 5;
export const MFA_FAILURE_WINDOW_MS = 15 * 60_000;

export function isMfaFresh(verifiedAt: Date | null, now: Date, hours: number): boolean {
  return verifiedAt !== null && now.getTime() - verifiedAt.getTime() < hours * 3_600_000 && verifiedAt.getTime() <= now.getTime() + 60_000;
}
