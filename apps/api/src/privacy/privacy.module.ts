import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyService } from './privacy.service';

@Module({
  imports: [OutboxModule],
  providers: [PrivacyService],
  exports: [PrivacyService],
})
export class PrivacyModule {}
