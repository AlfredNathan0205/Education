import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { ExamModule } from '../exam/exam.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { GuardianFriendshipController, SafetyAdminController, SocialController } from './social.controller';
import { SOCIAL_CONFIG, SocialService, socialEnabled } from './social.service';

@Module({
  imports: [AuthzModule, ExamModule, IdentityModule, OutboxModule, PrivacyModule],
  controllers: [SocialController, GuardianFriendshipController, SafetyAdminController],
  providers: [SocialService, SessionGuard, { provide: SOCIAL_CONFIG, useFactory: () => ({ enabled: socialEnabled() }) }],
})
export class SocialModule {}
