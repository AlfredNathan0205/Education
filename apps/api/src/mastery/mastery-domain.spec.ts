import {
  MASTERY_V1 as P,
  confidenceOf,
  labelFor,
  objectiveState,
  parsePolicy,
  rollup,
  sliceState,
  weightsFor,
  type EvidenceRow,
} from './mastery-domain';

const NOW = new Date('2026-10-14T12:00:00Z');
let q = 0;
function ev(score: number, over: Partial<EvidenceRow> = {}): EvidenceRow {
  q++;
  return { score, weight: 0.9, wQuality: 1, mode: 'TEST', questionId: `q${q}`, sessionId: 's1', at: NOW, ...over };
}

describe('weightsFor (spec: independence x context x item quality, capped)', () => {
  it('uses the spec baseline numbers', () => {
    expect(weightsFor({ mode: 'TEST', testSize: 10, health: 'HEALTHY', repeat: false }, P)).toEqual({ independence: 1, context: 0.9, quality: 1, weight: 0.9 });
    expect(weightsFor({ mode: 'TEST', testSize: 20, health: 'HEALTHY', repeat: false }, P).weight).toBe(1);
    expect(weightsFor({ mode: 'PRACTICE', testSize: 10, health: 'WATCH', repeat: false }, P).weight).toBe(0.42);
    expect(weightsFor({ mode: 'TEST', testSize: 10, health: null, repeat: false }, P).quality).toBe(0.9);
    expect(weightsFor({ mode: 'TEST', testSize: 20, health: 'HEALTHY', repeat: true }, P).weight).toBe(0.05);
    expect(weightsFor({ mode: 'TEST', testSize: 20, health: 'QUARANTINED', repeat: false }, P).weight).toBe(0);
  });
});

describe('objectiveState', () => {
  it('nothing yet is NOT_STARTED, not zero', () => {
    const s = objectiveState([], P, NOW);
    expect(s).toMatchObject({ label: 'NOT_STARTED', reportable: false, mastery: 0.5, confidence: 0, evidenceCount: 0 });
  });

  it('one correct answer is not mastery; one wrong answer is not a weakness', () => {
    expect(objectiveState([ev(1)], P, NOW).label).toBe('BUILDING_EVIDENCE');
    expect(objectiveState([ev(0)], P, NOW).label).toBe('BUILDING_EVIDENCE');
  });

  it('applies the Bayesian accumulator with the mild neutral prior', () => {
    const s = objectiveState([ev(1, { weight: 1 }), ev(0, { weight: 0.5 })], P, NOW);
    expect(s.alpha).toBe(2);
    expect(s.beta).toBe(1.5);
    expect(s.mastery).toBeCloseTo(2 / 3.5, 4);
    expect(s.effectiveEvidence).toBe(1.5);
  });

  it('passes the ordinary gate with enough independent, controlled evidence over two sessions', () => {
    const rows = [...Array.from({ length: 4 }, () => ev(1, { sessionId: 's1', weight: 1 })), ...Array.from({ length: 3 }, () => ev(1, { sessionId: 's2', weight: 1 }))];
    const s = objectiveState(rows, P, NOW);
    expect(s).toMatchObject({ reportable: true, families: 7, sessions: 2, controlledEvidence: 7 });
    expect(s.confidence).toBeGreaterThanOrEqual(75);
    expect(s.label).toBe('STRONG');
  });

  it('a single session never passes, however much evidence', () => {
    const s = objectiveState(Array.from({ length: 12 }, () => ev(1, { weight: 1 })), P, NOW);
    expect(s).toMatchObject({ sessions: 1, reportable: false, label: 'BUILDING_EVIDENCE' });
  });

  it('practice alone cannot manufacture mastery', () => {
    const rows = Array.from({ length: 12 }, (_, i) => ev(1, { mode: 'PRACTICE', weight: 0.6, sessionId: `p${i % 3}` }));
    const s = objectiveState(rows, P, NOW);
    expect(s.effectiveEvidence).toBeGreaterThanOrEqual(5);
    expect(s).toMatchObject({ controlledEvidence: 0, reportable: false, label: 'BUILDING_EVIDENCE' });
  });

  it('the same question answered again adds almost nothing and is not a new family', () => {
    const same = ev(1, { weight: 1 });
    const repeats = Array.from({ length: 8 }, (_, i) => ({ ...same, weight: i === 0 ? 1 : 0.05, sessionId: `s${i % 2}` }));
    const s = objectiveState(repeats, P, NOW);
    expect(s.families).toBe(1);
    expect(s.effectiveEvidence).toBeCloseTo(1.35, 4);
    expect(s.reportable).toBe(false);
  });

  it('recency lowers confidence, never mastery', () => {
    const rows = (at: Date) => [...Array.from({ length: 4 }, () => ev(1, { weight: 1, at })), ...Array.from({ length: 3 }, () => ev(1, { weight: 1, sessionId: 's2', at }))];
    const fresh = objectiveState(rows(NOW), P, NOW);
    const old = objectiveState(rows(new Date('2026-01-01T00:00:00Z')), P, NOW);
    expect(old.mastery).toBe(fresh.mastery);
    expect(old.confidence).toBeLessThan(fresh.confidence);
  });

  it('evidence with zero weight (quarantined item) counts for nothing', () => {
    const s = objectiveState([ev(0, { weight: 0, wQuality: 0 })], P, NOW);
    expect(s).toMatchObject({ mastery: 0.5, effectiveEvidence: 0, families: 0, sessions: 0, confidence: 0, label: 'BUILDING_EVIDENCE' });
  });
});

