import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { IdentityService } from '../identity/identity.service';

export interface AuthenticatedRequest {
  headers: Record<string, string | string[] | undefined>;
  accountId?: string;
}

/** Resolves `Authorization: Bearer <session token>` to an account. Nothing else is trusted. */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly identity: IdentityService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const header = req.headers['authorization'];
    const value = Array.isArray(header) ? header[0] : header;
    const match = value ? /^Bearer ([A-Za-z0-9_-]{16,256})$/.exec(value) : null;
    if (!match) throw new UnauthorizedException();
    const session = await this.identity.authenticate(match[1]);
    if (!session) throw new UnauthorizedException();
    req.accountId = session.accountId;
    return true;
  }
}
