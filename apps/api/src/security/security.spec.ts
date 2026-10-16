import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { rateLimiter, securityHeaders } from './http-security';
import { KILL_SWITCHES } from './kill-switches';
import { FixedWindowLimiter, RATE_RULES, WINDOW_MS, clientAddress, rateLimitConfig, ruleFor, sessionKey } from './rate-limit';

function res() {
  const headers: Record<string, string> = { 'X-Powered-By': 'Express' };
  const out: any = { headers, statusCode: 200, body: undefined };
  out.setHeader = (k: string, v: string) => (headers[k] = v);
  out.removeHeader = (k: string) => delete headers[k];
  out.status = (c: number) => ((out.statusCode = c), { json: (b: unknown) => (out.body = b) });
  return out;
}
const req = (method: string, path: string, headers: Record<string, string> = {}, ip = '10.0.0.1') => ({ method, path, headers, socket: { remoteAddress: ip } });

describe('rate-limit rules', () => {
  it('sign-in, the authenticator and data rights are tight; the rest is generous', () => {
    expect(ruleFor('POST', '/identity/otp/request').name).toBe('otp-request');
    expect(ruleFor('post', '/identity/otp/verify?x=1').name).toBe('otp-verify');
    expect(ruleFor('POST', '/mfa/verify').name).toBe('mfa');
    expect(ruleFor('POST', '/mfa/enrol/confirm').name).toBe('mfa');
    expect(ruleFor('POST', '/guardian/invitations').name).toBe('invitations');
    expect(ruleFor('POST', '/parent-sharing/invitations/cancel').name).toBe('invitations');
    expect(ruleFor('GET', '/privacy/export').name).toBe('privacy-rights');
    expect(ruleFor('GET', '/exam/units').name).toBe('default');
    expect(RATE_RULES.at(-1)!.name).toBe('default');
  });

  it('counts per key in a fixed one-minute window', () => {
    const l = new FixedWindowLimiter();
    const t = 10 * WINDOW_MS + 5_000;
    expect(l.hit('k', 2, t)).toBe(0);
    expect(l.hit('k', 2, t + 1)).toBe(0);
    expect(l.hit('k', 2, t + 2)).toBe(55);
    expect(l.hit('other', 2, t + 3)).toBe(0);
    expect(l.hit('k', 2, t + WINDOW_MS)).toBe(0);
  });

  it('never grows without bound', () => {
    const l = new FixedWindowLimiter(3);
    for (let i = 0; i < 10; i++) l.hit(`k${i}`, 5, 1000);
    expect(l.size).toBeLessThanOrEqual(3);
  });

  it("believes the BFF's client address only with the shared secret", () => {
    const secret = 's'.repeat(40);
    expect(clientAddress({ 'x-client-ip': '203.0.113.9', 'x-bff-secret': secret }, '172.18.0.5', secret)).toBe('203.0.113.9');
    expect(clientAddress({ 'x-client-ip': '203.0.113.9', 'x-bff-secret': 'wrong' }, '172.18.0.5', secret)).toBe('172.18.0.5');
    expect(clientAddress({ 'x-client-ip': '203.0.113.9' }, '172.18.0.5', undefined)).toBe('172.18.0.5');
    expect(clientAddress({ 'x-client-ip': 'evil; drop', 'x-bff-secret': secret }, '172.18.0.5', secret)).toBe('172.18.0.5');
  });

  it('keys sessions by a hash, never the token', () => {
    const k = sessionKey({ authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' });
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(k).not.toContain('abcdefghijklmnop');
    expect(sessionKey({})).toBeNull();
  });

  it('needs a shared secret of 32+ characters in production; can be switched off', () => {
    expect(() => rateLimitConfig({ NODE_ENV: 'production' })).toThrow(/BFF_SHARED_SECRET/);
    expect(() => rateLimitConfig({ NODE_ENV: 'production', BFF_SHARED_SECRET: 'short' })).toThrow(/BFF_SHARED_SECRET/);
    expect(rateLimitConfig({ NODE_ENV: 'production', BFF_SHARED_SECRET: 'x'.repeat(32) }).enabled).toBe(true);
    expect(rateLimitConfig({ RATE_LIMIT_ENABLED: 'false' }).enabled).toBe(false);
  });
});

describe('the middlewares', () => {
  it('answer 429 with Retry-After past the limit, per address and per session', () => {
    let now = 60_000 * 100;
    const mw = rateLimiter({}, () => now);
    const next = jest.fn();
    for (let i = 0; i < 10; i++) mw(req('POST', '/identity/otp/request') as any, res(), next);
    expect(next).toHaveBeenCalledTimes(10);
    const r = res();
    mw(req('POST', '/identity/otp/request') as any, r, next);
    expect(r.statusCode).toBe(429);
    expect(r.headers['Retry-After']).toBe('60');
    expect(r.body).toMatchObject({ statusCode: 429 });
    // Another address is not affected; neither is another rule.
    mw(req('POST', '/identity/otp/request', {}, '10.0.0.2') as any, res(), next);
    mw(req('GET', '/exam/units') as any, res(), next);
    expect(next).toHaveBeenCalledTimes(12);
    // The next minute starts again.
    now += 60_000;
    mw(req('POST', '/identity/otp/request') as any, res(), next);
    expect(next).toHaveBeenCalledTimes(13);
  });

  it('limit a session across addresses', () => {
    const mw = rateLimiter({}, () => 1);
    const next = jest.fn();
    const auth = { authorization: 'Bearer abcdefghijklmnopqrstuvwxyz' };
    for (let i = 0; i < 10; i++) mw(req('POST', '/mfa/verify', auth, `10.0.1.${i}`) as any, res(), next);
    const r = res();
    mw(req('POST', '/mfa/verify', auth, '10.0.2.1') as any, r, next);
    expect(r.statusCode).toBe(429);
  });

  it('never limit the health check, and stop when switched off', () => {
    const next = jest.fn();
    const on = rateLimiter({}, () => 1);
    for (let i = 0; i < 700; i++) on(req('GET', '/health') as any, res(), next);
    const off = rateLimiter({ RATE_LIMIT_ENABLED: 'false' }, () => 1);
    for (let i = 0; i < 20; i++) off(req('POST', '/identity/otp/request') as any, res(), next);
    expect(next).toHaveBeenCalledTimes(720);
  });

  it('set the security headers and drop X-Powered-By (HSTS in production only)', () => {
    const r = res();
    securityHeaders(false)(req('GET', '/x') as any, r, jest.fn());
    expect(r.headers).toMatchObject({
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
      'Cache-Control': 'no-store',
    });
    expect(r.headers['X-Powered-By']).toBeUndefined();
    expect(r.headers['Strict-Transport-Security']).toBeUndefined();
    const p = res();
    securityHeaders(true)(req('GET', '/x') as any, p, jest.fn());
    expect(p.headers['Strict-Transport-Security']).toContain('max-age=31536000');
  });
});

describe('kill switches', () => {
  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      if (statSync(p).isDirectory()) return sources(p);
      return p.endsWith('.ts') && !p.endsWith('.spec.ts') && !p.endsWith('kill-switches.ts') ? [p] : [];
    });
  }

  it('every listed switch is read by the code, and the launch review lists them all', () => {
    const code = sources(join(__dirname, '..')).map((p) => readFileSync(p, 'utf8')).join('\n');
    const review = readFileSync(join(__dirname, '../../../../docs/implementation/SECURITY_PRIVACY_LAUNCH_REVIEW.md'), 'utf8');
    for (const k of KILL_SWITCHES) {
      expect([k.name, code.includes(k.name)]).toEqual([k.name, true]);
      expect([k.name, review.includes(k.name)]).toEqual([k.name, true]);
    }
  });
});
