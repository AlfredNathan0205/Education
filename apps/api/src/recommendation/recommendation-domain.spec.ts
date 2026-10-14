import {
  RECO_V1 as P,
  missedTargets,
  parseRecommendationPolicy,
  planRefresh,
  practiceTargets,
  putOffObjectives,
  type ActiveRecommendation,
  type ObjectiveFacts,
} from './recommendation-domain';

const at = (d: string) => new Date(`2026-10-${d}T12:00:00Z`);
const o = (path: string, over: Partial<ObjectiveFacts> = {}): ObjectiveFacts => ({
  path,
  label: 'BUILDING_EVIDENCE',
  reportable: false,
  mastery: 0.5,
  evidenceCount: 3,
  lastEvidenceAt: at('10'),
  ...over,
});

describe('practiceTargets (provisional RECO_V1 rules)', () => {
  it('Needs attention first, then Developing, then below every gate with more missed than right', () => {
    const t = practiceTargets(
      [
        o('A/1/1/LOW', { mastery: 0.3 }),
        o('A/1/1/DEV', { label: 'DEVELOPING', reportable: true, mastery: 0.62 }),
        o('A/1/1/NA', { label: 'NEEDS_ATTENTION', reportable: true, mastery: 0.4 }),
        o('A/1/1/SEC', { label: 'SECURE', reportable: true, mastery: 0.8 }),
      ],
      new Set(),
      P,
    );
    expect(t.map((x) => [x.path, x.code])).toEqual([
      ['A/1/1/NA', 'NEEDS_ATTENTION'],
      ['A/1/1/DEV', 'DEVELOPING'],
      ['A/1/1/LOW', 'MISSED_MORE_THAN_RIGHT'],
    ]);
    expect(t[0].facts).toEqual({ label: 'NEEDS_ATTENTION', answers: 3, mastery: 0.4 });
  });

  it('never chooses Secure, Strong, not-started, one-answer or even objectives', () => {
    const t = practiceTargets(
      [
        o('S', { label: 'STRONG', reportable: true, mastery: 0.95 }),
        o('N', { label: 'NOT_STARTED', evidenceCount: 0 }),
        o('ONE', { evidenceCount: 1, mastery: 0.36 }),
        o('EVEN', { mastery: 0.5 }),
      ],
      new Set(),
      P,
    );
    expect(t).toEqual([]);
  });

  it('takes at most maxObjectives, lowest mastery then most recent first, and leaves out what was put off', () => {
    const many = [o('a', { mastery: 0.2, lastEvidenceAt: at('01') }), o('b', { mastery: 0.2, lastEvidenceAt: at('09') }), o('c', { mastery: 0.1 }), o('d', { mastery: 0.4 }), o('e', { mastery: 0.3 })];
    expect(practiceTargets(many, new Set(), P).map((x) => x.path)).toEqual(['c', 'b', 'a']);
    expect(practiceTargets(many, new Set(['c', 'b']), P).map((x) => x.path)).toEqual(['a', 'e', 'd']);
  });
});

describe('missedTargets (practise what you missed)', () => {
  it('wrong and unanswered count; excluded never does; most missed first', () => {
    const items = [
      { objectivePath: 'X', locked: true, isCorrect: false, excluded: false },
      { objectivePath: 'X', locked: false, isCorrect: null, excluded: false },
      { objectivePath: 'Y', locked: true, isCorrect: false, excluded: false },
      { objectivePath: 'Z', locked: true, isCorrect: true, excluded: false },
      { objectivePath: 'W', locked: false, isCorrect: null, excluded: true },
      { objectivePath: 'A', locked: true, isCorrect: false, excluded: false },
      { objectivePath: 'B', locked: true, isCorrect: false, excluded: false },
    ];
    const t = missedTargets(items, 'as-1', P);
    expect(t.map((x) => x.path)).toEqual(['X', 'A', 'B']);
    expect(t[0]).toEqual({ path: 'X', code: 'MISSED_IN_TEST', facts: { assessmentId: 'as-1', missed: 2 } });
    expect(missedTargets([{ objectivePath: 'Z', locked: true, isCorrect: true, excluded: false }], 'as-2', P)).toEqual([]);
  });
});

