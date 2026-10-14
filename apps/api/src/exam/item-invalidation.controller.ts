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
  Req,
  UseGuards,
} from '@nestjs/common';
import { decision } from '../question/question.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from './exam.errors';
import { ItemInvalidationService } from './item-invalidation.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: string) => {
  if (!UUID.test(raw)) throw new BadRequestException('question id is not valid');
  return raw;
};

/** InvalidateAssessmentItem: approvers take a wrong question version out of every test that used it. */
@Controller('admin/assessment-items')
@UseGuards(SessionGuard)
export class ItemInvalidationController {
  constructor(private readonly invalidations: ItemInvalidationService) {}

  @Get('revisions/:id/impact')
  impact(@Req() req: AuthenticatedRequest, @Param('id') raw: string) {
    const rid = id(raw);
    return this.map(() => this.invalidations.impact(req.accountId as string, rid));
  }

  @Post('revisions/:id/invalidate')
  @HttpCode(200)
  invalidate(@Req() req: AuthenticatedRequest, @Param('id') raw: string, @Body() body: unknown) {
    const rid = id(raw);
    const d = decision(body);
    return this.map(() => this.invalidations.invalidate(req.accountId as string, rid, d));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ExamNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof ExamNotPermittedError) throw new ForbiddenException(e.message);
      if (e instanceof ExamConflictError) throw new ConflictException(e.message);
      if (e instanceof ExamInputError) throw new BadRequestException(e.message);
      throw e;
    }
  }
}
