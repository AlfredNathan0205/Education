import { Logger } from '@nestjs/common';

/** The small part of Express's request and response these middlewares use (no dependency on @types/express). */
interface Request {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  socket?: { remoteAddress?: string };
}
interface Response {
  setHeader(name: string, value: string): unknown;
  removeHeader(name: string): unknown;
  status(code: number): { json(body: unknown): unknown };
}
type NextFunction = () => void;
import { FixedWindowLimiter, clientAddress, rateLimitConfig, ruleFor, sessionKey } from './rate-limit';

/** Step 20: headers on every API response. The API serves JSON only, so nothing may be framed, sniffed or cached. */
export function securityHeaders(production = process.env.NODE_ENV === 'production') {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('Cache-Control', 'no-store');
    if (production) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.removeHeader('X-Powered-By');
    next();
  };
}

/** Step 20: per-address and per-session limits (see rate-limit.ts). Over the limit: 429 with Retry-After. */
export function rateLimiter(env: Record<string, string | undefined> = process.env, now: () => number = Date.now) {
  const { enabled, sharedSecret } = rateLimitConfig(env);
  const limiter = new FixedWindowLimiter();
  const logger = new Logger('RateLimit');
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!enabled || req.path === '/health') return next();
    const rule = ruleFor(req.method, req.path);
    const t = now();
    const ip = clientAddress(req.headers, req.socket?.remoteAddress, sharedSecret);
    let wait = limiter.hit(`${rule.name}|ip|${ip}`, rule.perIp, t);
    const session = sessionKey(req.headers);
    if (session) wait = Math.max(wait, limiter.hit(`${rule.name}|s|${session}`, rule.perSession, t));
    if (wait > 0) {
      logger.warn(`rate limit ${rule.name} reached`);
      res.setHeader('Retry-After', String(wait));
      res.status(429).json({ statusCode: 429, message: 'Too many requests. Wait a minute and try again.' });
      return;
    }
    next();
  };
}
