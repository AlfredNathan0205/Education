import { Module } from '@nestjs/common';
import { ExamModule } from '../exam/exam.module';
import { IdentityModule } from '../identity/identity.module';
import { SessionGuard } from '../student/session.guard';
import { HomeController } from './home.controller';
import { HomeService } from './home.service';

@Module({
  imports: [ExamModule, IdentityModule],
  controllers: [HomeController],
  providers: [HomeService, SessionGuard],
})
export class HomeModule {}
