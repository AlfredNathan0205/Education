import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { GUARDIAN_MAILER, createGuardianMailer, webBaseUrl } from './guardian-mailer';
import { GuardianController } from './guardian.controller';
import { GUARDIAN_WEB_BASE, GuardianService } from './guardian.service';

@Module({
  imports: [IdentityModule, PrivacyModule, OutboxModule],
  controllers: [GuardianController],
  providers: [
    GuardianService,
    SessionGuard,
    // Unsafe configuration (console mailer or http/missing WEB_BASE_URL in production) fails at startup.
    { provide: GUARDIAN_MAILER, useFactory: () => createGuardianMailer() },
    { provide: GUARDIAN_WEB_BASE, useFactory: () => webBaseUrl() },
  ],
})
export class GuardianModule {}
