import { Module } from '@nestjs/common';
import { ExamModule } from '../exam/exam.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { CompetitionController } from './competition.controller';
import { CompetitionService } from './competition.service';
import { CompetitionSweeper } from './sweeper';

@Module({
  imports: [ExamModule, IdentityModule, OutboxModule],
  controllers: [CompetitionController],
  providers: [CompetitionService, CompetitionSweeper, SessionGuard],
  exports: [CompetitionService],
})
export class CompetitionModule {}
