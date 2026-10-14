import { MASTERY_V1 } from './mastery-domain';
import { MasteryService } from './mastery.service';
import { MasterySweeper, masteryUpdatesEnabled } from './sweeper';

/**
 * In-memory stand-in for the Prisma calls the mastery service makes. Checks the service's rules: which answers become
 * evidence, their weights, repeats, invalidation, recomputation, the trajectory record, and one run per result revision.
 * Real SQL (the reconcile query, row locks, unique indexes) is covered by the real-database integration tests.
 */
const STUDENT = 'stu';
const PATHS = ['C1/T1/M1/O1', 'C1/T1/M1/O2'];

function build(opts: { policy?: any | null; health?: Record<string, string> } = {}) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const sessions: any[] = [];
  const evidence: any[] = [];
  const states: any[] = [];
  const runs: any[] = [];
  const changes: any[] = [];
  const diffStates: any[] = [];
  const cogStates: any[] = [];
  const published: any[] = [];

  function addSession(over: { mode?: string; correct?: boolean[]; status?: string; correctionCount?: number; excluded?: Array<string | null>; questionIds?: string[] } = {}) {
    const sid = id('sess');
    const correct = over.correct ?? [true, false, true, true];
    const items = correct.map((c, i) => ({
      id: id('item'),
      position: i + 1,
      question_id: over.questionIds?.[i] ?? `q-${sid}-${i}`,
      question_revision_id: `r-${over.questionIds?.[i] ?? `q-${sid}-${i}`}`,
      objective_path: PATHS[i % 2],
      difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[i % 3],
      excluded: over.excluded?.[i] ?? null,
      response: { state: 'LOCKED', is_correct: c, locked_at: new Date(Date.now() - 1000 * (10 - i)) },
    }));
    sessions.push({
      id: sid,
      student_id: STUDENT,
      mode: over.mode ?? 'TEST',
      status: over.status ?? 'SUBMITTED',
      submitted_at: new Date(),
      result: { correction_count: over.correctionCount ?? 0 },
      instance: { curriculum_version_id: 'cv', grade_id: 'g', subject_id: 'sub', subject_version_id: 'sv', blueprint_code: 'QUICK10', items },
    });
    return sid;
  }

  const sameKey = (a: any, w: any) =>
    a.student_id === w.student_id && a.curriculum_version_id === w.curriculum_version_id && a.grade_id === w.grade_id && a.subject_id === w.subject_id && a.objective_path === w.objective_path;

  const client: any = {
    $transaction: async (fn: any) => fn(client),
    $queryRaw: jest.fn(async () => []),
    assessment_session: { findUnique: jest.fn(async ({ where }: any) => sessions.find((s) => s.id === where.id) ?? null) },
    mastery_update_run: {
      findUnique: jest.fn(async ({ where }: any) => runs.find((r) => r.session_id === where.session_id_result_revision.session_id && r.result_revision === where.session_id_result_revision.result_revision) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const r = { id: id('run'), ...data };
        runs.push(r);
        return r;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(runs.find((r) => r.id === where.id), data)),
    },
    mastery_policy_version: {
      findFirst: jest.fn(async () => (opts.policy === null ? null : { id: 'pol-1', code: 'MASTERY_V1', params: opts.policy ?? JSON.parse(JSON.stringify(MASTERY_V1)) })),
    },
    mastery_evidence_event: {
      findMany: jest.fn(async ({ where }: any) =>
        evidence.filter((e) =>
          where.session_id ? e.session_id === where.session_id : (where.objective_path ? sameKey(e, where) : e.student_id === where.student_id && e.subject_id === where.subject_id) && e.invalidated_at === null,
        ),
      ),
      count: jest.fn(async ({ where }: any) => evidence.filter((e) => e.student_id === where.student_id && e.question_id === where.question_id && e.invalidated_at === null && e.session_id !== where.NOT.session_id).length),
      create: jest.fn(async ({ data }: any) => evidence.push({ id: id('ev'), invalidated_at: null, invalidation_reason: null, ...data })),
      update: jest.fn(async ({ where, data }: any) => Object.assign(evidence.find((e) => e.id === where.id), data)),
    },
    chapter: {
      findMany: jest.fn(async () => [{ code: 'C1', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ id: 'lo-1', code: 'O1' }, { id: 'lo-2', code: 'O2' }] }] }] }]),
    },
    question_revision: {
      findMany: jest.fn(async ({ where }: any) => (where.state ? [] : where.id.in.map((rid: string) => ({ id: rid, cognitive: 'C2' })))),
    },
    question_bank_state: {
      findMany: jest.fn(async ({ where }: any) => where.question_id.in.filter((q: string) => opts.health?.[q]).map((q: string) => ({ question_id: q, health: opts.health![q] }))),
    },
    student_mastery_state: {
      findUnique: jest.fn(async ({ where }: any) => {
        const hit = states.find((s) => sameKey(s, where.student_id_curriculum_version_id_grade_id_subject_id_objective_path));
        return hit ? { ...hit } : null; // a copy, as Prisma returns
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const hit = states.find((s) => sameKey(s, where.student_id_curriculum_version_id_grade_id_subject_id_objective_path));
        if (hit) Object.assign(hit, update);
        else states.push({ ...create });
      }),
    },
    mastery_state_change: { create: jest.fn(async ({ data }: any) => changes.push(data)) },
    student_difficulty_state: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.student_id_subject_id_difficulty;
        const hit = diffStates.find((s) => s.difficulty === k.difficulty && s.subject_id === k.subject_id);
        if (hit) Object.assign(hit, update);
        else diffStates.push(create);
      }),
    },
    student_cognitive_state: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.student_id_subject_id_cognitive;
        const hit = cogStates.find((s) => s.cognitive === k.cognitive && s.subject_id === k.subject_id);
        if (hit) Object.assign(hit, update);
        else cogStates.push(create);
      }),
    },
  };
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  return { service: new MasteryService({ client } as any, outbox), client, sessions, evidence, states, runs, changes, diffStates, cogStates, published, addSession };
}

