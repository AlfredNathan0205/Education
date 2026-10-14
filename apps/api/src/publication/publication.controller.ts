import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, NotFoundException, Param, Post, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { decision } from '../question/question.controller';
import { PublicationConflictError, PublicationForbiddenError, PublicationNotFoundError } from './publication.errors';
import { PublicationService } from './publication.service';
import { QuestionConflictError, QuestionForbiddenError, QuestionNotFoundError } from '../question/question.errors';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (raw: string, what: string) => {
  if (!UUID.test(raw)) throw new BadRequestException(`${what} id is not valid`);
  return raw;
};

export function healthInput(raw: unknown): { health: string; reasonCode: string; note: string } {
  const d = decision(raw);
  const b = raw as Record<string, unknown>;
  if (typeof b.health !== 'string') throw new BadRequestException('health must be text');
  return { health: b.health, ...d };
}

/** Admin endpoints for publication. Roles are read from the database on every call. */
@Controller('admin/publication')
@UseGuards(SessionGuard)
export class PublicationController {
  constructor(private readonly publication: PublicationService) {}

  @Get('units/:id/summary')
  summary(@Req() req: AuthenticatedRequest, @Param('id') unit: string) {
    const uid = id(unit, 'unit');
    return this.map(() => this.publication.summary(req.accountId as string, uid));
  }

  @Post('units/:id/publish-all')
  @HttpCode(200)
  publishAll(@Req() req: AuthenticatedRequest, @Param('id') unit: string) {
    const uid = id(unit, 'unit');
    return this.map(() => this.publication.publishUnit(req.accountId as string, uid));
  }

  @Post('revisions/:id/publish')
  @HttpCode(200)
  publish(@Req() req: AuthenticatedRequest, @Param('id') rev: string) {
    const rid = id(rev, 'question');
    return this.map(() => this.publication.publish(req.accountId as string, rid));
  }

  @Post('revisions/:id/withdraw')
  @HttpCode(200)
  async withdraw(@Req() req: AuthenticatedRequest, @Param('id') rev: string, @Body() raw: unknown) {
    const rid = id(rev, 'question');
    const d = decision(raw);
    await this.map(() => this.publication.withdraw(req.accountId as string, rid, d));
    return { withdrawn: true };
  }

  @Post('revisions/:id/health')
  @HttpCode(200)
  async health(@Req() req: AuthenticatedRequest, @Param('id') rev: string, @Body() raw: unknown) {
    const rid = id(rev, 'question');
    const h = healthInput(raw);
    await this.map(() => this.publication.setHealth(req.accountId as string, rid, h));
    return { health: h.health };
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof PublicationForbiddenError || e instanceof QuestionForbiddenError) throw new ForbiddenException((e as Error).message);
      if (e instanceof PublicationNotFoundError || e instanceof QuestionNotFoundError) throw new NotFoundException((e as Error).message);
      if (e instanceof PublicationConflictError || e instanceof QuestionConflictError) throw new ConflictException((e as Error).message);
      throw e;
    }
  }
}
