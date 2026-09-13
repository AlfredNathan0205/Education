import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DatabaseService } from '../database/database.service';

/**
 * Outbox relay — polls for unpublished events and marks them as published.
 *
 * In a real system this would forward events to downstream consumers
 * (e.g., BullMQ queues, webhooks, event bus). For Block 001 it just
 * marks them published to prove the mechanism works end-to-end.
 *
 * Uses SELECT ... FOR UPDATE SKIP LOCKED so multiple relay instances
 * (if ever scaled) don't double-process the same event.
 */
@Injectable()
export class OutboxRelay {
  private readonly logger = new Logger(OutboxRelay.name);
  private static readonly BATCH_SIZE = 100;

  constructor(private readonly db: DatabaseService) {}

  @Cron(CronExpression.EVERY_5_SECONDS)
  async poll() {
    const published = await this.db.client.$transaction(async (tx) => {
      const pending = await tx.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id FROM outbox_event
         WHERE published_at IS NULL
         ORDER BY created_at ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        OutboxRelay.BATCH_SIZE,
      );

      if (pending.length === 0) return 0;

      const ids = pending.map((e) => e.id);

      await tx.outbox_event.updateMany({
        where: { id: { in: ids } },
        data: { published_at: new Date() },
      });

      return ids.length;
    });

    if (published > 0) {
      this.logger.log(`Outbox relay published ${published} event(s)`);
    }
  }
}