describe('planRefresh (one active recommendation per subject)', () => {
  const targets = [
    { path: 'p1', code: 'NEEDS_ATTENTION' as const, facts: {} },
    { path: 'p2', code: 'DEVELOPING' as const, facts: {} },
  ];
  const active = (over: Partial<ActiveRecommendation>): ActiveRecommendation => ({ id: 'r1', kind: 'PRACTICE', status: 'OPEN', objectivePaths: ['p1', 'p2'], session: null, ...over });

  it('nothing active: recommends practice when something qualifies, nothing otherwise', () => {
    expect(planRefresh(null, targets, P)).toEqual([{ type: 'CREATE', kind: 'PRACTICE', source: 'MASTERY', objectivePaths: ['p1', 'p2'], reasons: targets, parentId: null }]);
    expect(planRefresh(null, [], P)).toEqual([]);
  });

  it('finished practice with enough answers: completed, and a retest offered on the same objectives', () => {
    const a = planRefresh(active({ status: 'STARTED', session: { status: 'SUBMITTED', lockedAnswers: 8 } }), [], P);
    expect(a[0]).toEqual({ type: 'COMPLETE', id: 'r1' });
    expect(a[1]).toMatchObject({ type: 'CREATE', kind: 'RETEST', source: 'PRACTICE_DONE', objectivePaths: ['p1', 'p2'], parentId: 'r1' });
    expect((a[1] as any).reasons[0]).toEqual({ path: 'p1', code: 'PRACTISED', facts: { practiceAnswers: 8 } });
  });

  it('practice finished with too few answers, abandoned or cancelled: reopened, no retest', () => {
    expect(planRefresh(active({ status: 'STARTED', session: { status: 'SUBMITTED', lockedAnswers: 4 } }), targets, P)).toEqual([{ type: 'REOPEN', id: 'r1' }]);
    expect(planRefresh(active({ status: 'STARTED', session: { status: 'VOID', lockedAnswers: 0 } }), targets, P)).toEqual([{ type: 'REOPEN', id: 'r1' }]);
    expect(planRefresh(active({ kind: 'RETEST', status: 'STARTED', session: { status: 'INVALIDATED', lockedAnswers: 9 } }), targets, P)).toEqual([{ type: 'REOPEN', id: 'r1' }]);
  });

  it('anything in progress, and an open retest, is left alone', () => {
    expect(planRefresh(active({ status: 'STARTED', session: { status: 'IN_PROGRESS', lockedAnswers: 3 } }), [], P)).toEqual([]);
    expect(planRefresh(active({ kind: 'RETEST' }), [], P)).toEqual([]);
  });

  it('a finished retest is completed and the subject looked at afresh', () => {
    const a = planRefresh(active({ kind: 'RETEST', status: 'STARTED', session: { status: 'SUBMITTED', lockedAnswers: 10 } }), targets.slice(0, 1), P);
    expect(a).toEqual([{ type: 'COMPLETE', id: 'r1' }, expect.objectContaining({ type: 'CREATE', kind: 'PRACTICE', objectivePaths: ['p1'] })]);
    expect(planRefresh(active({ kind: 'RETEST', status: 'STARTED', session: { status: 'SUBMITTED', lockedAnswers: 10 } }), [], P)).toEqual([{ type: 'COMPLETE', id: 'r1' }]);
  });

  it('an open practice is kept when the choice is the same, replaced when it changed, withdrawn when nothing qualifies', () => {
    expect(planRefresh(active({ objectivePaths: ['p2', 'p1'] }), targets, P)).toEqual([]);
    expect(planRefresh(active({ objectivePaths: ['p1'] }), targets, P)).toEqual([{ type: 'SUPERSEDE', id: 'r1' }, expect.objectContaining({ type: 'CREATE', objectivePaths: ['p1', 'p2'] })]);
    expect(planRefresh(active({}), [], P)).toEqual([{ type: 'SUPERSEDE', id: 'r1' }]);
  });
});

describe('putOffObjectives', () => {
  it('keeps "not now" objectives for the quiet period only', () => {
    const s = putOffObjectives([{ objectivePaths: ['a', 'b'], closedAt: at('08') }, { objectivePaths: ['c'], closedAt: at('01') }], at('10'), P);
    expect([...s].sort()).toEqual(['a', 'b']);
  });
});

describe('parseRecommendationPolicy', () => {
  it('accepts RECO_V1 and refuses an incomplete or nonsensical one', () => {
    expect(parseRecommendationPolicy(JSON.parse(JSON.stringify(P)))).toEqual(P);
    expect(() => parseRecommendationPolicy({ ...P, blueprints: { practice: 'x' } })).toThrow(/blueprints.practice, blueprints.retest/);
    expect(() => parseRecommendationPolicy({ ...P, practice: { ...P.practice, lowMastery: 1.5 } })).toThrow(/lowMastery/);
    expect(() => parseRecommendationPolicy(null)).toThrow(/practice.maxObjectives/);
  });
});

describe('the seeded policy', () => {
  it('in the migration SQL is exactly RECO_V1 in code', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const sql: string = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-014_RECOMMENDATION_MIGRATION_EXTRA.sql'), 'utf8');
    const json = sql.match(/'(\{.*\})'::jsonb/)![1];
    expect(parseRecommendationPolicy(JSON.parse(json))).toEqual(P);
  });
});
