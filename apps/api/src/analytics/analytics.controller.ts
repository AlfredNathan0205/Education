import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Put, Req, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { AnalyticsService } from './analytics.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: string, what: string): string {
  if (!UUID.test(v)) throw new BadRequestException(`${what} is not valid`);
  return v;
}
function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** Step 19, the student side: their analytics choice, and the few UI events the web app sends. */
@Controller('analytics')
@UseGuards(SessionGuard)
export class AnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('consent')
  consent(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.analytics.myConsent(req.accountId as string));
  }

  @Put('consent')
  setConsent(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() => this.analytics.setMyConsent(req.accountId as string, { granted: b.granted, consentVersion: b.consentVersion }));
  }

  /** Always 204: the client is never told whether the event was kept. */
  @Post('events')
  @HttpCode(204)
  async event(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<void> {
    const b = body(raw);
    await mapped(() => this.analytics.recordClient(req.accountId as string, b.name));
  }
}

/** Step 19, the guardian side: the analytics choice for each child they approved. */
@Controller('guardian/analytics-consent')
@UseGuards(SessionGuard)
export class GuardianAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.analytics.guardianConsents(req.accountId as string));
  }

  @Put(':studentId')
  set(@Req() req: AuthenticatedRequest, @Param('studentId') studentId: string, @Body() raw: unknown) {
    const sid = uuid(studentId, 'student id');
    const b = body(raw);
    return mapped(() => this.analytics.setGuardianConsent(req.accountId as string, sid, { granted: b.granted, consentVersion: b.consentVersion }));
  }
}

/** Step 19, administrators: aggregate metrics and experiments (SUPER_ADMIN; audited). */
@Controller('admin/analytics')
@UseGuards(SessionGuard)
export class AdminAnalyticsController {
  constructor(private readonly analytics: AnalyticsService) {}

  @Get('metrics')
  metrics(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.analytics.metrics(req.accountId as string));
  }

  @Get('experiments')
  experiments(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.analytics.experiments(req.accountId as string));
  }

  @Post('experiments')
  @HttpCode(200)
  create(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() => this.analytics.createExperiment(req.accountId as string, { key: b.key, description: b.description, variants: b.variants }));
  }

  @Post('experiments/:id/start')
  @HttpCode(200)
  start(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const eid = uuid(id, 'experiment id');
    return mapped(() => this.analytics.setExperimentStatus(req.accountId as string, eid, 'RUNNING'));
  }

  @Post('experiments/:id/stop')
  @HttpCode(200)
  stop(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const eid = uuid(id, 'experiment id');
    return mapped(() => this.analytics.setExperimentStatus(req.accountId as string, eid, 'STOPPED'));
  }
}
