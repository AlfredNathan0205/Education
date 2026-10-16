import { BadRequestException, Body, Controller, Get, HttpCode, Post, Req, UnauthorizedException, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { IdentityService } from '../identity/identity.service';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { MfaService } from './mfa.service';

function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** Step 20: the authenticator app for privileged accounts. Not under /admin, so it is reachable before the check. */
@Controller('mfa')
@UseGuards(SessionGuard)
export class MfaController {
  constructor(private readonly mfa: MfaService, private readonly identity: IdentityService) {}

  @Get('status')
  async status(@Req() req: AuthenticatedRequest) {
    return mapped(async () => this.mfa.status(req.accountId as string, await this.sessionId(req)));
  }

  @Post('enrol/start')
  @HttpCode(200)
  start(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.mfa.startEnrolment(req.accountId as string));
  }

  @Post('enrol/confirm')
  @HttpCode(200)
  async confirm(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(async () => this.mfa.confirmEnrolment(req.accountId as string, await this.sessionId(req), b.code));
  }

  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(async () => this.mfa.verify(req.accountId as string, await this.sessionId(req), { code: b.code, recoveryCode: b.recoveryCode }));
  }

  /** SessionGuard resolved the account; the session id comes from the same token. */
  private async sessionId(req: AuthenticatedRequest): Promise<string> {
    const header = req.headers['authorization'];
    const token = (Array.isArray(header) ? header[0] : header)?.replace(/^Bearer /, '') ?? '';
    const s = await this.identity.authenticate(token);
    if (!s) throw new UnauthorizedException();
    return s.sessionId;
  }
}
