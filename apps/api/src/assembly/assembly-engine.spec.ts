import {
  EmptyScopeError,
  InsufficientBankError,
  assemble,
  objectiveDistance,
  type AssemblyDesign,
  type Candidate,
  type Cognitive,
  type Difficulty,
} from './assembly-engine';

let n = 0;
function q(over: Partial<Candidate> & { difficulty: Difficulty }): Candidate {
  n++;
  return {
    revisionId: `r${n}`,
    questionId: `q${n}`,
    objectivePath: `C${(n % 4) + 1}/T1/M1/O${n}`,
    stemHash: `h${n}`,
    lastSeenAt: null,
    cognitive: null,
    questionType: 'MCQ',
    health: 'HEALTHY',
    ...over,
  };
}
function many(count: number, over: Partial<Candidate> & { difficulty: Difficulty }): Candidate[] {
  return Array.from({ length: count }, () => q(over));
}
function bank(e: number, m: number, h: number): Candidate[] {
  return [...many(e, { difficulty: 'EASY' }), ...many(m, { difficulty: 'MEDIUM' }), ...many(h, { difficulty: 'HARD' })];
}
function design(over: Partial<AssemblyDesign> = {}): AssemblyDesign {
  const total = over.total ?? 10;
  return {
    code: 'T',
    version: 1,
    total,
    difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 },
    types: [{ type: 'MCQ', count: total }],
    cells: [],
    preferUnseen: true,
    openingDifficulty: 'EASY',
    ...over,
  };
}
const ids = (r: ReturnType<typeof assemble>) => r.items.map((i) => i.revisionId);

