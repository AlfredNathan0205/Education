import { BadRequestException, Controller, ForbiddenException, Get, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { MasteryViewService } from './mastery-view.service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ExamNotPermittedError) throw new ForbiddenException(e.message);
    if (e instanceof ExamNotFoundError) throw new NotFoundException(e.message);
    throw e;
  }
}

/** The student's own mastery: labels only. */
@Controller('mastery')
@UseGuards(SessionGuard)
export class MasteryController {
  constructor(private readonly views: MasteryViewService) {}

  @Get()
  mine(@Req() req: AuthenticatedRequest) {
    return mapped(() => this.views.mine(req.accountId as string));
  }
}

/** The numbers behind a student's mastery, for academic staff. Every view is audited. */
@Controller('admin/mastery')
@UseGuards(SessionGuard)
export class MasteryAdminController {
  constructor(private readonly views: MasteryViewService) {}

  @Get('students/:id')
  student(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
    if (!UUID.test(id)) throw new BadRequestException('student id is not valid');
    return mapped(() => this.views.forStaff(req.accountId as string, id));
  }
}
