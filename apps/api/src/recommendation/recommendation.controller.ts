import {
  BadRequestException,
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
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from '../exam/exam.errors';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { RecommendationService, type RecommendationView } from './recommendation.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function uuid(value: string, what: string): string {
  if (!UUID.test(value)) throw new BadRequestException(`${what} is not valid`);
  return value;
}

export async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExamNotFoundError) throw new NotFoundException(e.message);
    if (e instanceof ExamNotPermittedError) throw new ForbiddenException(e.message);
    if (e instanceof ExamConflictError || e instanceof ExamUnavailableError) throw new ConflictException(e.message);
    if (e instanceof ExamInputError) throw new BadRequestException(e.message);
    if ((e as { code?: string }).code === 'P2002') throw new ConflictException('That request conflicts with an earlier one');
    throw e;
  }
}

/** The student's own recommendations (Step 14): list, start, put off, and practise what was missed in a test. */
@Controller('recommendations')
@UseGuards(SessionGuard)
export class RecommendationController {
  constructor(private readonly recs: RecommendationService) {}

  @Get()
  mine(@Req() req: AuthenticatedRequest): Promise<RecommendationView[]> {
    return mapped(() => this.recs.mine(req.accountId as string));
  }

  @Post(':id/start')
  @HttpCode(200)
  start(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const rid = uuid(id, 'recommendation id');
    return mapped(() => this.recs.start(req.accountId as string, rid));
  }

  @Post(':id/dismiss')
  @HttpCode(200)
  dismiss(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    const rid = uuid(id, 'recommendation id');
    return mapped(() => this.recs.dismiss(req.accountId as string, rid));
  }

  @Post('from-result/:assessmentId')
  @HttpCode(200)
  fromResult(@Req() req: AuthenticatedRequest, @Param('assessmentId') assessmentId: string) {
    const aid = uuid(assessmentId, 'assessment id');
    return mapped(() => this.recs.practiseMissed(req.accountId as string, aid));
  }
}
