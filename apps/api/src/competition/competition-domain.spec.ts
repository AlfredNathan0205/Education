import {
  CP_V1 as P,
  isRankable,
  ledgerEntry,
  parseCompetitionPolicy,
  publicHandle,
  qualify,
  rank,
  stillNeeded,
  weekOf,
  xpFor,
  type ScoredItem,
  type Standing,
  type TestFacts,
} from './competition-domain';

const item = (difficulty: ScoredItem['difficulty'], correct: boolean, over: Partial<ScoredItem> = {}): ScoredItem => ({ difficulty, correct, excluded: false, seenBefore: false, ...over });
/** A Quick 10 mix: 5 easy, 3 medium, 2 hard; `right` decides each answer in that order. */
const quick = (right: (i: number) => boolean, over: (i: number) => Partial<ScoredItem> = () => ({})): ScoredItem[] =>
  (['EASY', 'EASY', 'EASY', 'EASY', 'EASY', 'MEDIUM', 'MEDIUM', 'MEDIUM', 'HARD', 'HARD'] as const).map((d, i) => item(d, right(i), over(i)));
const test = (over: Partial<TestFacts> = {}): TestFacts => ({ mode: 'TEST', blueprint: 'QUICK10', competitiveEligible: true, invalidated: false, items: quick(() => true), previousAccuracy: null, ...over });

describe('qualify (provisional CP_V1)', () => {
  it('a perfect Quick 10 earns 90 of its 100 (the rest is the improvement share)', () => {
    const q = qualify(test(), P);
    expect(q).toMatchObject({ qualified: true, reasons: [], eligibleQuestions: 10, freshQuestions: 10, correct: 10, accuracy: 1, weightedAccuracy: 1, cp: 90 });
    expect(q.difficultyScore).toBeCloseTo((5 * 1 + 3 * 1.25 + 2 * 1.5) / 10, 3);
  });

  it('is accuracy-dominant and weights harder questions more', () => {
    const easyOnly = qualify(test({ items: quick((i) => i < 5) }), P); // 5 easy right
    const hardOnly = qualify(test({ items: quick((i) => i >= 5) }), P); // 3 medium + 2 hard right
    expect(easyOnly.accuracy).toBe(0.5);
    expect(hardOnly.accuracy).toBe(0.5);
    expect(hardOnly.cp).toBeGreaterThan(easyOnly.cp);
    expect(easyOnly.cp).toBe(Math.round(0.9 * 100 * (5 / 11.75)));
  });

  it('repeats earn nothing and cost nothing: only fresh questions earn, scaled by their share', () => {
    const half = qualify(test({ items: quick(() => true, (i) => ({ seenBefore: i % 2 === 0 })) }), P);
    expect(half).toMatchObject({ freshQuestions: 5, weightedAccuracy: 1, cp: 45 });
    const allSeen = qualify(test({ items: quick(() => true, () => ({ seenBefore: true })) }), P);
    expect(allSeen).toMatchObject({ qualified: true, cp: 0 });
  });

  it('unanswered counts as wrong; removed questions are left out entirely', () => {
    const removed = qualify(test({ items: quick(() => true, (i) => ({ excluded: i === 9 })) }), P);
    expect(removed).toMatchObject({ eligibleQuestions: 9, accuracy: 1, cp: 90 });
  });

  it('a small improvement bonus over the last comparable test, never a penalty', () => {
    const better = qualify(test({ items: quick((i) => i < 8), previousAccuracy: 0.5 }), P);
    const worse = qualify(test({ items: quick((i) => i < 8), previousAccuracy: 0.9 }), P);
    expect(better.parts.improvement).toBeCloseTo(0.1 * 100 * 0.3, 3);
    expect(worse.parts.improvement).toBe(0);
    expect(better.cp - worse.cp).toBe(3);
  });

  it('practice, retests, drafts, uncommitted, invalidated and tiny tests earn nothing, with the reasons', () => {
    expect(qualify(test({ mode: 'PRACTICE', blueprint: 'PRACTICE10' }), P)).toMatchObject({ qualified: false, cp: 0, reasons: ['NOT_A_TEST', 'NOT_COMPETITIVE_DESIGN'] });
    // Practice is never "committed" (only a test's first lock commits it): that is not a second reason.
    expect(qualify(test({ mode: 'PRACTICE', competitiveEligible: false }), P).reasons).toEqual(['NOT_A_TEST']);
    expect(qualify(test({ blueprint: 'RETEST10' }), P).reasons).toEqual(['NOT_COMPETITIVE_DESIGN']);
    expect(qualify(test({ competitiveEligible: false }), P).reasons).toEqual(['NOT_COMMITTED']);
    expect(qualify(test({ invalidated: true }), P).reasons).toEqual(['INVALIDATED']);
    expect(qualify(test({ items: quick(() => true, (i) => ({ excluded: i < 6 })) }), P).reasons).toEqual(['TOO_FEW_QUESTIONS']);
  });

  it('a Subject 20 is worth up to 200, never more', () => {
    const items = [...quick(() => true), ...quick(() => true)];
    expect(qualify(test({ blueprint: 'SUBJECT20', items, previousAccuracy: 0 }), P).cp).toBe(200);
  });
});

