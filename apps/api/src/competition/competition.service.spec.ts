import { ExamConflictError } from '../exam/exam.errors';
import { CP_V1 } from './competition-domain';
import { CompetitionService } from './competition.service';

const UNIT = { curriculum_version_id: 'cv', grade_id: 'g', subject_id: 'chem' };
const DIFFS = ['EASY', 'EASY', 'EASY', 'EASY', 'EASY', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'HARD', 'HARD'];

function sessionOf(id: string, over: any = {}) {
  const right: (i: number) => boolean = over.right ?? (() => true);
  return {
    id,
    student_id: over.student ?? 'me',
    status: over.status ?? 'SUBMITTED',
    mode: over.mode ?? 'TEST',
    submitted_at: over.at ?? new Date('2026-10-14T08:00:00Z'),
    result: { competitive_eligible: over.eligible ?? true, correction_count: over.revision ?? 0, scored_at: over.at ?? new Date('2026-10-14T08:00:00Z') },
    instance: {
      id: `inst-${id}`,
      assembled_at: new Date('2026-10-14T07:50:00Z'),
      blueprint_code: over.blueprint ?? 'QUICK10',
      ...UNIT,
      items: DIFFS.map((d, i) => ({
        id: `${id}-i${i}`,
        question_id: `q${i}`,
        difficulty: d,
        excluded: over.excluded?.(i) ? 'INVALIDATED' : null,
        response: over.unanswered?.(i) ? null : { state: 'LOCKED', is_correct: right(i) },
      })),
    },
  };
}

function build(opts: { sessions?: any[]; seen?: string[]; minors?: string[]; hidden?: string[]; unclassified?: string[] } = {}) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const sessions = opts.sessions ?? [];
  const quals: any[] = [];
  const cp: any[] = [];
  const xp: any[] = [];
  const profiles: any[] = (opts.hidden ?? []).map((s) => ({ student_id: s, handle: `Learner-H${s.toUpperCase()}`, shown_to_others: false }));
  const published: any[] = [];
  const classOf = (s: string) => (opts.unclassified?.includes(s) ? null : { student_id: s, is_minor: (opts.minors ?? []).includes(s) });
  const inRange = (v: Date, r: any) => (!r?.gte || v >= r.gte) && (!r?.lt || v < r.lt);

  const client: any = {
    $transaction: async (fn: any) => fn(client),
    $queryRaw: jest.fn(async () => [{ n: 0 }]),
    $executeRaw: jest.fn(async (_s: any, studentId: string, handle: string) => {
      if (!profiles.some((p) => p.student_id === studentId || p.handle === handle)) profiles.push({ student_id: studentId, handle, shown_to_others: null });
    }),
    competitive_scoring_policy: { findFirst: jest.fn(async () => ({ id: 'pol', code: 'CP_V1', params: CP_V1 })) },
    assessment_session: { findUnique: jest.fn(async ({ where }: any) => sessions.find((s) => s.id === where.id) ?? null) },
    assessment_instance_question: { findMany: jest.fn(async () => (opts.seen ?? []).map((q) => ({ question_id: q }))) },
    competitive_qualification: {
      findUnique: jest.fn(async ({ where }: any) => quals.find((q) => q.session_id === where.session_id_result_revision.session_id && q.result_revision === where.session_id_result_revision.result_revision) ?? null),
      findFirst: jest.fn(async ({ where }: any) =>
        quals
          .filter((q) => q.student_id === where.student_id && q.qualified && q.blueprint_code === where.blueprint_code && q.session_id !== where.NOT.session_id && q.finished_at < where.finished_at.lt)
          .sort((a, b) => b.finished_at - a.finished_at)[0] ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) => quals.filter((q) => inRange(q.finished_at, where.finished_at))),
      count: jest.fn(async ({ where }: any) => quals.filter((q) => q.session_id === where.session_id).length),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: id('qual'), created_at: new Date(Date.now() + n), ...data };
        quals.push(row);
        return row;
      }),
    },
    cp_event: {
      aggregate: jest.fn(async ({ where }: any) => ({ _sum: { amount: cp.filter((e) => e.session_id === where.session_id).reduce((a, e) => a + e.amount, 0) || null } })),
      create: jest.fn(async ({ data }: any) => cp.push({ id: id('cp'), ...data })),
      findMany: jest.fn(async ({ where }: any) => cp.filter((e) => inRange(e.earned_at, where.earned_at))),
    },
    xp_event: {
      findUnique: jest.fn(async ({ where }: any) => xp.find((x) => x.session_id === where.session_id) ?? null),
      create: jest.fn(async ({ data }: any) => xp.push(data)),
      aggregate: jest.fn(async ({ where }: any) => ({ _sum: { amount: xp.filter((x) => x.student_id === where.student_id && (!where.earned_at || inRange(x.earned_at, where.earned_at))).reduce((a, x) => a + x.amount, 0) || null } })),
    },
    public_profile: {
      findUnique: jest.fn(async ({ where }: any) => profiles.find((p) => p.student_id === where.student_id) ?? null),
      findMany: jest.fn(async ({ where }: any) => profiles.filter((p) => where.student_id.in.includes(p.student_id))),
      update: jest.fn(async ({ where, data }: any) => Object.assign(profiles.find((p) => p.student_id === where.student_id), data)),
    },
    age_classification: {
      findFirst: jest.fn(async ({ where }: any) => classOf(where.student_id)),
      findMany: jest.fn(async ({ where }: any) => where.student_id.in.map(classOf).filter(Boolean)),
    },
    curriculum_subject_version: { findMany: jest.fn(async () => [{ id: 'sv-chem', ...UNIT }]) },
  };
  const exam: any = {
    studentFor: jest.fn(async () => 'me'),
    listUnits: jest.fn(async () => [{ subjectVersionId: 'sv-chem', subjectCode: 'CHEM', subjectName: 'Chemistry', curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }]),
  };
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  return { service: new CompetitionService({ client } as any, exam, outbox), quals, cp, xp, profiles, published, sessions };
}

