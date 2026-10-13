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
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import {
  ExamConflictError,
  ExamInputError,
  ExamNotFoundError,
  ExamNotPermittedError,
  ExamUnavailableError,
} from './exam.errors';
import {
  ExamService,
  type AssessmentSummaryRow,
  type AssessmentView,
  type ExamUnitView,
  type LockResult,
  type ResultView,
} from './exam.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9_-]{8,64}$/;

function uuid(value: unknown, what: string): string {
  if (typeof value !== 'string' || !UUID.test(value)) throw new BadRequestException(`${what} is not valid`);
  return value;
}
function position(value: unknown): number {
  if (typeof value !== 'string' || !/^\d{1,2}$/.test(value)) throw new BadRequestException('question position is not valid');
  return Number(value);
}
function body(raw: unknown): Record<string, unknown> {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}

@Controller('exam')
@UseGuards(SessionGuard)
export class ExamController {
  constructor(private readonly exam: ExamService) {}

  @Get('units')
  units(@Req() req: AuthenticatedRequest): Promise<ExamUnitView[]> {
    return this.map(() => this.exam.listUnits(req.accountId as string));
  }

  @Get('assessments')
  mine(@Req() req: AuthenticatedRequest): Promise<AssessmentSummaryRow[]> {
    return this.map(() => this.exam.listMine(req.accountId as string));
  }

  @Post('assessments')
  @HttpCode(200)
  async create(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<{ assessmentId: string; resumed: boolean }> {
    const b = body(raw);
    const subjectVersionId = uuid(b.subjectVersionId, 'subjectVersionId');
    if (typeof b.mode !== 'string') throw new BadRequestException('mode must be TEST or PRACTICE');
    if (b.blueprint !== undefined && (typeof b.blueprint !== 'string' || !/^[A-Z][A-Z0-9_]{1,31}$/.test(b.blueprint))) {
      throw new BadRequestException('blueprint is not valid');
    }
    const blueprint = b.blueprint as string | undefined;
    return this.map(() => this.exam.create(req.accountId as string, { subjectVersionId, mode: b.mode as string, ...(blueprint ? { blueprint } : {}) }));
  }

  @Post('assessments/:id/present')
  @HttpCode(200)
  async present(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<AssessmentView> {
    const assessmentId = uuid(id, 'assessment id');
    return this.map(() => this.exam.present(req.accountId as string, assessmentId));
  }

  @Post('assessments/:id/questions/:position/lock')
  @HttpCode(200)
  async lock(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('position') pos: string,
    @Body() raw: unknown,
  ): Promise<LockResult> {
    const assessmentId = uuid(id, 'assessment id');
    const p = position(pos);
    const b = body(raw);
    if (typeof b.slot !== 'number' || !Number.isInteger(b.slot) || b.slot < 0 || b.slot > 3) {
      throw new BadRequestException('slot must be 0, 1, 2 or 3');
    }
    if (typeof b.idempotencyKey !== 'string' || !KEY.test(b.idempotencyKey)) {
      throw new BadRequestException('idempotencyKey must be 8 to 64 letters, digits, - or _');
    }
    const input = { slot: b.slot, activeMs: b.activeMs, idempotencyKey: b.idempotencyKey };
    return this.map(() => this.exam.lock(req.accountId as string, assessmentId, p, input));
  }

  @Post('assessments/:id/questions/:position/skip')
  @HttpCode(200)
  async skip(
    @Req() req: AuthenticatedRequest,
    @Param('id') id: string,
    @Param('position') pos: string,
    @Body() raw: unknown,
  ): Promise<{ skipped: true }> {
    const assessmentId = uuid(id, 'assessment id');
    const p = position(pos);
    const b = body(raw);
    return this.map(() => this.exam.skip(req.accountId as string, assessmentId, p, { activeMs: b.activeMs }));
  }

  @Post('assessments/:id/review-skipped')
  @HttpCode(200)
  async reviewSkipped(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ ok: true }> {
    const assessmentId = uuid(id, 'assessment id');
    return this.map(() => this.exam.reviewSkipped(req.accountId as string, assessmentId));
  }

  @Post('assessments/:id/submit')
  @HttpCode(200)
  async submit(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<{ submitted: true }> {
    const assessmentId = uuid(id, 'assessment id');
    return this.map(() => this.exam.submit(req.accountId as string, assessmentId));
  }

  @Get('assessments/:id/result')
  async result(@Req() req: AuthenticatedRequest, @Param('id') id: string): Promise<ResultView> {
    const assessmentId = uuid(id, 'assessment id');
    return this.map(() => this.exam.result(req.accountId as string, assessmentId));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
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
}
