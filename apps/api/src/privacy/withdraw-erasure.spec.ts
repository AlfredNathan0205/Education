import { PrivacyService } from './privacy.service';

describe('PrivacyService.withdrawAllForErasure (Step 20)', () => {
  function setup(live: Array<{ id: string; student_id: string; purpose: { code: string } }>) {
    const tx: any = {
      consent_record: { findMany: jest.fn(async () => live) },
      consent_withdrawal: { create: jest.fn(async () => ({})) },
      audit_event: { create: jest.fn(async () => ({})) },
    };
    const outbox = { publish: jest.fn(async () => undefined) };
    return { tx, outbox, service: new PrivacyService({ client: {} } as any, outbox as any) };
  }
  const NOW = new Date('2026-10-30T10:00:00Z');

  it("withdraws every live consent for the student, whoever granted it, and tells the other domains", async () => {
    const { tx, outbox, service } = setup([
      { id: 'c1', student_id: 's', purpose: { code: 'CORE_SERVICE' } },
      { id: 'c2', student_id: 's', purpose: { code: 'PRODUCT_ANALYTICS' } },
    ]);
    expect(await service.withdrawAllForErasure({ studentId: 's', actorAccountId: 'g' }, tx, NOW)).toBe(2);
    expect(tx.consent_record.findMany.mock.calls[0][0].where).toEqual({ withdrawal: null, student_id: 's' });
    expect(tx.consent_withdrawal.create).toHaveBeenCalledWith({ data: { consent_record_id: 'c1', withdrawn_by_account_id: 'g', withdrawn_at: NOW, reason_code: 'ERASURE' } });
    expect(outbox.publish).toHaveBeenCalledWith(tx, expect.objectContaining({ eventType: 'privacy.consent.withdrawn.v1', payload: { consentRecordId: 'c2', studentId: 's', purposeCode: 'PRODUCT_ANALYTICS' }, idempotencyKey: 'consent-withdrawn:c2' }));
    expect(tx.audit_event.create).toHaveBeenCalledTimes(2);
  });

  it('can be limited to named records, and does nothing without a scope', async () => {
    const { tx, service } = setup([]);
    await service.withdrawAllForErasure({ consentRecordIds: ['c9'], actorAccountId: 'p' }, tx, NOW);
    expect(tx.consent_record.findMany.mock.calls[0][0].where).toEqual({ withdrawal: null, id: { in: ['c9'] } });
    expect(await service.withdrawAllForErasure({ actorAccountId: 'p' }, tx, NOW)).toBe(0);
    expect(tx.consent_record.findMany).toHaveBeenCalledTimes(1);
  });
});
