/**
 * Step 20: HTTP rate limits. A fixed one-minute window per key, kept in this process's memory (one API instance today;
 * a shared store is needed before running several). Pure apart from the clock passed in.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export interface RateRule {
  /** Name, for logs. */
  name: string;
  /** Matches "METHOD /path" (no query). */
  match: RegExp;
  /** Requests per window per client address. */
  perIp: number;
  /** Requests per window per session token. */
  perSession: number;
}

export const WINDOW_MS = 60_000;

/** First match wins. Sign-in and the authenticator check are tight; everything else is generous. */
export const RATE_RULES: RateRule[] = [
  { name: 'otp-request', match: /^POST \/identity\/otp\/request$/, perIp: 10, perSession: 10 },
  { name: 'otp-verify', match: /^POST \/identity\/otp\/verify$/, perIp: 20, perSession: 20 },
  { name: 'mfa', match: /^POST \/mfa\/(verify|enrol\/confirm)$/, perIp: 10, perSession: 10 },
  { name: 'invitations', match: /^POST \/(guardian|parent|parent-sharing)\/invitations(\/[a-z]+)?$/, perIp: 30, perSession: 20 },
  { name: 'privacy-rights', match: /^(GET|POST) \/privacy\//, perIp: 30, perSession: 20 },
  { name: 'default', match: /./, perIp: 600, perSession: 300 },
];

export function ruleFor(method: string, path: string, rules: RateRule[] = RATE_RULES): RateRule {
  const key = `${method.toUpperCase()} ${path.split('?')[0]}`;
  return rules.find((r) => r.match.test(key)) ?? rules[rules.length - 1];
}

export class FixedWindowLimiter {
  private readonly counts = new Map<string, { windowStart: number; n: number }>();

  constructor(private readonly maxKeys = 100_000) {}

  /** Counts one request. Returns the seconds to wait when over the limit, else 0. */
  hit(key: string, limit: number, now: number): number {
    const windowStart = now - (now % WINDOW_MS);
    let c = this.counts.get(key);
    if (!c || c.windowStart !== windowStart) {
      if (this.counts.size >= this.maxKeys) this.prune(windowStart);
      c = { windowStart, n: 0 };
      this.counts.set(key, c);
    }
    c.n++;
    return c.n > limit ? Math.ceil((windowStart + WINDOW_MS - now) / 1000) : 0;
  }

  get size(): number {
    return this.counts.size;
  }

  /** Drops old windows; if every key is current, drops everything (fails open rather than growing without bound). */
  private prune(windowStart: number): void {
    for (const [k, v] of this.counts) if (v.windowStart !== windowStart) this.counts.delete(k);
    if (this.counts.size >= this.maxKeys) this.counts.clear();
  }
}

/**
 * The client address. The web app's server (the BFF) is the only caller in production, so every browser request
 * arrives from its address; the BFF passes the browser's address in X-Client-IP with a shared secret. The header is
 * believed only with the right secret (BFF_SHARED_SECRET), otherwise the socket address is used.
 */
export function clientAddress(
  headers: Record<string, string | string[] | undefined>,
  socketAddress: string | undefined,
  sharedSecret: string | undefined,
): string {
  const one = (h: string | string[] | undefined) => (Array.isArray(h) ? h[0] : h);
  const given = one(headers['x-bff-secret']);
  const ip = one(headers['x-client-ip']);
  if (sharedSecret && given && ip && safeEqual(given, sharedSecret) && /^[0-9a-fA-F:.]{2,45}$/.test(ip)) return ip;
  return socketAddress ?? 'unknown';
}

export function sessionKey(headers: Record<string, string | string[] | undefined>): string | null {
  const h = headers['authorization'];
  const v = Array.isArray(h) ? h[0] : h;
  const m = v ? /^Bearer (\S{16,256})$/.exec(v) : null;
  // A hash, so tokens are never held in memory longer than the request needs them.
  return m ? createHash('sha256').update(m[1]).digest('hex').slice(0, 32) : null;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** RATE_LIMIT_ENABLED (default true). BFF_SHARED_SECRET is required in production, at least 32 characters. */
export function rateLimitConfig(env: Record<string, string | undefined> = process.env): { enabled: boolean; sharedSecret: string | undefined } {
  const secret = env.BFF_SHARED_SECRET;
  if (env.NODE_ENV === 'production' && (!secret || secret.length < 32)) throw new Error('BFF_SHARED_SECRET (at least 32 characters) is required in production');
  return { enabled: env.RATE_LIMIT_ENABLED !== 'false', sharedSecret: secret || undefined };
}
