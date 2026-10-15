import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from '../exam/exam.errors';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { SocialDisabledError, SocialService } from './social.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string, what: string) => {
  if (!UUID.test(v)) throw new BadRequestException(`${what} is not valid`);
  return v;
};
const body = (raw: unknown): Record<string, unknown> => (raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {});

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    // Switched off: the routes do not exist.
    if (e instanceof SocialDisabledError || e instanceof ExamNotFoundError) throw new NotFoundException(e.message);
    if (e instanceof ExamNotPermittedError) throw new ForbiddenException(e.message);
    if (e instanceof ExamConflictError || e instanceof ExamUnavailableError) throw new ConflictException(e.message);
    if (e instanceof ExamInputError) throw new BadRequestException(e.message);
    if ((e as { code?: string }).code === 'P2002') throw new ConflictException('That conflicts with something that already exists');
    throw e;
  }
}

/** Friends and ranked challenges for the signed-in student (Step 16). 404 everywhere while switched off. */
@Controller('social')
@UseGuards(SessionGuard)
export class SocialController {
  constructor(private readonly social: SocialService) {}

  @Get()
  overview(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.social.overview(req.accountId as string));
  }

  @Post('code')
  @HttpCode(200)
  code(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.social.createCode(req.accountId as string));
  }

  @Post('friends')
  @HttpCode(200)
  redeem(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return mapped(() => this.social.redeem(req.accountId as string, body(raw).code));
  }

  @Post('friends/:id/unfriend')
  @HttpCode(200)
  unfriend(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.unfriend(req.accountId as string, uuid(id, 'friend id')));
  }

  @Post('friends/:id/block')
  @HttpCode(200)
  block(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.block(req.accountId as string, uuid(id, 'friend id')));
  }

  @Post('friends/:id/report')
  @HttpCode(200)
  reportFriend(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return mapped(() => this.social.report(req.accountId as string, { friendshipId: uuid(id, 'friend id'), reason: body(raw).reason }));
  }

  @Post('challenges')
  @HttpCode(200)
  challenge(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() =>
      this.social.createChallenge(req.accountId as string, { friendshipId: uuid(String(b.friendshipId ?? ''), 'friend id'), subjectVersionId: uuid(String(b.subjectVersionId ?? ''), 'subject') }),
    );
  }

  @Post('challenges/:id/accept')
  @HttpCode(200)
  accept(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.respond(req.accountId as string, uuid(id, 'challenge id'), true));
  }

  @Post('challenges/:id/decline')
  @HttpCode(200)
  decline(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.respond(req.accountId as string, uuid(id, 'challenge id'), false));
  }

  @Post('challenges/:id/start')
  @HttpCode(200)
  start(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.start(req.accountId as string, uuid(id, 'challenge id')));
  }

  @Post('challenges/:id/report')
  @HttpCode(200)
  reportChallenge(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return mapped(() => this.social.report(req.accountId as string, { challengeId: uuid(id, 'challenge id'), reason: body(raw).reason }));
  }
}

/** A guardian approves or declines a friendship of their child (Step 16, PM decision). */
@Controller('guardian/friendships')
@UseGuards(SessionGuard)
export class GuardianFriendshipController {
  constructor(private readonly social: SocialService) {}

  @Get()
  pending(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.social.guardianPending(req.accountId as string));
  }

  @Post(':id/approve')
  @HttpCode(200)
  approve(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.guardianDecide(req.accountId as string, uuid(id, 'request id'), true));
  }

  @Post(':id/decline')
  @HttpCode(200)
  decline(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.social.guardianDecide(req.accountId as string, uuid(id, 'request id'), false));
  }
}

/** The safety report queue (SUPER_ADMIN until a dedicated safety role exists). */
@Controller('admin/safety')
@UseGuards(SessionGuard)
export class SafetyAdminController {
  constructor(private readonly social: SocialService) {}

  @Get('reports')
  reports(@Req() req: AuthenticatedRequest, @Query('status') status?: string) {
    if (status !== undefined && status !== 'OPEN' && status !== 'RESOLVED') throw new BadRequestException('status must be OPEN or RESOLVED');
    return mapped(() => this.social.reports(req.accountId as string, (status as 'OPEN' | 'RESOLVED') ?? 'OPEN'));
  }

  @Post('reports/:id/resolve')
  @HttpCode(200)
  resolve(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    return mapped(() => this.social.resolve(req.accountId as string, uuid(id, 'report id'), body(raw).resolution as any));
  }
}