describe('CompetitionService.processSession', () => {
  it('a perfect Quick 10: qualifies, one AWARD of 90 CP, 15 XP, a public handle; never twice', async () => {
    const b = build({ sessions: [sessionOf('s1')] });
    const r = await b.service.processSession('s1');
    expect(r).toEqual({ sessionId: 's1', qualified: true, cp: 90, ledger: { kind: 'AWARD', amount: 90 }, xp: 15 });
    expect(b.quals[0]).toMatchObject({ session_id: 's1', result_revision: 0, qualified: true, reasons: [], eligible_questions: 10, fresh_questions: 10, cp: 90, ...UNIT });
    expect(b.cp).toEqual([expect.objectContaining({ kind: 'AWARD', amount: 90, earned_at: new Date('2026-10-14T08:00:00Z') })]);
    expect(b.xp).toEqual([expect.objectContaining({ amount: 15, mode: 'TEST' })]);
    expect(b.profiles[0].handle).toMatch(/^Learner-/);
    expect(b.published.map((e) => e.eventType)).toEqual(['competition.cp_recorded.v1']);
    expect(await b.service.processSession('s1')).toBeNull();
    expect(b.cp).toHaveLength(1);
  });

  it('a rescore adds a compensating ADJUSTMENT and an invalidation a REVERSAL, dated to the original week; XP stays', async () => {
    const b = build({ sessions: [sessionOf('s1')] });
    await b.service.processSession('s1');
    b.sessions[0] = sessionOf('s1', { revision: 1, excluded: (i: number) => i === 9 });
    // A correct question removed: everything left is still correct, so the CP is unchanged and nothing is added.
    expect((await b.service.processSession('s1'))!.ledger).toBeNull();
    b.sessions[0] = sessionOf('s1', { revision: 2, right: (i: number) => i !== 0 && i !== 9, excluded: (i: number) => i === 9 });
    const adj = await b.service.processSession('s1');
    expect(adj!.ledger).toMatchObject({ kind: 'ADJUSTMENT' });
    expect(adj!.ledger!.amount).toBeLessThan(0);
    b.sessions[0] = { ...sessionOf('s1'), status: 'INVALIDATED' };
    const rev = await b.service.processSession('s1');
    expect(rev).toMatchObject({ qualified: false, cp: 0, ledger: { kind: 'REVERSAL' } });
    expect(b.cp.reduce((a, e) => a + e.amount, 0)).toBe(0);
    expect(b.cp.every((e) => e.earned_at.getTime() === new Date('2026-10-14T08:00:00Z').getTime())).toBe(true);
    expect(b.xp).toHaveLength(1);
  });

  it('practice earns XP only; questions seen before earn no CP', async () => {
    const b = build({ sessions: [sessionOf('p1', { mode: 'PRACTICE', blueprint: 'PRACTICE10' }), sessionOf('t2')], seen: ['q0', 'q1', 'q2', 'q3', 'q4'] });
    expect(await b.service.processSession('p1')).toMatchObject({ qualified: false, cp: 0, ledger: null, xp: 15 });
    expect(b.quals[0].reasons).toEqual(['NOT_A_TEST', 'NOT_COMPETITIVE_DESIGN']);
    const t = await b.service.processSession('t2');
    expect(b.quals[1]).toMatchObject({ fresh_questions: 5 });
    expect(t!.cp).toBe(45);
  });
});

