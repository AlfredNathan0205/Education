import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from './exam.errors';
import { ItemInvalidationService, blockersFor } from './item-invalidation.service';

/**
 * In-memory stand-in for the Prisma calls InvalidateAssessmentItem makes. Real SQL (row locks, the unique index that
 * makes it one decision per version) is covered by the real-database integration tests.
 */
const R = 'rev-bad';
const ROLES: Record<string, string[]> = { approver: ['APPROVER'], reviewer: ['REVIEWER'] };
const NOTE = 'The key marks option B but option C is correct.';

function item(id: string, position: number, revisionId: string, difficulty: string, response: any, excluded: string | null = null) {
  return { id, position, question_revision_id: revisionId, difficulty, excluded, excluded_at: null, invalidation_id: null, response };
}
const locked = (isCorrect: boolean) => ({ state: 'LOCKED', is_correct: isCorrect });

function build(revState = 'QUARANTINED') {
  let n = 0;
  const sessions: any[] = [
    {
      // Finished: R was answered correctly; one other item already failed technically.
      id: 's1', student_id: 'stu1', mode: 'TEST', status: 'SUBMITTED',
      result: { id: 'res1', total: 2, correct: 2, unanswered: 0, by_difficulty: {}, competitive_eligible: true },
      instance: { items: [item('i1', 1, R, 'EASY', locked(true)), item('i2', 2, 'r2', 'MEDIUM', locked(true)), item('i3', 3, 'r3', 'HARD', locked(false)), item('i4', 4, 'r4', 'HARD', null, 'TECHNICAL_FAILURE')] },
    },
    {
      // Still running: R not seen yet.
      id: 's2', student_id: 'stu2', mode: 'TEST', status: 'IN_PROGRESS', result: null,
      instance: { items: [item('i5', 1, 'r2', 'EASY', locked(true)), item('i6', 2, R, 'MEDIUM', null)] },
    },
    {
      // Finished, and R was its only question.
      id: 's3', student_id: 'stu3', mode: 'TEST', status: 'SUBMITTED',
      result: { id: 'res3', total: 1, correct: 0, unanswered: 0, by_difficulty: {}, competitive_eligible: true },
      instance: { items: [item('i7', 1, R, 'EASY', locked(false))] },
    },
  ];
  const allItems = () => sessions.flatMap((s) => s.instance.items.map((i: any) => ({ ...i, _session: s })));
  const invalidations: any[] = [];
  const corrections: any[] = [];
  const events: any[] = [];
  const audits: any[] = [];

  const client: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (fn: any) => fn(client)),
    question_revision: { findUnique: jest.fn(async ({ where }: any) => (where.id === R ? { id: R, state: revState, question: { code: 'PHY-07' } } : null)) },
    assessment_item_invalidation: {
      findUnique: jest.fn(async ({ where }: any) => invalidations.find((x) => x.question_revision_id === where.question_revision_id) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `inv-${++n}`, created_at: new Date(), ...data };
        invalidations.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(invalidations.find((x) => x.id === where.id), data)),
    },
    assessment_instance_question: {
      findMany: jest.fn(async ({ where }: any) =>
        allItems()
          .filter((i) => i.question_revision_id === where.question_revision_id && i.excluded === null)
          .map((i) => ({ id: i.id, instance: { session: { id: i._session.id, status: i._session.status } } })),
      ),
      update: jest.fn(async ({ where, data }: any) => {
        const target = sessions.flatMap((s) => s.instance.items).find((i: any) => i.id === where.id);
        Object.assign(target, data);
      }),
    },
    assessment_session: {
      findUnique: jest.fn(async ({ where }: any) => {
        const s = sessions.find((x) => x.id === where.id);
        return { ...s, instance: { items: s.instance.items.map((i: any) => ({ ...i })) } };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(sessions.find((x) => x.id === where.id), data)),
    },
    assessment_result: {
      update: jest.fn(async ({ where, data }: any) => {
        const r = sessions.map((s) => s.result).find((x) => x?.id === where.id);
        const { correction_count, ...rest } = data;
        Object.assign(r, rest, { correction_count: (r.correction_count ?? 0) + correction_count.increment });
      }),
    },
    assessment_result_correction: { create: jest.fn(async ({ data }: any) => corrections.push(data)) },
    student_response_event: { create: jest.fn(async ({ data }: any) => events.push(data)) },
    audit_event: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
  };
  const authz: any = { curriculumRolesFor: jest.fn(async (a: string) => ROLES[a] ?? []) };
  const published: any[] = [];
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  return { service: new ItemInvalidationService({ client } as any, authz, outbox), sessions, invalidations, corrections, events, audits, published, client };
}

