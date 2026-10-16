import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { RetentionService } from './retention.service';
import { RightsController } from './rights.controller';
import { RightsService } from './rights.service';
import { RightsSweeper } from './sweeper';

@Module({
  imports: [AnalyticsModule, IdentityModule, OutboxModule, PrivacyModule],
  controllers: [RightsController],
  providers: [RightsService, RetentionService, RightsSweeper, SessionGuard],
  exports: [RightsService, RetentionService],
})
export class RightsModule {}
