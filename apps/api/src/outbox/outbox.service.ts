import { Injectable, Logger } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import type { OutboxEventEnvelope } from '@exam-app/shared';
import type { Prisma } from '@exam-app/database';

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  constructor(private readonly db: DatabaseService) {}

  /**
   * Write an event to the outbox inside an existing transaction.
   * Callers should wrap their domain write + this call in a single
   * Prisma interactive transaction so the event is committed atomically
   * with the domain state change.
   */
  async publish(
    tx: Prisma.TransactionClient,
    envelope: OutboxEventEnvelope,
  ): Promise<void> {
    await tx.outbox_event.create({
      data: {
        aggregate_type: envelope.aggregateType,
        aggregate_id: envelope.aggregateId,
        event_type: envelope.eventType,
        payload: envelope.payload as Prisma.InputJsonValue,
        idempotency_key: envelope.idempotencyKey,
      },
    });
    this.logger.debug(`Outbox event queued: ${envelope.eventType} [${envelope.idempotencyKey}]`);
  }
}