describe('InvalidateAssessmentItem', () => {
  it('only an approver may do it, with a listed reason and a real note', async () => {
    const h = build();
    await expect(h.service.invalidate('reviewer', R, { reasonCode: 'ANSWER_WRONG', note: NOTE })).rejects.toBeInstanceOf(ExamNotPermittedError);
    await expect(h.service.invalidate('approver', R, { reasonCode: 'NOT_A_REASON', note: NOTE })).rejects.toBeInstanceOf(ExamInputError);
    await expect(h.service.invalidate('approver', R, { reasonCode: 'ANSWER_WRONG', note: 'bad' })).rejects.toThrow(/10 to 1000/);
    await expect(h.service.impact('reviewer', R)).rejects.toBeInstanceOf(ExamNotPermittedError);
    expect(h.invalidations).toHaveLength(0);
  });

  it('needs the question out of serving first', async () => {
    const h = build('APPROVED');
    await expect(h.service.invalidate('approver', R, { reasonCode: 'ANSWER_WRONG', note: NOTE })).rejects.toBeInstanceOf(ExamConflictError);
    expect(h.invalidations).toHaveLength(0);
    expect(blockersFor('RETIRED')).toEqual([]);
    expect(blockersFor('SUPERSEDED')).toEqual([]);
  });

  it('says what it would change before anyone acts', async () => {
    const h = build();
    expect(await h.service.impact('approver', R)).toMatchObject({ code: 'PHY-07', state: 'QUARANTINED', items: 3, inProgress: 1, submitted: 2, other: 0, blockers: [], already: null });
    await expect(h.service.impact('approver', 'missing')).rejects.toBeInstanceOf(ExamNotFoundError);
  });

  it('excludes the item everywhere, rescores finished results with a correction, and cancels a test left with nothing', async () => {
    const h = build();
    const out = await h.service.invalidate('approver', R, { reasonCode: 'ANSWER_WRONG', note: NOTE });
    expect(out).toMatchObject({ itemsAffected: 3, resultsRescored: 2, sessionsInvalidated: 1, repeated: false });

    const [s1, s2, s3] = h.sessions;
    // Finished test: R no longer counts; the earlier technical failure stays out too.
    expect(s1.result).toMatchObject({ total: 2, correct: 1, unanswered: 0, competitive_eligible: true, correction_count: 1 });
    expect(s1.result.corrected_at).toBeInstanceOf(Date);
    expect(s1.instance.items[0]).toMatchObject({ excluded: 'INVALIDATED', invalidation_id: out.invalidationId });
    expect(s1.instance.items[3]).toMatchObject({ excluded: 'TECHNICAL_FAILURE', invalidation_id: null });
    expect(h.corrections.find((c) => c.session_id === 's1')).toMatchObject({
      reason: 'INVALIDATION',
      invalidation_id: out.invalidationId,
      before: { total: 2, correct: 2 },
      after: { total: 2, correct: 1 },
    });
    // Running test: the item is skipped from now on; the test carries on.
    expect(s2.status).toBe('IN_PROGRESS');
    expect(s2.instance.items[1].excluded).toBe('INVALIDATED');
    // A test whose only question was R is cancelled and stops being competitive.
    expect(s3.status).toBe('INVALIDATED');
    expect(s3.result).toMatchObject({ total: 0, correct: 0, competitive_eligible: false });

    expect(h.events.map((e) => [e.session_id, e.event_type])).toEqual([
      ['s1', 'INVALIDATED'],
      ['s2', 'INVALIDATED'],
      ['s3', 'INVALIDATED'],
    ]);
    const types = h.published.map((e) => e.eventType);
    expect(types.filter((t) => t === 'assessment.rescored.v1')).toHaveLength(2);
    expect(types.filter((t) => t === 'assessment.invalidated.v1')).toHaveLength(1);
    expect(types).toContain('assessment_item.invalidated.v1');
    expect(h.published.find((e) => e.eventType === 'assessment.rescored.v1' && e.aggregateId === 's1')!.payload).toMatchObject({
      before: { correct: 2, total: 2 },
      after: { correct: 1, total: 2 },
    });
    expect(h.audits[0]).toMatchObject({ action: 'assessment_item.invalidated', subject_id: R, reason_code: 'ANSWER_WRONG' });
    // Sessions are locked in a fixed order.
    expect(h.client.$queryRaw).toHaveBeenCalledTimes(3);
  });

  it('is one decision per version: repeating it changes nothing', async () => {
    const h = build();
    const first = await h.service.invalidate('approver', R, { reasonCode: 'ANSWER_WRONG', note: NOTE });
    const again = await h.service.invalidate('approver', R, { reasonCode: 'ANSWER_AMBIGUOUS', note: 'Something else entirely here.' });
    expect(again).toEqual({ ...first, repeated: true });
    expect(h.invalidations).toHaveLength(1);
    expect(h.corrections).toHaveLength(2);
    expect((await h.service.impact('approver', R)).already).toMatchObject({ invalidationId: first.invalidationId, reasonCode: 'ANSWER_WRONG' });
  });
});