describe('labelFor (claim gates)', () => {
  const ok = { confidence: 90, effectiveEvidence: 8, families: 4, sessions: 3, controlledEvidence: 8, evidenceCount: 8 };
  it('maps reportable mastery to bands', () => {
    expect(labelFor({ ...ok, mastery: 0.9 }, P).label).toBe('STRONG');
    expect(labelFor({ ...ok, mastery: 0.75 }, P).label).toBe('SECURE');
    expect(labelFor({ ...ok, mastery: 0.6 }, P).label).toBe('DEVELOPING');
    expect(labelFor({ ...ok, mastery: 0.4 }, P).label).toBe('NEEDS_ATTENTION');
  });
  it('a high score without the strong gate is Secure, not Strong', () => {
    expect(labelFor({ ...ok, mastery: 0.9, families: 2 }, P)).toEqual({ label: 'SECURE', reportable: true });
  });
  it('a low score without the stricter weak gate is Building evidence, not Needs attention', () => {
    expect(labelFor({ ...ok, mastery: 0.3, effectiveEvidence: 5.2, families: 2 }, P)).toEqual({ label: 'BUILDING_EVIDENCE', reportable: false });
  });
});

describe('confidenceOf', () => {
  it('rises with volume and diversity and is 0 with no evidence', () => {
    const base = { families: 3, sessions: 2, quality: 1, last: NOW, now: NOW };
    expect(confidenceOf({ ...base, effective: 0 }, P)).toBe(0);
    expect(confidenceOf({ ...base, effective: 2 }, P)).toBeLessThan(confidenceOf({ ...base, effective: 6 }, P));
    expect(confidenceOf({ ...base, effective: 6, families: 1 }, P)).toBeLessThan(confidenceOf({ ...base, effective: 6, families: 2 }, P));
  });
});

describe('sliceState and rollup', () => {
  it('slices use the same accumulator', () => {
    expect(sliceState([{ score: 1, weight: 1 }, { score: 0, weight: 1 }], P)).toEqual({ mastery: 0.5, effectiveEvidence: 2, evidenceCount: 2 });
  });

  const o = (label: any, mastery: number, reportable = true) => ({ label, reportable, mastery, effectiveEvidence: 6 });
  it('a chapter is labelled only when enough of its objectives are', () => {
    expect(rollup([o('NOT_STARTED', 0.5, false), o('NOT_STARTED', 0.5, false)], P).label).toBe('NOT_STARTED');
    expect(rollup([o('SECURE', 0.8), o('BUILDING_EVIDENCE', 0.9, false), o('NOT_STARTED', 0.5, false)], P)).toMatchObject({ label: 'BUILDING_EVIDENCE', reportable: 1, total: 3, started: 2 });
    expect(rollup([o('SECURE', 0.8), o('SECURE', 0.75), o('NOT_STARTED', 0.5, false)], P).label).toBe('SECURE');
  });
  it('never hides an objective that needs attention behind a good average', () => {
    expect(rollup([o('STRONG', 0.95), o('STRONG', 0.95), o('NEEDS_ATTENTION', 0.4)], P).label).toBe('DEVELOPING');
  });
});

describe('parsePolicy', () => {
  it('accepts the seeded policy and refuses an incomplete one', () => {
    expect(parsePolicy(JSON.parse(JSON.stringify(P)))).toEqual(P);
    expect(() => parsePolicy({ ...P, gates: { ...P.gates, ordinary: { confidence: 75 } } })).toThrow(/gates.ordinary.effective/);
    expect(() => parsePolicy(null)).toThrow(/prior.alpha/);
  });
});

describe('the seeded policy', () => {
  it('in the migration SQL is exactly MASTERY_V1 in code', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    const { join } = require('node:path');
    const sql: string = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-013_MASTERY_MIGRATION_EXTRA.sql'), 'utf8');
    const json = sql.match(/'(\{.*\})'::jsonb/)![1];
    expect(parsePolicy(JSON.parse(json))).toEqual(P);
  });
});
