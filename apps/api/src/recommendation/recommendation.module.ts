import { Module } from '@nestjs/common';
import { ExamModule } from '../exam/exam.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { RecommendationController } from './recommendation.controller';
import { RecommendationService } from './recommendation.service';
import { RecommendationSweeper } from './sweeper';

@Module({
  imports: [ExamModule, IdentityModule, OutboxModule],
  controllers: [RecommendationController],
  providers: [RecommendationService, RecommendationSweeper, SessionGuard],
  exports: [RecommendationService],
})
export class RecommendationModule {}
