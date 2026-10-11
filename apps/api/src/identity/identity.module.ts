import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { ConsoleOtpSender, OTP_SENDER } from './otp-sender.port';

@Module({
  imports: [OutboxModule],
  controllers: [IdentityController],
  providers: [
    IdentityService,
    // Development sender. Replace with a real email/SMS provider before any production use;
    // ConsoleOtpSender throws when NODE_ENV=production, so forgetting is loud, not silent.
    { provide: OTP_SENDER, useClass: ConsoleOtpSender },
  ],
  exports: [IdentityService],
})
export class IdentityModule {}
