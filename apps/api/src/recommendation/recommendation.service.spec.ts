import { ExamConflictError, ExamNotFoundError, ExamUnavailableError } from '../exam/exam.errors';
import { RECO_V1 } from './recommendation-domain';
import { RecommendationService } from './recommendation.service';

const UNIT = { curriculum_version_id: 'cv', grade_id: 'g', subject_id: 'sub' };

/** Tiny matcher for the where clauses this service uses: equality, { in }, { not: null }. */
function matches(row: any, where: any = {}): boolean {
  return Object.entries(where).every(([k, v]: [string, any]) => {
    if (v && typeof v === 'object' && !Array.isArray(v) && !(v instanceof Date)) {
      if ('in' in v) return v.in.includes(row[k]);
      if ('not' in v) return v.not === null ? row[k] !== null && row[k] !== undefined : row[k] !== v.not;
    }
    return row[k] === v;
  });
}

function build(opts: { states?: any[]; sessions?: any[]; policy?: boolean } = {}) {
  let id = 0;
  const nid = (p: string) => `${p}-${++id}`;
  const recs: any[] = [];
  const reasons: any[] = [];
  const events: any[] = [];
  const refreshes: any[] = [];
  const instances: any[] = [];
  const sessions: any[] = opts.sessions ?? [];
  const published: any[] = [];

  const withIncludes = (r: any) => ({
    ...r,
    reasons: reasons.filter((x) => x.recommendation_id === r.id),
    instances: instances
      .filter((i) => i.recommendation_id === r.id)
      .sort((a, b) => b.assembled_at - a.assembled_at)
      .map((i) => {
        const s = sessions.find((x) => x.instance_id === i.id);
        return { ...i, session: s ? { ...s, responses: Array.from({ length: s.locked ?? 0 }, () => ({ id: 'x' })) } : null };
      }),
  });

  const client: any = {
    $queryRaw: jest.fn(async () => []),
    $transaction: async (fn: any) => fn(client),
    recommendation_policy_version: { findFirst: jest.fn(async () => (opts.policy === false ? null : { id: 'pol', code: 'RECO_V1', params: RECO_V1 })) },
    recommendation_refresh: {
      findUnique: jest.fn(async ({ where }: any) => refreshes.find((r) => r.mastery_run_id === where.mastery_run_id) ?? null),
      create: jest.fn(async ({ data }: any) => refreshes.push({ id: nid('rf'), ...data })),
    },
    mastery_update_run: { findUnique: jest.fn(async ({ where }: any) => (where.id === 'run-1' ? { id: 'run-1', session_id: 's-test', student_id: 'stu' } : null)) },
    assessment_session: {
      findUnique: jest.fn(async ({ where }: any) => {
        const s = sessions.find((x) => x.id === where.id);
        return s ? { ...s, instance: { ...UNIT, items: s.items ?? [] } } : null;
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const s = sessions.find((x) => x.id === where.id && x.student_id === where.student_id);
        return s ? { ...s, instance: { ...UNIT, items: s.items ?? [] } } : null;
      }),
    },
    student_mastery_state: { findMany: jest.fn(async () => opts.states ?? []) },
    recommendation: {
      findMany: jest.fn(async ({ where }: any) => recs.filter((r) => matches(r, where)).map(withIncludes)),
      findFirst: jest.fn(async ({ where }: any) => {
        const r = recs.find((x) => matches(x, where));
        return r ? withIncludes(r) : null;
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => recs.find((r) => r.id === where.id)),
      create: jest.fn(async ({ data }: any) => {
        const { reasons: rs, ...rest } = data;
        const row = { id: nid('rec'), status: 'OPEN', closed_at: null, created_at: new Date('2026-10-14T10:00:00Z'), ...rest };
        recs.push(row);
        for (const r of rs.create) reasons.push({ id: nid('rs'), recommendation_id: row.id, ...r });
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(recs.find((r) => r.id === where.id), data)),
    },
    recommendation_event: { create: jest.fn(async ({ data }: any) => (events.push({ id: nid('ev'), ...data }), events[events.length - 1])) },
    curriculum_subject_version: {
      findUnique: jest.fn(async () => ({
        chapters: [{ code: 'C1', title: 'Motion', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'O1', statement: 'Define speed' }, { code: 'O2', statement: 'Use v = d/t' }] }] }] }],
      })),
    },
  };
  const exam: any = {
    studentFor: jest.fn(async () => 'stu'),
    listUnits: jest.fn(async () => [{ subjectVersionId: 'sv', subjectCode: 'PHY', subjectName: 'Physics' }]),
    servedUnitId: jest.fn(async () => 'sv'),
    createIn: jest.fn(async (_tx: any, _s: string, input: any) => {
      const open = instances.find((i) => i.recommendation_id === input.target.recommendationId && sessions.find((s) => s.instance_id === i.id)?.status === 'IN_PROGRESS');
      if (open) return { assessmentId: sessions.find((s) => s.instance_id === open.id).id, resumed: true };
      const inst = { id: nid('inst'), recommendation_id: input.target.recommendationId, assembled_at: ++id };
      instances.push(inst);
      const s = { id: nid('as'), instance_id: inst.id, student_id: 'stu', status: 'IN_PROGRESS', mode: input.mode };
      sessions.push(s);
      return { assessmentId: s.id, resumed: false };
    }),
  };
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  return { service: new RecommendationService({ client } as any, exam, outbox), recs, reasons, events, refreshes, instances, sessions, published, exam };
}

