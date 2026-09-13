import { Module } from '@nestjs/common';
import { OutboxService } from './outbox.service';
import { OutboxRelay } from './outbox.relay';

@Module({
  providers: [OutboxService, OutboxRelay],
  exports: [OutboxService],
})
export class OutboxModule {}