describe('ledgerEntry (append-only, compensating)', () => {
  it('awards once, adjusts on a change, reverses to zero, and does nothing when already right', () => {
    expect(ledgerEntry(0, 72, true)).toEqual({ kind: 'AWARD', amount: 72 });
    expect(ledgerEntry(72, 80, false)).toEqual({ kind: 'ADJUSTMENT', amount: 8 });
    expect(ledgerEntry(80, 75, false)).toEqual({ kind: 'ADJUSTMENT', amount: -5 });
    expect(ledgerEntry(75, 0, false)).toEqual({ kind: 'REVERSAL', amount: -75 });
    expect(ledgerEntry(0, 0, true)).toBeNull();
    expect(ledgerEntry(40, 40, false)).toBeNull();
  });
});

describe('xpFor', () => {
  it('rewards taking part, whatever the score; nothing for nothing', () => {
    expect(xpFor(10, P)).toBe(15);
    expect(xpFor(3, P)).toBe(8);
    expect(xpFor(0, P)).toBe(0);
  });
});

describe('weekOf (Monday 00:00 India time)', () => {
  it('starts on Monday at 00:00 IST, which is Sunday 18:30 UTC', () => {
    const w = weekOf(new Date('2026-10-14T12:00:00Z'), P); // a Wednesday
    expect(w.start.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-18T18:30:00.000Z');
    // Sunday 20:00 UTC is already Monday in India: the next week.
    expect(weekOf(new Date('2026-10-18T20:00:00Z'), P).start.toISOString()).toBe('2026-10-18T18:30:00.000Z');
    expect(weekOf(new Date('2026-10-18T18:29:59Z'), P).start.toISOString()).toBe('2026-10-11T18:30:00.000Z');
  });
});

describe('rank', () => {
  const s = (id: string, over: Partial<Standing> = {}): Standing => ({
    studentId: id,
    cp: 100,
    qualified: 2,
    eligibleQuestions: 20,
    accuracy: 0.7,
    latestAt: new Date('2026-10-14T10:00:00Z'),
    difficulty: 1.2,
    ...over,
  });

  it('needs 2 qualified tests and 20 eligible questions', () => {
    expect(isRankable(s('a'), P)).toBe(true);
    expect(isRankable(s('a', { qualified: 1, eligibleQuestions: 30 }), P)).toBe(false);
    expect(isRankable(s('a', { eligibleQuestions: 19 }), P)).toBe(false);
    expect(stillNeeded({ qualified: 1, eligibleQuestions: 10 }, P)).toEqual({ tests: 1, questions: 10 });
  });

  it('CP first, then accuracy, then fresher evidence, then harder tests; equal on all four share a rank', () => {
    const r = rank(
      [
        s('low', { cp: 90 }),
        s('acc', { accuracy: 0.8 }),
        s('fresh', { latestAt: new Date('2026-10-14T11:00:00Z') }),
        s('hard', { difficulty: 1.3 }),
        s('tieA'),
        s('tieB'),
        s('unranked', { cp: 500, qualified: 1 }),
      ],
      P,
    );
    expect(r.map((x) => [x.studentId, x.rank])).toEqual([
      ['acc', 1],
      ['fresh', 2],
      ['hard', 3],
      ['tieA', 4],
      ['tieB', 4],
      ['low', 6],
    ]);
  });
});

describe('publicHandle', () => {
  it('is a neutral handle with no ambiguous characters', () => {
    let i = 0;
    const h = publicHandle(() => [0, 0.99, 0.5, 0.25, 0.75, 0.1][i++]);
    expect(h).toMatch(/^Learner-[A-HJ-NP-Z2-9]{6}$/);
  });
});

describe('parseCompetitionPolicy', () => {
  it('accepts CP_V1 and refuses broken ones', () => {
    expect(parseCompetitionPolicy(JSON.parse(JSON.stringify(P)))).toEqual(P);
    expect(() => parseCompetitionPolicy({ ...P, base: { QUICK10: -1 } })).toThrow(/base/);
    expect(() => parseCompetitionPolicy({ ...P, accuracyShare: 0.95, improvementShare: 0.1 })).toThrow(/add up/);
    expect(() => parseCompetitionPolicy(null)).toThrow(/difficultyWeight.EASY/);
  });
});

describe('the seeded policy', () => {
  it('in the migration SQL is exactly CP_V1 in code', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const sql: string = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-015_COMPETITION_MIGRATION_EXTRA.sql'), 'utf8');
    const json = sql.match(/'(\{.*\})'::jsonb/)![1];
    expect(parseCompetitionPolicy(JSON.parse(json))).toEqual(P);
  });
});
