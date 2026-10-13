import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  NotFoundException,
  Param,
  Post,
  Req,
  ServiceUnavailableException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { INVITE_TOKEN_PATTERN } from './guardian-domain';
import {
  GuardianConflictError,
  GuardianInputError,
  GuardianNotFoundError,
  GuardianNotPermittedError,
  GuardianRateLimitedError,
  GuardianUnavailableError,
} from './guardian.errors';
import { GuardianService, type GuardianStatusView, type InvitationPreview } from './guardian.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}
function token(raw: unknown): string {
  const t = body(raw).token;
  if (typeof t !== 'string' || !INVITE_TOKEN_PATTERN.test(t)) throw new BadRequestException('This link is not valid');
  return t;
}

@Controller('guardian')
@UseGuards(SessionGuard)
export class GuardianController {
  constructor(private readonly guardian: GuardianService) {}

  // student side
  @Post('invitations')
  @HttpCode(200)
  async create(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<{ maskedEmail: string; expiresAt: string }> {
    const b = body(raw);
    return this.map(() => this.guardian.createInvitation(req.accountId as string, { email: b.email, relationshipType: b.relationshipType }));
  }

  @Get('status')
  status(@Req() req: AuthenticatedRequest): Promise<GuardianStatusView> {
    return this.map(() => this.guardian.status(req.accountId as string));
  }

  @Post('invitations/cancel')
  @HttpCode(200)
  async cancel(@Req() req: AuthenticatedRequest): Promise<{ status: 'cancelled' }> {
    await this.map(() => this.guardian.cancelInvitation(req.accountId as string));
    return { status: 'cancelled' };
  }

  // guardian side (the token is the secret; it is sent in the body, never in the URL)
  @Post('invitations/preview')
  @HttpCode(200)
  async preview(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<InvitationPreview> {
    const t = token(raw);
    return this.map(() => this.guardian.preview(req.accountId as string, t));
  }

  @Post('invitations/accept')
  @HttpCode(200)
  async accept(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<{ status: 'approved' }> {
    const b = body(raw);
    const t = token(raw);
    await this.map(() => this.guardian.accept(req.accountId as string, { token: t, consentVersion: b.consentVersion, attested: b.attested }));
    return { status: 'approved' };
  }

  @Post('invitations/decline')
  @HttpCode(200)
  async decline(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<{ status: 'declined' }> {
    const t = token(raw);
    await this.map(() => this.guardian.decline(req.accountId as string, t));
    return { status: 'declined' };
  }

  @Get('approvals')
  approvals(@Req() req: AuthenticatedRequest) {
    return this.map(() => this.guardian.listApprovals(req.accountId as string));
  }

  @Post('approvals/:id/withdraw')
  @HttpCode(200)
  async withdraw(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ status: 'withdrawn' }> {
    if (!UUID.test(id)) throw new BadRequestException('approval id is not valid');
    await this.map(() => this.guardian.withdraw(req.accountId as string, id));
    return { status: 'withdrawn' };
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof GuardianNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof GuardianNotPermittedError) throw new ForbiddenException(e.message);
      if (e instanceof GuardianConflictError) throw new ConflictException(e.message);
      if (e instanceof GuardianInputError) throw new BadRequestException(e.message);
      if (e instanceof GuardianUnavailableError) throw new ServiceUnavailableException(e.message);
      if (e instanceof GuardianRateLimitedError) throw new HttpException(e.message, 429);
      throw e;
    }
  }
}
