import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { createOtpSender } from './email-otp-sender';
import { OTP_SENDER } from './otp-sender.port';

@Module({
  imports: [OutboxModule],
  controllers: [IdentityController],
  providers: [
    IdentityService,
    // Chosen from the environment (EMAIL_PROVIDER, RESEND_API_KEY, EMAIL_FROM). Unsafe configuration
    // (for example the console sender in production) fails at startup. See docs/implementation/CONSTRUCTION-007_INTERPRETATION.md.
    { provide: OTP_SENDER, useFactory: () => createOtpSender() },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
