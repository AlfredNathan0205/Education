import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { IdentityModule } from '../identity/identity.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { AdminAnalyticsController, AnalyticsController, GuardianAnalyticsController } from './analytics.controller';
import { AnalyticsService } from './analytics.service';
import { AnalyticsSweeper } from './sweeper';

@Module({
  imports: [AuthzModule, IdentityModule, PrivacyModule],
  controllers: [AnalyticsController, GuardianAnalyticsController, AdminAnalyticsController],
  providers: [AnalyticsService, AnalyticsSweeper, SessionGuard],
  exports: [AnalyticsService],
})
export class AnalyticsModule {}