const state = (code: string, over: any = {}) => ({ objective_path: `C1/T1/M1/${code}`, label: 'BUILDING_EVIDENCE', reportable: false, mastery: 0.5, evidence_count: 3, last_evidence_at: new Date('2026-10-13'), ...over });
const testSession = { id: 's-test', student_id: 'stu', status: 'SUBMITTED', mode: 'TEST' };

describe('RecommendationService.refreshForRun', () => {
  it('chooses practice from mastery, records reasons, an event and the refresh; a second refresh of the same run does nothing', async () => {
    const b = build({ states: [state('O1', { label: 'NEEDS_ATTENTION', reportable: true, mastery: 0.4 }), state('O2', { label: 'SECURE', reportable: true, mastery: 0.8 })], sessions: [testSession] });
    const r = await b.service.refreshForRun('run-1');
    expect(r).toMatchObject({ runId: 'run-1', studentId: 'stu', created: [expect.any(String)] });
    expect(b.recs).toEqual([expect.objectContaining({ kind: 'PRACTICE', source: 'MASTERY', status: 'OPEN', objective_paths: ['C1/T1/M1/O1'], source_run_id: 'run-1', policy_version_id: 'pol', ...UNIT })]);
    expect(b.reasons).toEqual([expect.objectContaining({ objective_path: 'C1/T1/M1/O1', code: 'NEEDS_ATTENTION' })]);
    expect(b.events.map((e) => e.type)).toEqual(['CREATED']);
    expect(b.published.map((e) => e.eventType)).toEqual(['recommendation.created.v1']);
    expect(b.refreshes).toHaveLength(1);
    expect(await b.service.refreshForRun('run-1')).toBeNull();
    expect(b.recs).toHaveLength(1);
  });

  it('a finished practice becomes a retest on the same objectives', async () => {
    const b = build({ sessions: [testSession] });
    const rec = await (b.service as any).create((b.service as any).db.client, {
      studentId: 'stu', unit: { curriculumVersionId: 'cv', gradeId: 'g', subjectId: 'sub' }, policyId: 'pol', kind: 'PRACTICE', source: 'RESULT',
      objectivePaths: ['C1/T1/M1/O1'], reasons: [{ path: 'C1/T1/M1/O1', code: 'MISSED_IN_TEST', facts: {} }], parentId: null, runId: null, sourceAssessmentId: 's-test', now: new Date(),
    });
    // Mirror the persisted shape the service reads back.
    Object.assign(rec, { student_id: 'stu', curriculum_version_id: 'cv', grade_id: 'g', subject_id: 'sub', status: 'STARTED' });
    b.instances.push({ id: 'pi', recommendation_id: rec.id, assembled_at: 1 });
    b.sessions.push({ id: 's-prac', instance_id: 'pi', student_id: 'stu', status: 'SUBMITTED', mode: 'PRACTICE', locked: 7 });
    const r = await b.service.refreshForRun('run-1');
    expect(r!.completed).toEqual([rec.id]);
    expect(b.recs.find((x) => x.id === rec.id)).toMatchObject({ status: 'COMPLETED', closed_at: expect.any(Date) });
    expect(b.recs.find((x) => x.kind === 'RETEST')).toMatchObject({ status: 'OPEN', source: 'PRACTICE_DONE', parent_id: rec.id, objective_paths: ['C1/T1/M1/O1'] });
  });

  it('no active policy: nothing is decided', async () => {
    await expect(build({ policy: false, sessions: [testSession] }).service.refreshForRun('run-1')).rejects.toThrow(/no ACTIVE recommendation policy/);
  });
});