describe('CompetitionService.view', () => {
  async function scored(b: ReturnType<typeof build>, ids: string[]) {
    for (const s of ids) await b.service.processSession(s);
  }

  it('ranks students others may see plus the viewer; minors and hidden adults are never listed to others', async () => {
    const at = (h: number) => new Date(`2026-10-13T0${h}:00:00Z`);
    const sessions = [
      sessionOf('me1', { at: at(1), right: (i: number) => i < 8 }),
      sessionOf('me2', { at: at(2), right: (i: number) => i < 8 }),
      sessionOf('a1', { student: 'adult', at: at(1) }),
      sessionOf('a2', { student: 'adult', at: at(2) }),
      sessionOf('k1', { student: 'kid', at: at(1) }),
      sessionOf('k2', { student: 'kid', at: at(2) }),
      sessionOf('h1', { student: 'shy', at: at(1) }),
      sessionOf('h2', { student: 'shy', at: at(2) }),
      sessionOf('o1', { student: 'once', at: at(3) }),
    ];
    const b = build({ sessions, minors: ['kid'], hidden: ['shy'] });
    await scored(b, sessions.map((s) => s.id));
    const v = await b.service.view('acct', new Date('2026-10-14T12:00:00Z'));
    expect(v).toMatchObject({ policy: 'CP_V1', shownToOthers: true, canChangeVisibility: true, xp: { week: 30, total: 30 }, week: { start: '2026-10-11T18:30:00.000Z' } });
    expect(v.boards.map((x) => [x.scope, x.title])).toEqual([
      ['COHORT', 'All subjects · ICSE Grade 8'],
      ['SUBJECT', 'Chemistry'],
    ]);
    const board = v.boards[0];
    // Only the adult and the viewer are ranked: the minor, the hidden adult and the one-test student are not listed.
    expect(board.entries.map((e) => [e.rank, e.you])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(board.entries[0].handle).toMatch(/^Learner-/);
    expect(board.entries[0].cp).toBe(180);
    expect(board.you).toMatchObject({ qualified: 2, eligibleQuestions: 20, rank: 2, needs: { tests: 0, questions: 0 } });
    expect(JSON.stringify(v)).not.toMatch(/accuracy|"kid"|"shy"|studentId/);
  });

  it('a student with one test is told what is still needed to be ranked; a minor is not shown and cannot change it', async () => {
    const b = build({ sessions: [sessionOf('me1')], minors: ['me'] });
    await scored(b, ['me1']);
    const v = await b.service.view('acct', new Date('2026-10-14T12:00:00Z'));
    expect(v).toMatchObject({ shownToOthers: false, canChangeVisibility: false });
    expect(v.boards[0].you).toMatchObject({ cp: 90, qualified: 1, rank: null, needs: { tests: 1, questions: 10 } });
    await expect(b.service.setShown('acct', true)).rejects.toBeInstanceOf(ExamConflictError);
  });

  it('an unclassified student is treated as a minor (fail closed); an adult may hide and return', async () => {
    const u = build({ unclassified: ['me'] });
    expect((await u.service.view('acct', new Date('2026-10-14T12:00:00Z'))).shownToOthers).toBe(false);
    const a = build();
    expect(await a.service.setShown('acct', false)).toEqual({ shownToOthers: false });
    expect((await a.service.view('acct')).shownToOthers).toBe(false);
    await a.service.setShown('acct', true);
    expect((await a.service.view('acct')).shownToOthers).toBe(true);
  });
});
