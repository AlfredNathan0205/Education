import type { Prisma } from '@exam-app/database';

export type PublicationActor = { kind: 'HUMAN'; accountId: string } | { kind: 'SYSTEM'; accountId: null };

/**
 * Withdraws a published revision inside the caller's transaction and records why. Does nothing if it is not published.
 * The question bank calls this when a question is quarantined, retired or replaced, so a defective or old version
 * can never stay in the serving bank by accident.
 */
export async function withdrawInTx(
  tx: Prisma.TransactionClient,
  revisionId: string,
  actor: PublicationActor,
  reasonCode: string | null,
  note: string | null,
): Promise<boolean> {
  const row = await tx.question_publication.findUnique({ where: { revision_id: revisionId } });
  if (!row || row.state !== 'PUBLISHED') return false;
  await tx.question_publication.update({
    where: { revision_id: revisionId },
    data: { state: 'WITHDRAWN', withdrawn_by: actor.accountId, withdrawn_at: new Date(), withdraw_reason_code: reasonCode, withdraw_note: note?.slice(0, 1000) ?? null },
  });
  await tx.question_publication_event.create({
    data: { revision_id: revisionId, action: 'WITHDRAW', actor_kind: actor.kind, actor_account_id: actor.accountId, reason_code: reasonCode, note: note?.slice(0, 1000) ?? null },
  });
  return true;
}
