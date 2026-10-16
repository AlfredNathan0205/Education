import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { READINESS_V1, evaluateReadiness, objectiveState, parsePolicy, type ReadinessInput } from './readiness-domain';

const EXTRA = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-021_READINESS_MIGRATION_EXTRA.sql'), 'utf8');

/** A subject with `chapters` chapters of `objectives` objectives, and `per` distinct questions per objective spread over difficulties and levels. */
function subject(chapters: number, objectives: number, per: (path: string) => number, extra: Partial<ReadinessInput> = {}): ReadinessInput {
  const ch = Array.from({ length: chapters }, (_, c) => ({
    code: `CH${c + 1}`,
    title: `Chapter ${c + 1}`,
    objectives: Array.from({ length: objectives }, (_, o) => `CH${c + 1}/T1/M1/LO${o + 1}`),
  }));
  const items: ReadinessInput['items'] = [];
  let n = 0;
  for (const c of ch)
    for (const path of c.objectives)
      for (let i = 0; i < per(path); i++) {
        n++;
        items.push({ questionId: `q${n}`, objectivePath: path, difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[n % 3], cognitive: `C${(n % 4) + 1}`, stemHash: `h${n}` });
      }
  return {
    curriculumState: 'ACTIVE',
    chapters: ch,
    items,
    awaitingPublication: 0,
    quality: { approved: items.length, quarantined: 0, degraded: 0 },
    designs: [{ code: 'QUICK10', name: 'Quick 10', total: 10, difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 } }],
    ...extra,
  };
}

describe('the readiness policy', () => {
  it('the migration seeds READINESS_V1 exactly as the code defines it', () => {
    const m = /'READINESS_V1', 'ACTIVE',\s*'(\{.*\})'::jsonb/.exec(EXTRA);
    expect(m).not.toBeNull();
    const { code, ...params } = READINESS_V1;
    expect(JSON.parse(m![1])).toEqual(params);
    expect(parsePolicy(code, JSON.parse(m![1]))).toEqual(READINESS_V1);
    expect(EXTRA).not.toMatch(/FOREIGN KEY|REFERENCES/);
  });

  it('uses the spec where the spec has a number', () => {
    expect(READINESS_V1.objective).toEqual({ limited: 5, assessmentReady: 8, robust: 12 });
    expect(READINESS_V1.tiers.GENERAL.chapterMin).toBe(120);
    expect(READINESS_V1.tiers.GENERAL.maxQualityIssueShare).toBe(0.01);
  });

  it('refuses a policy that is incomplete, out of range, or less strict for a wider audience', () => {
    const { code: _c, ...ok } = READINESS_V1;
    expect(() => parsePolicy('bad code', ok)).toThrow(/code/);
    expect(() => parsePolicy('POL2', { ...ok, objective: { limited: 9, assessmentReady: 8, robust: 12 } })).toThrow(/must not decrease/);
    expect(() => parsePolicy('POL2', { ...ok, tiers: { ...ok.tiers, GENERAL: undefined } })).toThrow(/GENERAL is missing/);
    expect(() => parsePolicy('POL2', { ...ok, tiers: { ...ok.tiers, GENERAL: { ...ok.tiers.GENERAL, chapterMin: 20 } } })).toThrow(/GENERAL.chapterMin is less strict/);
    expect(() => parsePolicy('POL2', { ...ok, tiers: { ...ok.tiers, CONTROLLED: { ...ok.tiers.CONTROLLED, maxQualityIssueShare: 0.5 } } })).toThrow(/maxQualityIssueShare/);
    expect(() => parsePolicy('POL2', { ...ok, tiers: { ...ok.tiers, INTERNAL: { ...ok.tiers.INTERNAL, objectivesReadyShare: 2 } } })).toThrow(/from 0 to 1/);
    expect(parsePolicy('POL2', ok).code).toBe('POL2');
  });
});

