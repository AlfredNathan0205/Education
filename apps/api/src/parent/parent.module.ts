import { Module } from '@nestjs/common';
import { AnalyticsModule } from '../analytics/analytics.module';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { ExamModule } from '../exam/exam.module';
import { webBaseUrl } from '../guardian/guardian-mailer';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { PARENT_SHARE_MAILER, createParentShareMailer } from './parent-mailer';
import { ParentController, ParentSharingController } from './parent.controller';
import { PARENT_WEB_BASE, ParentService } from './parent.service';
import { ReportSweeper } from './sweeper';

@Module({
  imports: [ExamModule, IdentityModule, PrivacyModule, OutboxModule, EntitlementModule, AnalyticsModule],
  controllers: [ParentController, ParentSharingController],
  providers: [
    ParentService,
    ReportSweeper,
    SessionGuard,
    // Unsafe configuration (console mailer or http/missing WEB_BASE_URL in production) fails at startup.
    { provide: PARENT_SHARE_MAILER, useFactory: () => createParentShareMailer() },
    { provide: PARENT_WEB_BASE, useFactory: () => webBaseUrl() },
  ],
})
export class ParentModule {}
