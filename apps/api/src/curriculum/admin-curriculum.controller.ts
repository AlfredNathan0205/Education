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
  Req,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { CurriculumConflictError, CurriculumForbiddenError, CurriculumNotFoundError } from './curriculum.errors';
import { CurriculumTransitionError } from './curriculum-state';
import { ContentImportService, type ImportResult } from './import/content-import.service';
import type { ImportFormat } from './import/content-import';
import type { UnitSummary } from './curriculum.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function unitId(raw: string): string {
  if (!UUID.test(raw)) throw new BadRequestException('unit id is not valid');
  return raw;
}

export function parseUploadBody(raw: unknown): { format: ImportFormat; text: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  const b = raw as Record<string, unknown>;
  if (b.format !== 'csv' && b.format !== 'json') throw new BadRequestException('format must be csv or json');
  if (typeof b.text !== 'string') throw new BadRequestException('text must be the contents of the file');
  return { format: b.format, text: b.text };
}

/**
 * Admin endpoints for curriculum content. The caller is identified only by the session; the role is
 * read from the database on every call (ContentImportService). A student account simply has no role.
 */
@Controller('admin/curriculum')
@UseGuards(SessionGuard)
export class AdminCurriculumController {
  constructor(private readonly imports: ContentImportService) {}

  @Get('units')
  units(@Req() req: AuthenticatedRequest): Promise<UnitSummary[]> {
    return this.map(() => this.imports.listUnits(req.accountId as string));
  }

  @Post('units/:id/content/preview')
  @HttpCode(200)
  preview(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown): Promise<ImportResult> {
    const { format, text } = parseUploadBody(raw);
    return this.map(() => this.imports.preview(req.accountId as string, unitId(id), format, text));
  }

  @Put('units/:id/content')
  upload(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Body() raw: unknown): Promise<ImportResult> {
    const { format, text } = parseUploadBody(raw);
    return this.map(() => this.imports.upload(req.accountId as string, unitId(id), format, text));
  }

  @Post('units/:id/submit')
  @HttpCode(200)
  submit(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return this.map(() => this.imports.submit(req.accountId as string, unitId(id)));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof CurriculumForbiddenError) throw new ForbiddenException(e.message);
      if (e instanceof CurriculumNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof CurriculumConflictError || e instanceof CurriculumTransitionError) throw new ConflictException(e.message);
      throw e;
    }
  }
}