describe('RecommendationService student actions', () => {
  const missedTest = {
    id: 't1',
    student_id: 'stu',
    status: 'SUBMITTED',
    mode: 'TEST',
    items: [
      { objective_path: 'C1/T1/M1/O1', excluded: null, response: { state: 'LOCKED', is_correct: false } },
      { objective_path: 'C1/T1/M1/O1', excluded: null, response: null },
      { objective_path: 'C1/T1/M1/O2', excluded: null, response: { state: 'LOCKED', is_correct: true } },
    ],
  };

  it('practise what you missed: targets the missed objectives, starts a PRACTICE10 set, and asking again resumes it', async () => {
    const b = build({ sessions: [missedTest] });
    const r = await b.service.practiseMissed('acct', 't1');
    expect(r).toMatchObject({ resumed: false, recommendationId: expect.any(String) });
    expect(b.exam.createIn).toHaveBeenCalledWith(expect.anything(), 'stu', {
      subjectVersionId: 'sv',
      mode: 'PRACTICE',
      blueprint: 'PRACTICE10',
      target: { objectives: ['C1/T1/M1/O1'], recommendationId: r.recommendationId },
    });
    expect(b.recs[0]).toMatchObject({ source: 'RESULT', source_assessment_id: 't1', status: 'STARTED' });
    expect(b.reasons[0]).toMatchObject({ code: 'MISSED_IN_TEST', facts: { assessmentId: 't1', missed: 2 } });
    const again = await b.service.practiseMissed('acct', 't1');
    expect(again).toEqual({ assessmentId: r.assessmentId, resumed: true, recommendationId: r.recommendationId });
    expect(b.events.map((e) => e.type)).toEqual(['CREATED', 'STARTED']);
  });

  it('refuses an unfinished test, practice sets, a perfect test, and someone else\'s test', async () => {
    const b = build({
      sessions: [
        { ...missedTest, id: 't-open', status: 'IN_PROGRESS' },
        { ...missedTest, id: 't-prac', mode: 'PRACTICE' },
        { ...missedTest, id: 't-perfect', items: [{ objective_path: 'X', excluded: null, response: { state: 'LOCKED', is_correct: true } }] },
      ],
    });
    await expect(b.service.practiseMissed('acct', 't-open')).rejects.toBeInstanceOf(ExamConflictError);
    await expect(b.service.practiseMissed('acct', 't-prac')).rejects.toBeInstanceOf(ExamConflictError);
    await expect(b.service.practiseMissed('acct', 't-perfect')).rejects.toBeInstanceOf(ExamUnavailableError);
    await expect(b.service.practiseMissed('acct', 'nope')).rejects.toBeInstanceOf(ExamNotFoundError);
  });

  it('start: a retest is a TEST built from RETEST10; resuming adds no event; dismiss closes it, but not mid-practice', async () => {
    const b = build({ sessions: [testSession] });
    const rec = { id: 'r-re', student_id: 'stu', ...UNIT, kind: 'RETEST', status: 'OPEN', source: 'PRACTICE_DONE', objective_paths: ['C1/T1/M1/O2'], closed_at: null, created_at: new Date() };
    b.recs.push(rec);
    const s1 = await b.service.start('acct', 'r-re');
    expect(b.exam.createIn).toHaveBeenLastCalledWith(expect.anything(), 'stu', expect.objectContaining({ mode: 'TEST', blueprint: 'RETEST10' }));
    expect(rec.status).toBe('STARTED');
    expect(await b.service.start('acct', 'r-re')).toEqual({ assessmentId: s1.assessmentId, resumed: true });
    expect(b.events.filter((e) => e.type === 'STARTED')).toHaveLength(1);
    await expect(b.service.dismiss('acct', 'r-re')).rejects.toThrow(/Finish or leave/);

    b.sessions.find((s) => s.id === s1.assessmentId).status = 'VOID';
    expect(await b.service.dismiss('acct', 'r-re')).toEqual({ dismissed: true });
    expect(rec).toMatchObject({ status: 'DISMISSED', closed_at: expect.any(Date) });
    await expect(b.service.start('acct', 'r-re')).rejects.toThrow(/no longer open/);
    await expect(b.service.start('acct', 'unknown')).rejects.toBeInstanceOf(ExamNotFoundError);
  });

  it('mine: objective statements and reason codes, never the mastery numbers behind them', async () => {
    const b = build({ states: [state('O1', { label: 'NEEDS_ATTENTION', reportable: true, mastery: 0.4 })], sessions: [testSession] });
    await b.service.refreshForRun('run-1');
    Object.assign(b.recs[0], { student_id: 'stu' });
    const v = await b.service.mine('acct');
    expect(v).toEqual([
      expect.objectContaining({
        kind: 'PRACTICE',
        status: 'OPEN',
        subjectVersionId: 'sv',
        subjectName: 'Physics',
        objectives: [{ path: 'C1/T1/M1/O1', statement: 'Define speed', chapterTitle: 'Motion' }],
        reasons: [{ path: 'C1/T1/M1/O1', code: 'NEEDS_ATTENTION' }],
        inProgressAssessmentId: null,
      }),
    ]);
    expect(JSON.stringify(v)).not.toMatch(/mastery|confidence|0\.4/);
  });
});
