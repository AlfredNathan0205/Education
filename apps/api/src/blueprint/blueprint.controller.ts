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
import { BlueprintInputError } from './blueprint-domain';
import { BlueprintConflictError, BlueprintForbiddenError, BlueprintNotFoundError } from './blueprint.errors';
import { BlueprintService } from './blueprint.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: string, what: string) => {
  if (!UUID.test(raw)) throw new BadRequestException(`${what} id is not valid`);
  return raw;
};
const obj = (raw: unknown): Record<string, unknown> => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  return raw as Record<string, unknown>;
};

/** Admin endpoints for test designs. Ids and bodies are checked here, before any work starts; roles are read on every call. */
@Controller('admin/blueprints')
@UseGuards(SessionGuard)
export class BlueprintController {
  constructor(private readonly blueprints: BlueprintService) {}

  @Get()
  list(@Req() req: AuthenticatedRequest) {
    return this.map(() => this.blueprints.list(req.accountId as string));
  }

  @Post()
  @HttpCode(200)
  create(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const b = obj(raw);
    return this.map(() => this.blueprints.create(req.accountId as string, b));
  }

  @Get(':id')
  detail(@Req() req: AuthenticatedRequest, @Param('id') raw: string) {
    const bid = id(raw, 'blueprint');
    return this.map(() => this.blueprints.detail(req.accountId as string, bid));
  }

  @Put(':id/draft')
  saveDraft(@Req() req: AuthenticatedRequest, @Param('id') raw: string, @Body() body: unknown) {
    const bid = id(raw, 'blueprint');
    const b = obj(body);
    return this.map(() => this.blueprints.saveDraft(req.accountId as string, bid, b));
  }

  @Post(':id/draft/discard')
  @HttpCode(200)
  discard(@Req() req: AuthenticatedRequest, @Param('id') raw: string) {
    const bid = id(raw, 'blueprint');
    return this.map(() => this.blueprints.discardDraft(req.accountId as string, bid));
  }

  @Post(':id/draft/publish')
  @HttpCode(200)
  publish(@Req() req: AuthenticatedRequest, @Param('id') raw: string) {
    const bid = id(raw, 'blueprint');
    return this.map(() => this.blueprints.publishDraft(req.accountId as string, bid));
  }

  @Post(':id/enabled')
  @HttpCode(200)
  enabled(@Req() req: AuthenticatedRequest, @Param('id') raw: string, @Body() body: unknown) {
    const bid = id(raw, 'blueprint');
    const b = obj(body);
    if (typeof b.enabled !== 'boolean') throw new BadRequestException('enabled must be true or false');
    const on = b.enabled;
    return this.map(() => this.blueprints.setEnabled(req.accountId as string, bid, on));
  }

  @Post('versions/:id/preview')
  @HttpCode(200)
  preview(@Req() req: AuthenticatedRequest, @Param('id') raw: string, @Body() body: unknown) {
    const vid = id(raw, 'blueprint version');
    const b = obj(body);
    const unitId = typeof b.unitId === 'string' ? id(b.unitId, 'subject') : (() => {
      throw new BadRequestException('unitId is required');
    })();
    if (b.seed !== undefined && typeof b.seed !== 'string') throw new BadRequestException('seed must be text');
    const seed = b.seed as string | undefined;
    return this.map(() => this.blueprints.preview(req.accountId as string, vid, unitId, seed === '' ? undefined : seed));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof BlueprintInputError) throw new BadRequestException(e.problems.join('; '));
      if (e instanceof BlueprintForbiddenError) throw new ForbiddenException(e.message);
      if (e instanceof BlueprintNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof BlueprintConflictError) throw new ConflictException(e.message);
      throw e;
    }
  }
}