describe('evaluating a subject', () => {
  it('objective states by distinct questions', () => {
    expect([0, 4, 5, 7, 8, 11, 12].map((n) => objectiveState(n, READINESS_V1))).toEqual(['NOT_READY', 'NOT_READY', 'LIMITED', 'LIMITED', 'ASSESSMENT_READY', 'ASSESSMENT_READY', 'ROBUST']);
  });

  it('a thin bank is ready for nothing, and says exactly why', () => {
    const r = evaluateReadiness(subject(2, 4, () => 1), READINESS_V1);
    expect(r.highest).toBe('FOUNDATION_ONLY');
    expect(r.objectiveStates).toEqual({ NOT_READY: 8, LIMITED: 0, ASSESSMENT_READY: 0, ROBUST: 0 });
    const failing = r.tiers.INTERNAL.checks.filter((c) => !c.ok).map((c) => c.code);
    expect(failing).toEqual(expect.arrayContaining(['OBJECTIVES_LIMITED', 'CHAPTER_SIZE', 'DESIGN_QUICK10']));
    expect(r.tiers.INTERNAL.checks.find((c) => c.code === 'CHAPTER_SIZE')!.message).toMatch(/CH1 \(4\), CH2 \(4\)/);
  });

  it('enough for internal testing, not for the beta', () => {
    const r = evaluateReadiness(subject(2, 4, () => 5), READINESS_V1);
    expect(r.tiers.INTERNAL.pass).toBe(true);
    expect(r.tiers.CONTROLLED.pass).toBe(false);
    expect(r.highest).toBe('INTERNAL');
  });

  it('a bank that meets the beta bar passes CONTROLLED but not GENERAL', () => {
    const r = evaluateReadiness(subject(2, 8, () => 8), READINESS_V1);
    expect(r.tiers.CONTROLLED.checks.filter((c) => !c.ok)).toEqual([]);
    expect(r.highest).toBe('CONTROLLED');
    expect(r.tiers.GENERAL.checks.filter((c) => !c.ok).map((c) => c.code)).toEqual(expect.arrayContaining(['OBJECTIVES_ROBUST', 'CHAPTER_SIZE']));
  });

  it('a full bank passes every tier', () => {
    const r = evaluateReadiness(subject(2, 10, () => 13), READINESS_V1);
    expect(r.highest).toBe('GENERAL');
    expect(r.totals).toMatchObject({ servable: 260, distinct: 260, objectives: 20, chapters: 2 });
  });

  it('tiers are cumulative: failing INTERNAL means nothing higher counts', () => {
    const r = evaluateReadiness(subject(2, 10, () => 13, { curriculumState: 'APPROVED' }), READINESS_V1);
    expect(r.tiers.INTERNAL.pass).toBe(false);
    expect(r.highest).toBe('FOUNDATION_ONLY');
    expect(r.tiers.INTERNAL.checks.find((c) => c.code === 'CURRICULUM_ACTIVE')!.message).toMatch(/APPROVED, not ACTIVE/);
  });

  it('exact duplicates count once; a missing difficulty or cognitive range in one chapter is named', () => {
    const base = subject(2, 10, () => 13);
    const dup = { ...base, items: base.items.map((i) => (i.objectivePath.startsWith('CH1/') ? { ...i, stemHash: 'same' } : i)) };
    const r = evaluateReadiness(dup, READINESS_V1);
    expect(r.totals.distinct).toBe(131);
    expect(r.objectives[0]).toMatchObject({ chapter: 'CH1', eqc: 0, state: 'NOT_READY' });
    expect(r.highest).toBe('FOUNDATION_ONLY');
    const noHard = { ...base, items: base.items.map((i) => (i.objectivePath.startsWith('CH2/') && i.difficulty === 'HARD' ? { ...i, difficulty: 'MEDIUM' as const } : i)) };
    expect(evaluateReadiness(noHard, READINESS_V1).tiers.INTERNAL.checks.find((c) => c.code === 'CHAPTER_DIFFICULTY')!.message).toMatch(/CH2 \(HARD\)/);
    const oneLevel = { ...base, items: base.items.map((i) => ({ ...i, cognitive: 'C1' })) };
    expect(evaluateReadiness(oneLevel, READINESS_V1).tiers.CONTROLLED.checks.find((c) => c.code === 'CHAPTER_COGNITIVE')!.ok).toBe(false);
  });

  it('quarantined and degraded questions count against quality', () => {
    const base = subject(2, 10, () => 13);
    const r = evaluateReadiness({ ...base, quality: { approved: 260, quarantined: 2, degraded: 2 } }, READINESS_V1);
    expect(r.quality.issueShare).toBeCloseTo(4 / 262, 4);
    expect(r.tiers.GENERAL.checks.find((c) => c.code === 'QUALITY')!.ok).toBe(false);
    expect(r.tiers.CONTROLLED.checks.find((c) => c.code === 'QUALITY')!.ok).toBe(true);
    expect(r.highest).toBe('CONTROLLED');
  });

  it('a design whose mix the bank cannot support several times over fails', () => {
    const base = subject(1, 10, () => 13);
    const r = evaluateReadiness({ ...base, designs: [{ code: 'SUBJECT20', name: 'Subject 20', total: 20, difficulty: { EASY: 8, MEDIUM: 7, HARD: 5 } }] }, READINESS_V1);
    // 130 questions, about 43 of each difficulty: GENERAL needs 10× (80 easy).
    expect(r.tiers.GENERAL.checks.find((c) => c.code === 'DESIGN_SUBJECT20')!.message).toMatch(/short of easy/);
  });

  it('development: a curriculum served under EXAM_ALLOW_UNACTIVATED_CURRICULUM passes the curriculum check, and says why', () => {
    const r = evaluateReadiness(subject(2, 10, () => 13, { curriculumState: 'AI_STRUCTURED', servedUnactivated: true }), READINESS_V1);
    const c = r.tiers.INTERNAL.checks.find((x) => x.code === 'CURRICULUM_ACTIVE')!;
    expect(c).toMatchObject({ ok: true, message: expect.stringMatching(/AI_STRUCTURED: served only because EXAM_ALLOW_UNACTIVATED_CURRICULUM is on/) });
    expect(evaluateReadiness(subject(2, 10, () => 13, { curriculumState: 'AI_STRUCTURED' }), READINESS_V1).highest).toBe('FOUNDATION_ONLY');
  });

  it('the CI case: one objective, 12 questions (4 of each difficulty) cannot hold Quick 10 (5 easy) even once; 15 can', () => {
    const lenient = parsePolicy('IT_LENIENT', {
      objective: { limited: 1, assessmentReady: 2, robust: 3 },
      tiers: Object.fromEntries(['INTERNAL', 'CONTROLLED', 'GENERAL'].map((t) => [t, { objectivesLimitedShare: 1, objectivesReadyShare: 0, objectivesRobustShare: 0, chapterMin: 1, chapterMinPerDifficulty: 1, chapterMinCognitive: 0, maxQualityIssueShare: 1, designDepth: 1 }])),
    });
    const twelve = evaluateReadiness(subject(1, 1, () => 12), lenient);
    expect(twelve.highest).toBe('FOUNDATION_ONLY');
    expect(twelve.tiers.INTERNAL.checks.filter((c) => !c.ok).map((c) => c.code)).toEqual(['DESIGN_QUICK10']);
    expect(evaluateReadiness(subject(1, 1, () => 15), lenient).highest).toBe('GENERAL');
  });

  it('the result holds no nulls (it is stored as JSON)', () => {
    expect(JSON.stringify(evaluateReadiness(subject(2, 3, () => 2), READINESS_V1))).not.toContain('null');
    expect(evaluateReadiness(subject(2, 3, () => 2), READINESS_V1).eqcNote).toMatch(/upper bound/);
  });
});
