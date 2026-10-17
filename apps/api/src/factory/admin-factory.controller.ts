import { BadRequestException, Body, Controller, Get, HttpCode, Param, Post, Query, Req, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { AdminFactoryService } from './admin-factory.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = (v: string, what: string) => {
  if (!UUID.test(v)) throw new BadRequestException(`${what} is not valid`);
  return v;
};

/** Step 22: AI question drafting from the admin page (under /admin, so the authenticator check applies). */
@Controller('admin/factory')
@UseGuards(SessionGuard)
export class AdminFactoryController {
  constructor(private readonly factory: AdminFactoryService) {}

  @Get('status')
  status(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.factory.status(req.accountId as string));
  }

  @Get('units/:id/suggestions')
  suggestions(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Query('target') target?: string) {
    return mapped(() => this.factory.suggestions(req.accountId as string, uuid(id, 'subject id'), target));
  }

  @Get('batches')
  batches(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.factory.batches(req.accountId as string));
  }

  @Post('batches')
  @HttpCode(200)
  run(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    return mapped(() => this.factory.run(req.accountId as string, raw));
  }

  @Post('batches/:id/stop')
  @HttpCode(200)
  stop(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.factory.stop(req.accountId as string, uuid(id, 'batch id')));
  }
}
