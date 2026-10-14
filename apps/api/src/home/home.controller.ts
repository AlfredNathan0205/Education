import { Controller, ForbiddenException, Get, Req, UseGuards } from '@nestjs/common';
import { ExamNotPermittedError } from '../exam/exam.errors';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { HomeService, type HomeView } from './home.service';

@Controller('home')
@UseGuards(SessionGuard)
export class HomeController {
  constructor(private readonly homes: HomeService) {}

  @Get()
  async home(@Req() req: AuthenticatedRequest): Promise<HomeView> {
    try {
      return await this.homes.home(req.accountId as string);
    } catch (e) {
      if (e instanceof ExamNotPermittedError) throw new ForbiddenException(e.message);
      throw e;
    }
  }
}