describe('MasteryService.processSession', () => {
  it('turns every locked, counted answer into immutable, weighted evidence on its objective', async () => {
    const h = build({ health: { 'q-x': 'HEALTHY' } });
    const sid = h.addSession();
    const r = await h.service.processSession(sid);
    expect(r).toMatchObject({ evidenceAdded: 4, evidenceInvalidated: 0, objectivesChanged: 2 });
    expect(h.evidence).toHaveLength(4);
    const e = h.evidence[0];
    // Quick test 0.9 x NEW item 0.9 (no bank health row yet) x distinct 1.
    expect(e).toMatchObject({ student_id: STUDENT, objective_path: PATHS[0], learning_objective_id: 'lo-1', score: 1, w_context: 0.9, w_quality: 0.9, w_independence: 1, weight: 0.81, cognitive: 'C2', policy_version_id: 'pol-1' });
    expect(h.states.map((s) => [s.objective_path, s.label, s.evidence_count])).toEqual([
      [PATHS[0], 'BUILDING_EVIDENCE', 2],
      [PATHS[1], 'BUILDING_EVIDENCE', 2],
    ]);
    expect(h.changes).toHaveLength(2);
    expect(h.changes[0]).toMatchObject({ before_label: null, after_label: 'BUILDING_EVIDENCE' });
    expect(h.diffStates).toHaveLength(3);
    expect(h.cogStates.find((c) => c.cognitive === 'C2')).toMatchObject({ evidence_count: 4 });
    expect(h.published[0]).toMatchObject({ eventType: 'mastery.updated.v1', payload: { sessionId: sid, evidenceAdded: 4, objectivesChanged: 2 } });
  });

  it('does nothing twice for the same result revision', async () => {
    const h = build();
    const sid = h.addSession();
    await h.service.processSession(sid);
    expect(await h.service.processSession(sid)).toBeNull();
    expect(h.evidence).toHaveLength(4);
    expect(h.runs).toHaveLength(1);
  });

  it('skips unanswered, skipped and excluded items: unknown is not zero, a failure is not the learner\'s error', async () => {
    const h = build();
    const sid = h.addSession({ correct: [true, false, true, false], excluded: [null, 'TECHNICAL_FAILURE', null, null] });
    const s = h.sessions.find((x) => x.id === sid);
    s.instance.items[2].response = { state: 'SKIPPED', is_correct: null };
    s.instance.items[3].response = null;
    await h.service.processSession(sid);
    expect(h.evidence).toHaveLength(1);
  });

  it('a question answered before counts as an exact repeat (0.05)', async () => {
    const h = build();
    await h.service.processSession(h.addSession({ questionIds: ['qa', 'qb', 'qc', 'qd'] }));
    await h.service.processSession(h.addSession({ questionIds: ['qa', 'qz', 'qy', 'qx'] }));
    const second = h.evidence.filter((e) => e.question_id === 'qa');
    expect(second.map((e) => e.w_independence)).toEqual([1, 0.05]);
  });

  it('practice evidence carries the practice context weight', async () => {
    const h = build();
    await h.service.processSession(h.addSession({ mode: 'PRACTICE' }));
    expect(h.evidence.every((e) => e.w_context === 0.6 && e.mode === 'PRACTICE')).toBe(true);
  });

  it('a rescored result invalidates the excluded item\'s evidence and recomputes, recording the change', async () => {
    const h = build();
    const sid = h.addSession({ correct: [true, true, true, true] });
    await h.service.processSession(sid);
    const before = h.states.find((s) => s.objective_path === PATHS[0]).mastery;
    const s = h.sessions.find((x) => x.id === sid);
    s.instance.items[0].excluded = 'INVALIDATED';
    s.result.correction_count = 1;
    const r = await h.service.processSession(sid);
    expect(r).toMatchObject({ evidenceAdded: 0, evidenceInvalidated: 1, objectivesChanged: 1 });
    expect(h.evidence[0]).toMatchObject({ invalidation_reason: 'ITEM_INVALIDATED' });
    expect(h.evidence[0].invalidated_at).toBeInstanceOf(Date);
    const after = h.states.find((x) => x.objective_path === PATHS[0]);
    expect(after.evidence_count).toBe(1);
    expect(after.mastery).toBeLessThan(before);
    expect(h.changes.at(-1)).toMatchObject({ objective_path: PATHS[0], before_mastery: before, after_mastery: after.mastery });
    expect(h.runs.map((x) => x.result_revision)).toEqual([0, 1]);
  });

  it('an invalidated test withdraws all of its evidence', async () => {
    const h = build();
    const sid = h.addSession();
    await h.service.processSession(sid);
    h.sessions.find((x) => x.id === sid).status = 'INVALIDATED';
    expect(await h.service.processSession(sid)).toMatchObject({ evidenceInvalidated: 4 });
    expect(h.evidence.every((e) => e.invalidation_reason === 'SESSION_INVALIDATED')).toBe(true);
    expect(h.states.every((s) => s.label === 'NOT_STARTED' && s.evidence_count === 0)).toBe(true);
    expect(h.runs.at(-1).result_revision).toBe(-1);
  });

  it('fails closed without an active policy (the test result is untouched; mastery waits)', async () => {
    const h = build({ policy: null });
    await expect(h.service.processSession(h.addSession())).rejects.toThrow(/no ACTIVE mastery policy/);
    expect(h.evidence).toHaveLength(0);
  });

  it('refuses a broken policy', async () => {
    const h = build({ policy: { prior: { alpha: 1, beta: 1 } } });
    await expect(h.service.processSession(h.addSession())).rejects.toThrow(/missing or has bad values/);
  });

  it('a test that is still running is not counted', async () => {
    const h = build();
    const sid = h.addSession({ status: 'IN_PROGRESS' });
    expect(await h.service.processSession(sid)).toBeNull();
  });
});

describe('MasterySweeper', () => {
  it('is on by default and refuses unclear settings', () => {
    expect(masteryUpdatesEnabled({})).toBe(true);
    expect(masteryUpdatesEnabled({ MASTERY_UPDATES_ENABLED: 'false' })).toBe(false);
    expect(() => masteryUpdatesEnabled({ MASTERY_UPDATES_ENABLED: 'off' })).toThrow();
  });
  it('logs and survives a failure', async () => {
    const svc: any = { reconcile: jest.fn().mockRejectedValue(new Error('db down')) };
    expect(await new MasterySweeper(svc).run()).toBe(0);
  });
});
