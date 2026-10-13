import {
  InsufficientBankError,
  assembleQuick10,
  clampActiveMs,
  loadExamConfig,
  makeRng,
  nextStep,
  revealsAfterLock,
  scoreAssessment,
  slotToPosition,
  type Difficulty,
  type ItemProgress,
  type PoolItem,
} from './exam-domain';

function pool(counts: Record<Difficulty, number>, seenEvery = 0): PoolItem[] {
  const out: PoolItem[] = [];
  let n = 0;
  for (const d of ['EASY', 'MEDIUM', 'HARD'] as Difficulty[]) {
    for (let i = 0; i < counts[d]; i++) {
      n++;
      out.push({
        revisionId: `r${n}`,
        questionId: `q${n}`,
        objectivePath: `C${(n % 4) + 1}/T1/M1/O${n}`,
        difficulty: d,
        stemHash: `h${n}`,
        lastSeenAt: seenEvery && n % seenEvery === 0 ? new Date(2026, 0, n) : null,
      });
    }
  }
  return out;
}

describe('assembleQuick10', () => {
  it('delivers the 5/3/2 mix, 10 unique questions, positions 1..10', () => {
    const { items, report } = assembleQuick10(pool({ EASY: 12, MEDIUM: 12, HARD: 12 }), 'seed-a');
    expect(items).toHaveLength(10);
    expect(new Set(items.map((i) => i.questionId)).size).toBe(10);
    expect(items.map((i) => i.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(report.delivered).toEqual({ EASY: 5, MEDIUM: 3, HARD: 2 });
    expect(report.substitutions).toEqual([]);
  });

  it('is reproducible for a seed and differs for another', () => {
    const p = pool({ EASY: 12, MEDIUM: 12, HARD: 12 });
    const a = assembleQuick10(p, 's1').items.map((i) => i.revisionId);
    expect(assembleQuick10(p, 's1').items.map((i) => i.revisionId)).toEqual(a);
    expect(assembleQuick10(p, 's2').items.map((i) => i.revisionId)).not.toEqual(a);
  });

  it('opens with an EASY question', () => {
    for (const seed of ['a', 'b', 'c', 'd', 'e', 'f']) {
      expect(assembleQuick10(pool({ EASY: 8, MEDIUM: 8, HARD: 8 }), seed).items[0].difficulty).toBe('EASY');
    }
  });

  it('prefers questions the student has not seen', () => {
    const { report, items } = assembleQuick10(pool({ EASY: 8, MEDIUM: 8, HARD: 8 }, 3), 'x');
    expect(report.unseen).toBe(10);
    expect(items.every((i) => i.lastSeenAt === null)).toBe(true);
  });

  it('when everything was seen, prefers the least recently seen', () => {
    const base = pool({ EASY: 5, MEDIUM: 3, HARD: 2 });
    const aged = base.map((p, i) => ({ ...p, lastSeenAt: new Date(2026, 0, i + 1) }));
    expect(assembleQuick10(aged, 'x').report.unseen).toBe(0);
    const more = [...aged, ...pool({ EASY: 1, MEDIUM: 0, HARD: 0 }).map((p) => ({ ...p, revisionId: 'new', questionId: 'qnew', stemHash: 'hnew', lastSeenAt: new Date(2030, 0, 1) }))];
    const ids = assembleQuick10(more, 'x').items.map((i) => i.questionId);
    expect(ids).not.toContain('qnew'); // most recently seen EASY is left out
  });

  it('spreads across chapters before repeating one', () => {
    const { report } = assembleQuick10(pool({ EASY: 12, MEDIUM: 12, HARD: 12 }), 'x');
    expect(report.chapters).toBe(4);
  });

  it('fills a short band from the nearest band and says so', () => {
    const { items, report } = assembleQuick10(pool({ EASY: 8, MEDIUM: 8, HARD: 0 }), 'x');
    expect(items).toHaveLength(10);
    expect(report.delivered.HARD).toBe(0);
    expect(report.substitutions).toEqual([{ wanted: 'HARD', got: 'MEDIUM', count: 2 }]);
  });

  it('refuses when fewer than 10 usable questions exist', () => {
    expect(() => assembleQuick10(pool({ EASY: 4, MEDIUM: 3, HARD: 2 }), 'x')).toThrow(InsufficientBankError);
  });

  it('ignores duplicate questions and duplicate wording when counting', () => {
    const p = pool({ EASY: 5, MEDIUM: 3, HARD: 2 });
    const dup = [...p, { ...p[0], revisionId: 'dupe' }, { ...p[1], questionId: 'other', revisionId: 'dupe2' }];
    expect(assembleQuick10(dup, 'x').items.map((i) => i.revisionId)).not.toContain('dupe');
    expect(() => assembleQuick10(p.slice(0, 9).concat({ ...p[0], revisionId: 'dupe' }), 'x')).toThrow(InsufficientBankError);
  });

  it('gives every item a permutation of the four options', () => {
    for (const i of assembleQuick10(pool({ EASY: 8, MEDIUM: 8, HARD: 8 }), 'x').items) {
      expect([...i.optionOrder].sort()).toEqual([1, 2, 3, 4]);
    }
  });

  it('shuffles the correct position (not always the same slot)', () => {
    const slots = new Set<number>();
    for (let s = 0; s < 40; s++) {
      for (const i of assembleQuick10(pool({ EASY: 8, MEDIUM: 8, HARD: 8 }), `s${s}`).items) slots.add(i.optionOrder.indexOf(1));
    }
    expect(slots.size).toBe(4);
  });
});

describe('makeRng', () => {
  it('is deterministic and in [0,1)', () => {
    const a = makeRng('k');
    const b = makeRng('k');
    for (let i = 0; i < 20; i++) {
      const v = a();
      expect(v).toBe(b());
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('nextStep', () => {
  const mk = (states: Array<[ItemProgress['state'], number?]>): ItemProgress[] =>
    states.map(([state, skipCount], i) => ({ position: i + 1, state, skipCount: skipCount ?? (state === 'SKIPPED' ? 1 : 0) }));

  it('starts at question 1', () => {
    expect(nextStep(mk([[null], [null], [null]]), false)).toEqual({ kind: 'ITEM', position: 1, pass: 'MAIN' });
  });
  it('moves to the first question with no response', () => {
    expect(nextStep(mk([['LOCKED'], ['SKIPPED'], [null]]), false)).toEqual({ kind: 'ITEM', position: 3, pass: 'MAIN' });
  });
  it('shows the summary after the main pass, offering a revisit when something was skipped', () => {
    expect(nextStep(mk([['LOCKED'], ['SKIPPED'], ['LOCKED']]), false)).toEqual({ kind: 'SUMMARY', answered: 2, unanswered: 1, canReviewSkipped: true });
  });
  it('offers no revisit when nothing was skipped', () => {
    expect(nextStep(mk([['LOCKED'], ['LOCKED']]), false)).toEqual({ kind: 'SUMMARY', answered: 2, unanswered: 0, canReviewSkipped: false });
  });
  it('revisits skipped questions once, in order', () => {
    const items = mk([['SKIPPED'], ['LOCKED'], ['SKIPPED']]);
    expect(nextStep(items, true)).toEqual({ kind: 'ITEM', position: 1, pass: 'REVISIT' });
    items[0] = { position: 1, state: 'SKIPPED', skipCount: 2 };
    expect(nextStep(items, true)).toEqual({ kind: 'ITEM', position: 3, pass: 'REVISIT' });
    items[2] = { position: 3, state: 'LOCKED', skipCount: 1 };
    expect(nextStep(items, true)).toEqual({ kind: 'SUMMARY', answered: 2, unanswered: 1, canReviewSkipped: false });
  });
  it('never returns to a locked answer', () => {
    expect(nextStep(mk([['LOCKED'], ['LOCKED']]), true).kind).toBe('SUMMARY');
  });
});

describe('scoreAssessment', () => {
  it('counts correct locked answers; skipped and unanswered score zero', () => {
    const s = scoreAssessment([
      { difficulty: 'EASY', locked: true, isCorrect: true },
      { difficulty: 'EASY', locked: true, isCorrect: false },
      { difficulty: 'MEDIUM', locked: false, isCorrect: null },
      { difficulty: 'HARD', locked: true, isCorrect: true },
    ]);
    expect(s).toEqual({
      total: 4,
      correct: 2,
      unanswered: 1,
      byDifficulty: { EASY: { total: 2, correct: 1 }, MEDIUM: { total: 1, correct: 0 }, HARD: { total: 1, correct: 1 } },
    });
  });
});

describe('small helpers', () => {
  it('clamps active time', () => {
    expect(clampActiveMs(1234.9)).toBe(1234);
    expect(clampActiveMs(-5)).toBe(0);
    expect(clampActiveMs('9')).toBe(0);
    expect(clampActiveMs(Infinity)).toBe(0);
    expect(clampActiveMs(99_999_999)).toBe(15 * 60 * 1000);
  });
  it('maps slots to stored positions and rejects bad slots', () => {
    expect(slotToPosition([3, 1, 4, 2], 0)).toBe(3);
    expect(slotToPosition([3, 1, 4, 2], 3)).toBe(2);
    expect(slotToPosition([3, 1, 4, 2], 4)).toBeNull();
    expect(slotToPosition([3, 1, 4, 2], -1)).toBeNull();
    expect(slotToPosition([3, 1, 4, 2], 1.5)).toBeNull();
  });
  it('reveals after lock only in practice', () => {
    expect(revealsAfterLock('PRACTICE')).toBe(true);
    expect(revealsAfterLock('TEST')).toBe(false);
  });
});

describe('loadExamConfig', () => {
  it('defaults to strict, 24 hours', () => {
    expect(loadExamConfig({})).toEqual({ allowUnactivatedCurriculum: false, resumeHours: 24 });
  });
  it('allows the dev switch outside production', () => {
    expect(loadExamConfig({ EXAM_ALLOW_UNACTIVATED_CURRICULUM: 'true', NODE_ENV: 'development' }).allowUnactivatedCurriculum).toBe(true);
  });
  it('refuses the dev switch in production', () => {
    expect(() => loadExamConfig({ EXAM_ALLOW_UNACTIVATED_CURRICULUM: 'true', NODE_ENV: 'production' })).toThrow(/production/);
  });
  it('refuses unclear values', () => {
    expect(() => loadExamConfig({ EXAM_ALLOW_UNACTIVATED_CURRICULUM: 'yes' })).toThrow();
    expect(() => loadExamConfig({ EXAM_RESUME_HOURS: '0' })).toThrow();
    expect(() => loadExamConfig({ EXAM_RESUME_HOURS: 'abc' })).toThrow();
  });
});
