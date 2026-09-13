/**
 * Shared types and constants for the Exam App monorepo.
 * Domain-specific types belong in their respective domain modules (steps 3+).
 * This package holds only cross-cutting infrastructure types.
 */

/** Standard envelope for outbox events. */
export interface OutboxEventEnvelope {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
}
