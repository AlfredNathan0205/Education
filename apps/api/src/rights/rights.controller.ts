import { BadRequestException, Body, Controller, Get, Header, HttpCode, Param, Post, Req, UseGuards } from '@nestjs/common';
import { mapped } from '../recommendation/recommendation.controller';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { RightsService } from './rights.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function uuid(v: string, what: string): string {
  if (!UUID.test(v)) throw new BadRequestException(`${what} is not valid`);
  return v;
}
function optionalStudent(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new BadRequestException('Request body must be a JSON object');
  const s = (raw as Record<string, unknown>).studentId;
  if (s === undefined || s === null) return null;
  if (typeof s !== 'string') throw new BadRequestException('student id is not valid');
  return uuid(s, 'student id');
}

/** Step 20: a copy of your data, and deleting it (your own, or a child's you approve). */
@Controller('privacy')
@UseGuards(SessionGuard)
export class RightsController {
  constructor(private readonly rights: RightsService) {}

  @Get('rights')
  overview(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.rights.overview(req.accountId as string));
  }

  @Get('export')
  @Header('Content-Disposition', 'attachment; filename="exam-app-data.json"')
  exportMine(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.rights.exportFor(req.accountId as string, null));
  }

  @Get('export/:studentId')
  @Header('Content-Disposition', 'attachment; filename="exam-app-data.json"')
  exportChild(@Req() req: AuthenticatedRequest, @Param('studentId') studentId: string) {
    return mapped(() => this.rights.exportFor(req.accountId as string, uuid(studentId, 'student id')));
  }

  @Post('erasure')
  @HttpCode(200)
  erase(@Req() req: AuthenticatedRequest, @Body() raw: unknown) {
    const studentId = optionalStudent(raw);
    return mapped(() => this.rights.requestErasure(req.accountId as string, studentId));
  }

  @Post('erasure/:id/cancel')
  @HttpCode(200)
  cancel(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    return mapped(() => this.rights.cancelErasure(req.accountId as string, uuid(id, 'request id')));
  }
}
