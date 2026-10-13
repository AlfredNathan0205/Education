import { runDeterministicChecks, assessConfidence, CONFIDENCE_WEIGHTS, ROUTE_THRESHOLDS, type ConfidenceDimension } from './question-governance';
import { REASON_CODES, isReasonCode } from './reason-codes';
import type { QuestionDraft } from './question-domain';

const good = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  code: 'Q1', objectiveCode: 'O1', stem: 'What is the unit of electric current?',
  options: ['Volt', 'Ampere', 'Ohm', 'Watt'], correctIndex: 1, difficulty: 'EASY', cognitive: 'C1',
  explanation: 'The ampere measures current.', ...over,
});

describe('reason codes', () => {
  it('accepts only listed codes', () => {
    expect(REASON_CODES.length).toBeGreaterThan(5);
    expect(isReasonCode('ANSWER_WRONG')).toBe(true);
    for (const bad of ['answer_wrong', '', null, undefined, 3, 'MADE_UP']) expect(isReasonCode(bad)).toBe(false);
  });
});

describe('runDeterministicChecks', () => {
  it('passes a well-formed tagged question with no findings', () => {
    expect(runDeterministicChecks(good())).toMatchObject({ passed: true, critical: 0, major: 0, minor: 0, validatorVersion: 'det-1' });
  });
  it('fails on structure and on a missing cognitive level', () => {
    const r = runDeterministicChecks(good({ options: ['A', 'A', 'B', 'C'], cognitive: null }));
    expect(r.passed).toBe(false);
    expect(r.findings.map((f) => f.code)).toEqual(expect.arrayContaining(['STRUCTURE', 'COGNITIVE_MISSING']));
    expect(r.critical).toBe(2);
  });
  it('a missing explanation is major and does not block', () => {
    const r = runDeterministicChecks(good({ explanation: null }));
    expect(r).toMatchObject({ passed: true, major: 1, critical: 0 });
  });
  it('flags all/none of the above and a length cue as minor', () => {
    const a = runDeterministicChecks(good({ options: ['Volt', 'Ampere', 'Ohm', 'All of the above'] }));
    expect(a.findings.map((f) => f.code)).toContain('ALL_NONE_OPTION');
    const long = 'The SI base unit used for measuring electric current in a circuit';
    const b = runDeterministicChecks(good({ options: ['Volt', long, 'Ohm', 'Watt'] }));
    expect(b.findings.map((f) => f.code)).toContain('LENGTH_CUE');
    expect(a.passed && b.passed).toBe(true);
  });
  it('does not raise a length cue when the long option is wrong or all are long', () => {
    const long = 'The SI base unit used for measuring electric current in a circuit';
    expect(runDeterministicChecks(good({ options: ['Volt', 'Ampere', long, 'Watt'] })).findings.map((f) => f.code)).not.toContain('LENGTH_CUE');
    expect(runDeterministicChecks(good({ options: [long, long + ' a', long + ' b', long + ' c'], correctIndex: 0 })).findings.map((f) => f.code)).not.toContain('LENGTH_CUE');
  });
});

const all = (v: number) => Object.fromEntries(Object.keys(CONFIDENCE_WEIGHTS).map((k) => [k, v])) as Record<ConfidenceDimension, number>;
const ev = (scores: Partial<Record<ConfidenceDimension, number>>, over = {}) => ({ scores, criticalGates: [] as ConfidenceDimension[], unresolvedConflict: false, repairable: false, ...over });

describe('assessConfidence', () => {
  it('uses the spec weights, which sum to 1, and the spec thresholds', () => {
    expect(Object.values(CONFIDENCE_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(CONFIDENCE_WEIGHTS).toMatchObject({ answer: 0.3, curriculum: 0.2, ambiguity: 0.15 });
    expect(ROUTE_THRESHOLDS).toEqual({ green: 0.985, yellow: 0.95, amber: 0.9 });
  });
  it('routes by score', () => {
    expect(assessConfidence(ev(all(1)))).toMatchObject({ score: 1, route: 'GREEN' });
    expect(assessConfidence(ev(all(0.985)))).toMatchObject({ route: 'GREEN' });
    expect(assessConfidence(ev(all(0.97), { repairable: true }))).toMatchObject({ route: 'YELLOW' });
    expect(assessConfidence(ev(all(0.97), { repairable: false }))).toMatchObject({ route: 'AMBER' });
    expect(assessConfidence(ev(all(0.92)))).toMatchObject({ route: 'AMBER' });
    expect(assessConfidence(ev(all(0.9)))).toMatchObject({ route: 'AMBER' });
    expect(assessConfidence(ev(all(0.89)))).toMatchObject({ route: 'RED' });
  });
  it('a critical gate overrides a perfect score', () => {
    expect(assessConfidence(ev(all(1), { criticalGates: ['answer'] }))).toMatchObject({ route: 'RED', score: null });
  });
  it('an unresolved conflict is RED even with a perfect score', () => {
    expect(assessConfidence(ev(all(1), { unresolvedConflict: true })).route).toBe('RED');
  });
  it('never routes on incomplete evidence', () => {
    const { answer, ...rest } = all(1);
    void answer;
    expect(assessConfidence(ev(rest))).toMatchObject({ route: null, score: null });
    expect(assessConfidence(ev({})).route).toBeNull();
  });
  it('weights the answer most: a bad answer score drops a question out of GREEN on its own', () => {
    expect(assessConfidence(ev({ ...all(1), answer: 0.9 })).route).not.toBe('GREEN');
    // the same drop on the lightly weighted readability dimension still leaves 0.99, which is GREEN
    expect(assessConfidence(ev({ ...all(1), readability: 0.8 }))).toMatchObject({ score: 0.99, route: 'GREEN' });
  });
  it('rejects scores outside 0..1', () => {
    expect(() => assessConfidence(ev({ ...all(1), answer: 1.2 }))).toThrow(RangeError);
    expect(() => assessConfidence(ev({ ...all(1), answer: Number.NaN }))).toThrow(RangeError);
  });
});
