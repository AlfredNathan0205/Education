import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { ReadinessService } from './readiness.service';
import { ReleaseService } from './release.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: string, what: string): string {
  if (!UUID.test(v)) throw new BadRequestException(`${what} is not valid`);
  return v;
}
function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** Step 21: content readiness and release tiers (curriculum staff; releases by approvers; under /admin, so MFA applies). */
@Controller('admin/readiness')
@UseGuards(SessionGuard)
export class ReadinessController {
  constructor(private readonly readiness: ReadinessService, private readonly release: ReleaseService) {}

  @Get('policy')
  policy(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.readiness.policyView(req.accountId as string));
  }

  @Get('units')
  units(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.readiness.units(req.accountId as string));
  }

  @Post('units/:id/report')
  @HttpCode(200)
  generate(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.readiness.generate(req.accountId as string, uuid(id, 'subject id')));
  }

  @Get('units/:id/history')
  history(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.readiness.history(req.accountId as string, uuid(id, 'subject id')));
  }

  @Post('units/:id/release')
  @HttpCode(200)
  changeTier(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() => this.readiness.changeTier(req.accountId as string, uuid(id, 'subject id'), { to: b.to, reportId: b.reportId, note: b.note }));
  }

  @Get('reports/:id')
  report(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.readiness.report(req.accountId as string, uuid(id, 'report id')));
  }

  @Get('access')
  access(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.release.listAccess(req.accountId as string));
  }

  @Post('access')
  @HttpCode(200)
  grant(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() => this.release.grantAccess(req.accountId as string, { email: b.email, tier: b.tier, reason: b.reason }));
  }

  @Post('access/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.release.revokeAccess(req.accountId as string, uuid(id, 'access id')));
  }
}
