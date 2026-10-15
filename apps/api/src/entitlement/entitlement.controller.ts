import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { EntitlementService } from './entitlement.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: string, what: string): string {
  if (!UUID.test(v)) throw new BadRequestException(`${what} is not valid`);
  return v;
}
function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}

/** The student's own plan and today's limits (Step 18). */
@Controller('entitlements')
@UseGuards(SessionGuard)
export class EntitlementController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Get()
  mine(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.entitlements.mine(req.accountId as string));
  }
}

/** Plans for administrators (SUPER_ADMIN only; every action audited). No prices and no payments: grants only. */
@Controller('admin/entitlements')
@UseGuards(SessionGuard)
export class AdminEntitlementController {
  constructor(private readonly entitlements: EntitlementService) {}

  @Post('lookup')
  @HttpCode(200)
  lookup(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = body(raw);
    return mapped(() => this.entitlements.lookup(req.accountId as string, b.email));
  }

  @Get('students/:id')
  student(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const sid = uuid(id, 'student id');
    return mapped(() => this.entitlements.forStaff(req.accountId as string, sid));
  }

  @Post('students/:id/subscriptions')
  @HttpCode(200)
  grantPlan(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    const sid = uuid(id, 'student id');
    const b = body(raw);
    return mapped(() => this.entitlements.grantPlan(req.accountId as string, { studentId: sid, planCode: b.planCode, holderEmail: b.holderEmail, endsAt: b.endsAt, reason: b.reason }));
  }

  @Post('subscriptions/:id/end')
  @HttpCode(200)
  end(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    const subId = uuid(id, 'subscription id');
    const b = body(raw);
    return mapped(() => this.entitlements.endSubscription(req.accountId as string, subId, b.reason));
  }

  @Post('students/:id/grants')
  @HttpCode(200)
  grant(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown) {
    const sid = uuid(id, 'student id');
    const b = body(raw);
    return mapped(() => this.entitlements.grantEntitlement(req.accountId as string, { studentId: sid, key: b.key, value: b.value, endsAt: b.endsAt, reason: b.reason }));
  }

  @Post('grants/:id/revoke')
  @HttpCode(200)
  revoke(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const gid = uuid(id, 'grant id');
    return mapped(() => this.entitlements.revokeGrant(req.accountId as string, gid));
  }
}
