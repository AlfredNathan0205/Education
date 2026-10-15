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
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from '../exam/exam.errors';
import { INVITE_TOKEN_PATTERN } from '../guardian/guardian-domain';
import { GuardianRateLimitedError, GuardianUnavailableError } from '../guardian/guardian.errors';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { ParentService } from './parent.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new BadRequestException(`${what} is not valid`);
  return value;
}
function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}
function token(raw: unknown): string {
  const t = body(raw).token;
  if (typeof t !== 'string' || !INVITE_TOKEN_PATTERN.test(t)) throw new BadRequestException('This link is not valid');
  return t;
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExamNotFoundError) throw new NotFoundException(e.message);
    if (e instanceof ExamNotPermittedError) throw new ForbiddenException(e.message);
    if (e instanceof ExamConflictError || e instanceof ExamUnavailableError) throw new ConflictException(e.message);
    if (e instanceof ExamInputError) throw new BadRequestException(e.message);
    if (e instanceof GuardianRateLimitedError) throw new HttpException(e.message, 429);
    if (e instanceof GuardianUnavailableError) throw new ServiceUnavailableException(e.message);
    if ((e as { code?: string }).code === 'P2002') throw new ConflictException('That request conflicts with an earlier one');
    throw e;
  }
}

/**
 * Step 17, the parent side: the students this account may see, a student's summary and weekly reports, and answering
 * an adult student's invitation. A student this account may not see is a 404, never a 403, so nothing leaks.
 * The invitation token travels in the request body, never in the path.
 */
@Controller('parent')
@UseGuards(SessionGuard)
export class ParentController {
  constructor(private readonly parent: ParentService) {}

  @Get('children')
  children(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.parent.children(req.accountId as string));
  }

  @Get('children/:id')
  dashboard(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const sid = uuid(id, 'student id');
    return mapped(() => this.parent.dashboard(req.accountId as string, sid));
  }

  @Get('children/:id/reports/:reportId')
  report(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Param('reportId') reportId: string) {
    const sid = uuid(id, 'student id');
    const rid = uuid(reportId, 'report id');
    return mapped(() => this.parent.report(req.accountId as string, sid, rid));
  }

  @Post('children/:id/leave')
  @HttpCode(200)
  leave(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const sid = uuid(id, 'student id');
    return mapped(() => this.parent.leave(req.accountId as string, sid));
  }

  @Post('invitations/preview')
  @HttpCode(200)
  preview(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const t = token(raw);
    return mapped(() => this.parent.previewInvitation(req.accountId as string, t));
  }

  @Post('invitations/accept')
  @HttpCode(200)
  accept(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const t = token(raw);
    return mapped(() => this.parent.acceptInvitation(req.accountId as string, t));
  }

  @Post('invitations/decline')
  @HttpCode(200)
  decline(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const t = token(raw);
    return mapped(() => this.parent.declineInvitation(req.accountId as string, t));
  }
}

/** Step 17, the student side: who can see my summary, sharing it (adults only), and "See what they see". */
@Controller('parent-sharing')
@UseGuards(SessionGuard)
export class ParentSharingController {
  constructor(private readonly parent: ParentService) {}

  @Get()
  status(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.parent.sharing(req.accountId as string));
  }

  @Post('invitations')
  @HttpCode(200)
  invite(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() => this.parent.invite(req.accountId as string, { email: b.email, consentVersion: b.consentVersion, agreed: b.agreed }));
  }

  @Post('invitations/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.parent.cancelInvitation(req.accountId as string));
  }

  @Post('viewers/:grantId/stop')
  @HttpCode(200)
  stop(@Req() req: AuthenticatedRequest, @Param('grantId') grantId: string) {
    const gid = uuid(grantId, 'id');
    return mapped(() => this.parent.stopSharing(req.accountId as string, gid));
  }

  @Get('preview')
  preview(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.parent.preview(req.accountId as string));
  }

  @Get('preview/reports/:reportId')
  previewReport(@Req() req: AuthenticatedRequest, @Param('reportId') reportId: string) {
    const rid = uuid(reportId, 'report id');
    return mapped(() => this.parent.previewReport(req.accountId as string, rid));
  }
}
