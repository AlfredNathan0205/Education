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
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import type { UnitSummary } from '../curriculum/curriculum.service';
import { QuestionBankService, type QuestionImportResult } from './question-bank.service';
import { QuestionTransitionError, type QuestionState } from './question-domain';
import { QuestionConflictError, QuestionForbiddenError, QuestionNotFoundError } from './question.errors';
import type { QuestionDetail, QuestionRow } from './question.service';
import type { QuestionFormat } from './import/question-import';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STATES: readonly QuestionState[] = ['DRAFT', 'IN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'RETIRED', 'SUPERSEDED'];

function id(raw: string, what: string): string {
  if (!UUID.test(raw)) throw new BadRequestException(`${what} id is not valid`);
  return raw;
}

function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}

export function parseQuestionUpload(raw: unknown): { format: QuestionFormat; text: string } {
  const b = obj(raw);
  if (b.format !== 'csv' && b.format !== 'json') throw new BadRequestException('format must be csv or json');
  if (typeof b.text !== 'string') throw new BadRequestException('text must be the contents of the file');
  return { format: b.format, text: b.text };
}

function note(raw: unknown): string {
  const b = obj(raw);
  if (typeof b.note !== 'string') throw new BadRequestException('note must be text');
  return b.note;
}

/**
 * Admin endpoints for the question bank. The caller is known only by the session; the role is read from
 * the database on every call. A student account has no curriculum role and is refused.
 */
@Controller('admin/questions')
@UseGuards(SessionGuard)
export class QuestionController {
  constructor(private readonly bank: QuestionBankService) {}

  @Get('units')
  units(@Req() req: AuthenticatedRequest): Promise<UnitSummary[]> {
    return this.map(() => this.bank.listUnits(req.accountId as string));
  }

  @Get('units/:id/questions')
  list(@Req() req: AuthenticatedRequest, @Param('id') unit: string, @Query('state') state?: string): Promise<QuestionRow[]> {
    if (state !== undefined && !(STATES as readonly string[]).includes(state)) throw new BadRequestException('state is not valid');
    return this.map(() => this.bank.list(req.accountId as string, id(unit, 'unit'), state as QuestionState | undefined));
  }

  @Post('units/:id/preview')
  @HttpCode(200)
  preview(@Req() req: AuthenticatedRequest, @Param('id') unit: string, @Body() raw: unknown): Promise<QuestionImportResult> {
    const { format, text } = parseQuestionUpload(raw);
    return this.map(() => this.bank.preview(req.accountId as string, id(unit, 'unit'), format, text));
  }

  @Put('units/:id/questions')
  upload(@Req() req: AuthenticatedRequest, @Param('id') unit: string, @Body() raw: unknown): Promise<QuestionImportResult> {
    const { format, text } = parseQuestionUpload(raw);
    return this.map(() => this.bank.upload(req.accountId as string, id(unit, 'unit'), format, text));
  }

  @Get('revisions/:id')
  detail(@Req() req: AuthenticatedRequest, @Param('id') rev: string): Promise<QuestionDetail> {
    return this.map(() => this.bank.detail(req.accountId as string, id(rev, 'question')));
  }

  @Post('revisions/:id/submit')
  @HttpCode(200)
  submit(@Req() req: AuthenticatedRequest, @Param('id') rev: string) {
    return this.map(() => this.bank.submit(req.accountId as string, id(rev, 'question')));
  }

  @Post('revisions/:id/approve')
  @HttpCode(200)
  approve(@Req() req: AuthenticatedRequest, @Param('id') rev: string, @Body() raw: unknown) {
    const b = obj(raw);
    if (typeof b.answerVerified !== 'boolean') throw new BadRequestException('answerVerified must be true or false');
    if (b.note !== undefined && typeof b.note !== 'string') throw new BadRequestException('note must be text');
    return this.map(() =>
      this.bank.approve(req.accountId as string, id(rev, 'question'), { answerVerified: b.answerVerified as boolean, note: (b.note as string | undefined) ?? null }),
    );
  }

  @Post('revisions/:id/request-changes')
  @HttpCode(200)
  requestChanges(@Req() req: AuthenticatedRequest, @Param('id') rev: string, @Body() raw: unknown) {
    return this.map(() => this.bank.requestChanges(req.accountId as string, id(rev, 'question'), note(raw)));
  }

  @Post('revisions/:id/retire')
  @HttpCode(200)
  retire(@Req() req: AuthenticatedRequest, @Param('id') rev: string, @Body() raw: unknown) {
    return this.map(() => this.bank.retire(req.accountId as string, id(rev, 'question'), note(raw)));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof QuestionForbiddenError) throw new ForbiddenException(e.message);
      if (e instanceof QuestionNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof QuestionConflictError || e instanceof QuestionTransitionError) throw new ConflictException(e.message);
      throw e;
    }
  }
}
