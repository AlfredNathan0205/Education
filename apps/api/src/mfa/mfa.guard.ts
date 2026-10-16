import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';
import { MfaService } from './mfa.service';
import { mfaEnforced } from './totp';

export const MFA_REQUIRED = 'MFA_REQUIRED';

/** True for the API's administration routes: /admin and everything under it. */
export function isAdminPath(url: string | undefined): boolean {
  const path = (url ?? '').split('?')[0];
  return /^\/admin(\/|$)/.test(path);
}

/**
 * Step 20, registered globally: on /admin routes, an account that holds any role must have passed the authenticator
 * check on this session. Requests without a valid session pass through to the route's own guard (401), and accounts
 * without a role pass through to the route's own role check (403), so nothing else changes for them.
 */
@Injectable()
export class MfaGuard implements CanActivate {
  private readonly enforced = mfaEnforced(process.env);

  constructor(private readonly identity: IdentityService, private readonly mfa: MfaService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (!this.enforced || context.getType() !== 'http') return true;
    const req = context.switchToHttp().getRequest<{ url?: string; originalUrl?: string; headers: Record<string, string | string[] | undefined> }>();
    if (!isAdminPath(req.originalUrl ?? req.url)) return true;
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(value) : null;
    if (!match) return true;
    const session = await this.identity.authenticate(match[1]);
    if (!session) return true;
    const result = await this.mfa.check(session.accountId, session.sessionId);
    if (result === 'MFA_REQUIRED') {
      throw new ForbiddenException({ statusCode: 403, code: MFA_REQUIRED, message: 'Confirm it is you with your authenticator app first.' });
    }
    return true;
  }
}
