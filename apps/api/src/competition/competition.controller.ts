import { BadRequestException, Body, Controller, Get, Put, Req, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { CompetitionService, type CompeteView } from './competition.service';

/** The student's Compete page (Step 15): this week's boards, their own standing and XP, and who may see them. */
@Controller('compete')
@UseGuards(SessionGuard)
export class CompetitionController {
  constructor(private readonly competition: CompetitionService) {}

  @Get()
  view(@Req() req: AuthenticatedRequest): Promise<CompeteView> {
    return mapped(() => this.competition.view(req.accountId as string));
  }

  @Put('visibility')
  visibility(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = (raw ?? {}) as Record<string, unknown>;
    if (typeof b !== 'object' || Array.isArray(b) || typeof b.shown !== 'boolean') throw new BadRequestException('shown must be true or false');
    return mapped(() => this.competition.setShown(req.accountId as string, b.shown as boolean));
  }
}