describe('assemble: the design', () => {
  it('delivers a 20-question mix from the blueprint', () => {
    const r = assemble(bank(15, 15, 15), design({ total: 20, difficulty: { EASY: 8, MEDIUM: 7, HARD: 5 } }), 's');
    expect(r.items).toHaveLength(20);
    expect(r.report.delivered).toEqual({ EASY: 8, MEDIUM: 7, HARD: 5 });
    expect(r.report.relaxations).toEqual([]);
    expect(r.items.map((i) => i.position)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('records one decision per question, at the same position', () => {
    const r = assemble(bank(10, 10, 10), design(), 's');
    expect(r.decisions).toHaveLength(10);
    r.decisions.forEach((d, i) => {
      expect(d.position).toBe(i + 1);
      expect(d.revisionId).toBe(r.items[i].revisionId);
      expect(d.requirement).toBe('DIFFICULTY');
      expect(d.reasons).toEqual(expect.arrayContaining(['IN_SCOPE', 'UNSEEN']));
      expect(d.candidates).toBeGreaterThan(0);
    });
  });

  it('is reproducible for the same pool, design and seed', () => {
    const p = bank(10, 10, 10);
    expect(ids(assemble(p, design(), 'seed'))).toEqual(ids(assemble(p, design(), 'seed')));
    expect(assemble(p, design(), 'seed').decisions).toEqual(assemble(p, design(), 'seed').decisions);
  });

  it('can open with another difficulty, or with none forced', () => {
    for (const s of ['a', 'b', 'c', 'd']) expect(assemble(bank(10, 10, 10), design({ openingDifficulty: 'HARD' }), s).items[0].difficulty).toBe('HARD');
    expect(() => assemble(bank(10, 10, 10), design({ openingDifficulty: null }), 'a')).not.toThrow();
  });

  it('meets a type requirement and leaves out other types', () => {
    const p = bank(10, 10, 10).map((c, i) => (i % 2 ? c : { ...c, questionType: 'OTHER' as never }));
    const r = assemble(p, design(), 's');
    expect(r.items.every((i) => i.questionType === 'MCQ')).toBe(true);
    expect(r.report.pool.wrongType).toBe(15);
  });

  it('refuses when there are fewer usable questions than the design needs', () => {
    expect(() => assemble(bank(5, 5, 5), design({ total: 20, difficulty: { EASY: 8, MEDIUM: 7, HARD: 5 } }), 's')).toThrow(InsufficientBankError);
  });
});

describe('assemble: cells', () => {
  it('meets a cell minimum inside the difficulty mix', () => {
    const p = [...bank(10, 10, 10), ...many(3, { difficulty: 'MEDIUM', objectivePath: 'C9/T1/M1/O1', cognitive: 'C3' })];
    const r = assemble(p, design({ cells: [{ chapterCode: 'C9', difficulty: null, cognitive: null, minCount: 2 }] }), 's');
    expect(r.items.filter((i) => i.objectivePath.startsWith('C9/')).length).toBeGreaterThanOrEqual(2);
    expect(r.report.delivered).toEqual({ EASY: 5, MEDIUM: 3, HARD: 2 });
    const cellPicks = r.decisions.filter((d) => d.requirement === 'CELL');
    expect(cellPicks).toHaveLength(2);
    expect(cellPicks.every((d) => d.cellPosition === 1)).toBe(true);
  });

  it('says so when a cell cannot be met', () => {
    const p = [...bank(10, 10, 10), q({ difficulty: 'HARD', cognitive: 'C4' })];
    const r = assemble(p, design({ cells: [{ chapterCode: null, difficulty: null, cognitive: 'C4', minCount: 3 }] }), 's');
    expect(r.report.relaxations).toContainEqual({ kind: 'CELL_MINIMUM_UNMET', cell: 1, wanted: 3, got: 1 });
    expect(r.items).toHaveLength(10);
  });

  it('does not break the mix to fill a cell', () => {
    // Plenty of C2 questions, but all of them EASY; the cell asks for 7, the mix has 5 EASY.
    const p = [...many(10, { difficulty: 'EASY', cognitive: 'C2' }), ...bank(0, 10, 10)];
    const r = assemble(p, design({ cells: [{ chapterCode: null, difficulty: null, cognitive: 'C2', minCount: 7 }] }), 's');
    expect(r.report.delivered).toEqual({ EASY: 5, MEDIUM: 3, HARD: 2 });
    expect(r.report.relaxations).toContainEqual({ kind: 'CELL_MINIMUM_UNMET', cell: 1, wanted: 7, got: 5 });
  });
});

describe('assemble: preferences', () => {
  it('prefers unseen, and reports seen questions it had to use', () => {
    const seen = many(10, { difficulty: 'EASY', lastSeenAt: new Date(2026, 0, 1) });
    const r = assemble([...seen, ...bank(2, 3, 2)], design(), 's');
    expect(r.items.filter((i) => i.lastSeenAt !== null)).toHaveLength(3);
    expect(r.report.relaxations).toContainEqual({ kind: 'SEEN_QUESTIONS_USED', count: 3 });
  });

  it('ignores exposure when the design does not prefer unseen', () => {
    const r = assemble(many(12, { difficulty: 'EASY', lastSeenAt: new Date() }), design({ difficulty: { EASY: 10, MEDIUM: 0, HARD: 0 }, preferUnseen: false }), 's');
    expect(r.report.relaxations.find((x) => x.kind === 'SEEN_QUESTIONS_USED')).toBeUndefined();
  });

  it('uses a WATCH question only when nothing healthier fits', () => {
    const watch = many(5, { difficulty: 'EASY', health: 'WATCH' });
    const r = assemble([...watch, ...bank(5, 3, 2)], design(), 's');
    expect(r.items.some((i) => i.health === 'WATCH')).toBe(false);
    const short = assemble([...watch, ...bank(3, 3, 2)], design(), 's');
    expect(short.items.filter((i) => i.health === 'WATCH')).toHaveLength(2);
    expect(short.report.relaxations).toContainEqual({ kind: 'HEALTH_WATCH_USED', count: 2 });
    expect(short.decisions.filter((d) => d.reasons.includes('HEALTH_WATCH'))).toHaveLength(2);
  });

  it('prefers unseen WATCH over a seen healthy question (exposure ranks above health)', () => {
    const p = [q({ difficulty: 'EASY', health: 'WATCH' }), q({ difficulty: 'EASY', lastSeenAt: new Date() })];
    const r = assemble(p, design({ total: 1, difficulty: { EASY: 1, MEDIUM: 0, HARD: 0 } }), 's');
    expect(r.items[0].health).toBe('WATCH');
  });

  it('spreads across cognitive levels when everything else is equal', () => {
    const levels: Array<Cognitive | null> = ['C1', 'C2', 'C3', 'C4', null];
    const p = Array.from({ length: 25 }, (_, i) => q({ difficulty: 'EASY', objectivePath: `C1/T1/M1/O1`, cognitive: levels[i % 5] }));
    const r = assemble(p, design({ total: 5, difficulty: { EASY: 5, MEDIUM: 0, HARD: 0 } }), 's');
    expect(r.report.cognitive).toEqual({ C1: 1, C2: 1, C3: 1, C4: 1, UNTAGGED: 1 });
  });

  it('marks a pick decided by the seeded tie-break', () => {
    const p = Array.from({ length: 4 }, () => q({ difficulty: 'EASY', objectivePath: 'C1/T1/M1/O1' }));
    const r = assemble(p, design({ total: 1, difficulty: { EASY: 1, MEDIUM: 0, HARD: 0 } }), 's');
    expect(r.decisions[0].reasons).toContain('TIE_BREAK_RANDOM');
  });
});

describe('assemble: scope', () => {
  const p = () => [
    ...many(6, { difficulty: 'EASY', objectivePath: 'A/T/M/O1' }),
    ...many(6, { difficulty: 'MEDIUM', objectivePath: 'A/T/M/O2' }),
    ...many(6, { difficulty: 'HARD', objectivePath: 'B/T/M/O3' }),
  ];

  it('keeps a strict chapter scope and refuses when it is too small', () => {
    const r = assemble(p(), design({ total: 8, difficulty: { EASY: 5, MEDIUM: 3, HARD: 0 } }), 's', { mode: 'CHAPTERS', chapters: ['A'], strict: true });
    expect(r.items.every((i) => i.objectivePath.startsWith('A/'))).toBe(true);
    expect(r.report.pool.outOfScope).toBe(6);
    expect(() => assemble(p(), design({ total: 14, difficulty: { EASY: 6, MEDIUM: 6, HARD: 2 } }), 's', { mode: 'CHAPTERS', chapters: ['A'], strict: true })).toThrow(InsufficientBankError);
  });

  it('a loose scope substitutes a difficulty before leaving its chapters', () => {
    const r = assemble(p(), design(), 's', { mode: 'STUDENT_FOCUS', chapters: ['A'], strict: false });
    expect(r.items.every((i) => i.objectivePath.startsWith('A/'))).toBe(true);
    expect(r.report.relaxations).toContainEqual({ kind: 'DIFFICULTY_SUBSTITUTED', wanted: 'HARD', got: 'MEDIUM', count: 2 });
    expect(r.report.relaxations.find((x) => x.kind === 'SCOPE_WIDENED')).toBeUndefined();
  });

  it('widens a loose scope when its chapters hold too few questions, and says so', () => {
    const pool = [
      ...many(4, { difficulty: 'EASY', objectivePath: 'A/T/M/O1' }),
      ...many(4, { difficulty: 'MEDIUM', objectivePath: 'A/T/M/O2' }),
      ...many(6, { difficulty: 'EASY', objectivePath: 'B/T/M/O3' }),
      ...many(6, { difficulty: 'HARD', objectivePath: 'B/T/M/O4' }),
    ];
    const r = assemble(pool, design(), 's', { mode: 'STUDENT_FOCUS', chapters: ['A'], strict: false });
    // EASY: the 4 in A first, then 1 from B; MEDIUM: 3 from A; HARD: 2 from B.
    expect(r.items.filter((i) => i.objectivePath.startsWith('B/'))).toHaveLength(3);
    expect(r.report.relaxations).toContainEqual({ kind: 'SCOPE_WIDENED', reason: 'TOO_FEW_IN_SCOPE', outOfScope: 3 });
    expect(r.decisions.filter((d) => d.reasons.includes('OUT_OF_SCOPE'))).toHaveLength(3);
  });

  it('a student with no focus chapters gets the whole subject (loose) or nothing (strict)', () => {
    const r = assemble(p(), design(), 's', { mode: 'STUDENT_FOCUS', chapters: [], strict: false });
    expect(r.items).toHaveLength(10);
    expect(r.report.relaxations).toContainEqual({ kind: 'SCOPE_WIDENED', reason: 'NO_FOCUS_CHAPTERS', outOfScope: 0 });
    expect(() => assemble(p(), design(), 's', { mode: 'STUDENT_FOCUS', chapters: [], strict: true })).toThrow(EmptyScopeError);
  });
});

describe('assemble: objective scope (practice and retest)', () => {
  const obj = (o: string) => ({ mode: 'OBJECTIVES' as const, chapters: null, strict: false, objectives: [o] });
  // Target A/T1/M1/O1 has 4 questions; the same micro-concept 4 more; the same topic 4; the same chapter 4; elsewhere 10.
  const ring = () => [
    ...many(2, { difficulty: 'EASY', objectivePath: 'A/T1/M1/O1' }),
    ...many(2, { difficulty: 'MEDIUM', objectivePath: 'A/T1/M1/O1' }),
    ...many(4, { difficulty: 'EASY', objectivePath: 'A/T1/M1/O2' }),
    ...many(4, { difficulty: 'MEDIUM', objectivePath: 'A/T1/M2/O3' }),
    ...many(4, { difficulty: 'HARD', objectivePath: 'A/T2/M3/O4' }),
    ...many(10, { difficulty: 'HARD', objectivePath: 'B/T1/M1/O5' }),
  ];

  it('measures distance from the nearest target objective', () => {
    const t = ['A/T1/M1/O1', 'B/T9/M9/O9'];
    expect(objectiveDistance('A/T1/M1/O1', t)).toBe(0);
    expect(objectiveDistance('A/T1/M1/O7', t)).toBe(1);
    expect(objectiveDistance('A/T1/M5/O7', t)).toBe(2);
    expect(objectiveDistance('A/T3/M5/O7', t)).toBe(3);
    expect(objectiveDistance('C/T1/M1/O1', t)).toBe(4);
    expect(objectiveDistance('B/T9/M2/O1', t)).toBe(2);
  });

  it('stays on the objectives when they hold enough questions', () => {
    const pool = [...many(5, { difficulty: 'EASY', objectivePath: 'A/T1/M1/O1' }), ...many(5, { difficulty: 'MEDIUM', objectivePath: 'A/T1/M1/O1' }), ...many(8, { difficulty: 'HARD', objectivePath: 'A/T1/M1/O2' })];
    const r = assemble(pool, design(), 's', obj('A/T1/M1/O1'));
    expect(r.items.every((i) => i.objectivePath === 'A/T1/M1/O1')).toBe(true);
    expect(r.report.relaxations.find((x) => x.kind === 'SCOPE_WIDENED')).toBeUndefined();
    expect(r.report.scope.objectives).toEqual(['A/T1/M1/O1']);
  });

  it('widens one ring at a time, nearest first, and says how far', () => {
    const r = assemble(ring(), design(), 's', obj('A/T1/M1/O1'));
    // 4 + 4 (same micro-concept) = 8 < 10, so the topic ring is used: 12 candidates, nothing from chapter B.
    expect(r.items.filter((i) => i.objectivePath === 'A/T1/M1/O1')).toHaveLength(4);
    expect(r.items.some((i) => i.objectivePath.startsWith('B/') || i.objectivePath.startsWith('A/T2'))).toBe(false);
    expect(r.report.relaxations).toContainEqual({ kind: 'SCOPE_WIDENED', reason: 'TOO_FEW_IN_SCOPE', outOfScope: 6, to: 'TOPIC' });
  });

  it('spreads a set over several target objectives', () => {
    const pool = [
      ...many(6, { difficulty: 'EASY', objectivePath: 'A/T1/M1/O1' }),
      ...many(6, { difficulty: 'MEDIUM', objectivePath: 'A/T1/M1/O2' }),
      ...many(6, { difficulty: 'HARD', objectivePath: 'B/T1/M1/O3' }),
    ];
    const r = assemble(pool, design(), 's', { mode: 'OBJECTIVES', chapters: null, strict: false, objectives: ['A/T1/M1/O1', 'A/T1/M1/O2', 'B/T1/M1/O3'] });
    expect(new Set(r.items.map((i) => i.objectivePath)).size).toBe(3);
  });

  it('a strict objective scope never widens; no objectives at all is refused', () => {
    expect(() => assemble(ring(), design(), 's', { ...obj('A/T1/M1/O1'), strict: true })).toThrow(InsufficientBankError);
    expect(() => assemble(ring(), design(), 's', { mode: 'OBJECTIVES', chapters: null, strict: false, objectives: [] })).toThrow(EmptyScopeError);
  });
});
