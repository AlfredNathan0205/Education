import { OPTION_POSITIONS } from '../question/question-domain';
import { makeRng, shuffle } from './seeded-random';

/**
 * Blueprint-driven assembly (spec: ASSESSMENT_ENGINE, "Blueprint != Instance"). Pure: no database, no clock,
 * and no randomness except a seeded generator used only as the last tie-break and for presentation order,
 * so the same pool, design and seed always give the same test.
 *
 * Order of work:
 *   1. remove duplicates (same question, or same normalised wording) and wrong question types; keep to the
 *      chapter scope (a loose scope widens only when its chapters hold too few questions), or to the objective
 *      scope of a practice or retest set (a loose one widens a step at a time: micro-concept, topic, chapter, subject);
 *   2. meet each cell minimum ("at least N questions matching ..."), scarcest cell first;
 *   3. fill the difficulty mix, scarcest band first;
 *   4. fill any short band from the nearest band;
 *   5. order the questions (seeded) and put the opening difficulty first.
 * Within each step candidates are ranked by: in scope, not seen before, bank health (WATCH last), a chapter not
 * yet used, an objective not yet used, a cognitive level not yet used, least recently seen, then the seeded tie-break.
 * Anything that could not be met exactly is listed in `relaxations`; nothing is relaxed silently.
 */

export const ASSEMBLY_ENGINE_VERSION = 'assembly-v1';

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];
export type Cognitive = 'C1' | 'C2' | 'C3' | 'C4';
export const COGNITIVE_LEVELS: Cognitive[] = ['C1', 'C2', 'C3', 'C4'];
export type QuestionType = 'MCQ';
export const QUESTION_TYPES: QuestionType[] = ['MCQ'];
export type ServedHealth = 'NEW' | 'HEALTHY' | 'WATCH';
export type ScopeMode = 'WHOLE_SUBJECT' | 'CHAPTERS' | 'STUDENT_FOCUS' | 'OBJECTIVES';
/** How far a loose objective scope had to widen, nearest first. */
export const WIDEN_LEVELS = ['OBJECTIVE', 'MICRO_CONCEPT', 'TOPIC', 'CHAPTER', 'SUBJECT'] as const;
export type WidenLevel = (typeof WIDEN_LEVELS)[number];

export interface Candidate {
  revisionId: string;
  questionId: string;
  objectivePath: string; // "chapter/topic/concept/objective"
  difficulty: Difficulty;
  stemHash: string;
  /** When this student last saw the question, or null if never (always null in a preview). */
  lastSeenAt: Date | null;
  /** Null on questions written before tagging existed. */
  cognitive?: Cognitive | null;
  questionType?: QuestionType;
  /** Stored bank health; DEGRADED never reaches assembly. Null = no row yet (treated as NEW). */
  health?: ServedHealth | null;
}

export interface CellRequirement {
  chapterCode: string | null;
  difficulty: Difficulty | null;
  cognitive: Cognitive | null;
  minCount: number;
}

export interface AssemblyDesign {
  code: string;
  version: number;
  total: number;
  difficulty: Record<Difficulty, number>;
  types: Array<{ type: QuestionType; count: number }>;
  cells: CellRequirement[];
  preferUnseen: boolean;
  openingDifficulty: Difficulty | null;
}

/**
 * The chapters in scope for this assembly, already resolved by the caller (blueprint chapters, or the student's
 * own focus). `chapters: null` means the whole subject.
 */
export interface AssemblyScope {
  mode: ScopeMode;
  chapters: string[] | null;
  strict: boolean;
  /** OBJECTIVES scope only: the learning objective paths a practice or retest set is aimed at. */
  objectives?: string[] | null;
}

export const WHOLE_SUBJECT: AssemblyScope = { mode: 'WHOLE_SUBJECT', chapters: null, strict: false };

export type Relaxation =
  | { kind: 'DIFFICULTY_SUBSTITUTED'; wanted: Difficulty; got: Difficulty; count: number }
  | { kind: 'CELL_MINIMUM_UNMET'; cell: number; wanted: number; got: number }
  | { kind: 'SCOPE_WIDENED'; reason: 'NO_FOCUS_CHAPTERS' | 'TOO_FEW_IN_SCOPE'; outOfScope: number; to?: WidenLevel }
  | { kind: 'SEEN_QUESTIONS_USED'; count: number }
  | { kind: 'HEALTH_WATCH_USED'; count: number };

export type DecisionRequirement = 'CELL' | 'DIFFICULTY' | 'SUBSTITUTE';

export interface AssemblyDecision {
  position: number;
  revisionId: string;
  questionId: string;
  requirement: DecisionRequirement;
  cellPosition: number | null;
  wantedDifficulty: Difficulty;
  difficulty: Difficulty;
  reasons: string[];
  candidates: number;
}

export interface AssembledItem extends Candidate {
  position: number;
  /** Displayed slot i shows the stored option at position optionOrder[i] (one of OPTION_POSITIONS, 0..3). */
  optionOrder: number[];
}

export interface AssemblyReport {
  blueprint: string;
  version: number;
  engine: string;
  requested: Record<Difficulty, number>;
  delivered: Record<Difficulty, number>;
  /** Kept for older readers: the DIFFICULTY_SUBSTITUTED relaxations as before. */
  substitutions: Array<{ wanted: Difficulty; got: Difficulty; count: number }>;
  relaxations: Relaxation[];
  unseen: number;
  chapters: number;
  objectives: number;
  cognitive: Record<Cognitive | 'UNTAGGED', number>;
  scope: { mode: ScopeMode; strict: boolean; chapters: string[] | null; objectives?: string[] | null };
  pool: { offered: number; duplicates: number; wrongType: number; outOfScope: number; eligible: number };
}

export interface AssemblyResult {
  items: AssembledItem[];
  decisions: AssemblyDecision[];
  report: AssemblyReport;
}

export class InsufficientBankError extends Error {
  constructor(
    readonly available: number,
    readonly needed: number,
  ) {
    super(`Not enough approved questions yet (${available} available, ${needed} needed)`);
    this.name = 'InsufficientBankError';
  }
}

/** A strict student-focus test when the student has chosen no chapters, or an objective scope with no objectives. */
export class EmptyScopeError extends Error {
  constructor() {
    super('No chapters are chosen for this subject');
    this.name = 'EmptyScopeError';
  }
}

export const chapterOf = (path: string) => path.split('/')[0] ?? path;

/**
 * How far a question's objective is from the nearest target objective: 0 the objective itself, 1 the same
 * micro-concept, 2 the same topic, 3 the same chapter, 4 elsewhere in the subject. Paths are chapter/topic/concept/objective.
 */
export function objectiveDistance(path: string, targets: readonly string[]): number {
  const p = path.split('/');
  let best = 4;
  for (const t of targets) {
    const q = t.split('/');
    let common = 0;
    while (common < 4 && common < p.length && common < q.length && p[common] === q[common]) common++;
    best = Math.min(best, 4 - common);
    if (best === 0) break;
  }
  return best;
}
const bandDistance = (a: Difficulty, b: Difficulty) => Math.abs(DIFFICULTIES.indexOf(a) - DIFFICULTIES.indexOf(b));
const typeOf = (c: Candidate): QuestionType => c.questionType ?? 'MCQ';

export function matchesCell(c: Candidate, cell: CellRequirement): boolean {
  return (
    (cell.chapterCode === null || chapterOf(c.objectivePath) === cell.chapterCode) &&
    (cell.difficulty === null || c.difficulty === cell.difficulty) &&
    (cell.cognitive === null || (c.cognitive ?? null) === cell.cognitive)
  );
}

export function assemble(pool: Candidate[], design: AssemblyDesign, seed: string, scope: AssemblyScope = WHOLE_SUBJECT): AssemblyResult {
  // 1. Eligibility.
  const seenQuestions = new Set<string>();
  const seenStems = new Set<string>();
  const typeAllowed = new Set(design.types.filter((t) => t.count > 0).map((t) => t.type));
  const relaxations: Relaxation[] = [];
  let duplicates = 0;
  let wrongType = 0;
  let outOfScopeRemoved = 0;

  // tierOf ranks closeness to the scope (0 = inside). Chapter scopes have two tiers; an objective scope has five.
  let tierOf: (c: Candidate) => number = () => 0;
  const inScope = (c: Candidate) => tierOf(c) === 0;
  let widenReason: 'NO_FOCUS_CHAPTERS' | 'TOO_FEW_IN_SCOPE' | null = null;
  let widenedTo: WidenLevel | null = null;
  const objectiveTargets = scope.mode === 'OBJECTIVES' ? (scope.objectives ?? []) : null;
  if (objectiveTargets !== null) {
    if (objectiveTargets.length === 0) throw new EmptyScopeError();
    tierOf = (c) => objectiveDistance(c.objectivePath, objectiveTargets);
  } else if (scope.chapters !== null) {
    if (scope.chapters.length === 0) {
      if (scope.strict) throw new EmptyScopeError();
      widenReason = 'NO_FOCUS_CHAPTERS';
    } else {
      const set = new Set(scope.chapters);
      tierOf = (c) => (set.has(chapterOf(c.objectivePath)) ? 0 : 1);
    }
  }

  const unique: Candidate[] = [];
  for (const p of pool) {
    if (seenQuestions.has(p.questionId) || seenStems.has(p.stemHash)) {
      duplicates++;
      continue;
    }
    seenQuestions.add(p.questionId);
    seenStems.add(p.stemHash);
    if (!typeAllowed.has(typeOf(p))) {
      wrongType++;
      continue;
    }
    unique.push(p);
  }
  // A strict scope never leaves its chapters. A loose one stays inside them while they hold enough questions
  // (a difficulty is substituted first), and widens only when they do not.
  if (objectiveTargets !== null) {
    // The nearest ring that holds enough questions; a strict scope never leaves the objectives themselves.
    let limit = 0;
    if (!scope.strict) while (limit < 4 && unique.filter((c) => tierOf(c) <= limit).length < design.total) limit++;
    const keep = unique.filter((c) => tierOf(c) <= limit);
    outOfScopeRemoved = unique.length - keep.length;
    unique.splice(0, unique.length, ...keep);
    if (limit > 0) {
      widenReason = 'TOO_FEW_IN_SCOPE';
      widenedTo = WIDEN_LEVELS[limit];
    }
  } else if (scope.chapters !== null && scope.chapters.length > 0) {
    const inside = unique.filter(inScope);
    if (scope.strict || inside.length >= design.total) {
      outOfScopeRemoved = unique.length - inside.length;
      unique.splice(0, unique.length, ...inside);
    } else widenReason = 'TOO_FEW_IN_SCOPE';
  }
  if (unique.length < design.total) throw new InsufficientBankError(unique.length, design.total);

  // Ranking state.
  const rng = makeRng(seed);
  const remaining = [...unique];
  const chapters = new Set<string>();
  const objectives = new Set<string>();
  const cognitives = new Set<string>();
  const diffLeft = { ...design.difficulty } as Record<Difficulty, number>;
  const typeLeft = new Map(design.types.map((t) => [t.type, t.count]));
  const picked: Array<{ item: Candidate; decision: Omit<AssemblyDecision, 'position'> }> = [];

  const keyOf = (c: Candidate): number[] => [
    tierOf(c),
    design.preferUnseen && c.lastSeenAt !== null ? 1 : 0,
    c.health === 'WATCH' ? 1 : 0,
    chapters.has(chapterOf(c.objectivePath)) ? 1 : 0,
    objectives.has(c.objectivePath) ? 1 : 0,
    cognitives.has(c.cognitive ?? 'UNTAGGED') ? 1 : 0,
    design.preferUnseen && c.lastSeenAt !== null ? c.lastSeenAt.getTime() : 0,
  ];

  const pick = (candidates: Candidate[]): { item: Candidate; reasons: string[] } => {
    let best: Candidate | null = null;
    let bestKey: number[] = [];
    let bestTie = 0;
    let tied = false;
    for (const c of candidates) {
      const key = keyOf(c);
      const tie = rng();
      const cmp = best === null ? -1 : compareKeys(key, bestKey);
      if (cmp < 0 || (cmp === 0 && tie < bestTie)) {
        tied = cmp === 0;
        best = c;
        bestKey = key;
        bestTie = tie;
      } else if (cmp === 0) tied = true;
    }
    const item = best as Candidate;
    const reasons: string[] = [];
    reasons.push(inScope(item) ? 'IN_SCOPE' : 'OUT_OF_SCOPE');
    reasons.push(item.lastSeenAt === null ? 'UNSEEN' : 'SEEN_BEFORE');
    if (item.health === 'WATCH') reasons.push('HEALTH_WATCH');
    if (!chapters.has(chapterOf(item.objectivePath))) reasons.push('NEW_CHAPTER');
    if (!objectives.has(item.objectivePath)) reasons.push('NEW_OBJECTIVE');
    if (!cognitives.has(item.cognitive ?? 'UNTAGGED')) reasons.push(item.cognitive ? 'NEW_COGNITIVE' : 'UNTAGGED_COGNITIVE');
    if (tied) reasons.push('TIE_BREAK_RANDOM');
    return { item, reasons };
  };

  const take = (item: Candidate, decision: Omit<AssemblyDecision, 'position' | 'revisionId' | 'questionId' | 'difficulty'>) => {
    remaining.splice(remaining.indexOf(item), 1);
    chapters.add(chapterOf(item.objectivePath));
    objectives.add(item.objectivePath);
    cognitives.add(item.cognitive ?? 'UNTAGGED');
    diffLeft[item.difficulty]--;
    typeLeft.set(typeOf(item), (typeLeft.get(typeOf(item)) ?? 0) - 1);
    picked.push({ item, decision: { ...decision, revisionId: item.revisionId, questionId: item.questionId, difficulty: item.difficulty } });
  };
  const typeOk = (c: Candidate) => (typeLeft.get(typeOf(c)) ?? 0) > 0;

  // 2. Cell minimums, scarcest first. A cell only takes a question whose difficulty still has room, so the mix holds.
  const cellOrder = design.cells
    .map((cell, i) => ({ cell, i, supply: unique.filter((c) => matchesCell(c, cell)).length }))
    .sort((a, b) => a.supply / a.cell.minCount - b.supply / b.cell.minCount || a.i - b.i);
  for (const { cell, i } of cellOrder) {
    // Questions already chosen for an earlier cell count towards this one.
    let have = picked.filter((p) => matchesCell(p.item, cell)).length;
    while (have < cell.minCount) {
      const candidates = remaining.filter((c) => matchesCell(c, cell) && diffLeft[c.difficulty] > 0 && typeOk(c));
      if (candidates.length === 0) break;
      const { item, reasons } = pick(candidates);
      take(item, { requirement: 'CELL', cellPosition: i + 1, wantedDifficulty: item.difficulty, reasons, candidates: candidates.length });
      have++;
    }
    if (have < cell.minCount) relaxations.push({ kind: 'CELL_MINIMUM_UNMET', cell: i + 1, wanted: cell.minCount, got: have });
  }

  // 3. Difficulty mix, scarcest band first so a short band is not starved by the others.
  const available = (d: Difficulty) => unique.filter((p) => p.difficulty === d).length;
  const ratio = (d: Difficulty) => (design.difficulty[d] === 0 ? Infinity : available(d) / design.difficulty[d]);
  const order = [...DIFFICULTIES].sort((a, b) => ratio(a) - ratio(b));
  const deficits: Array<{ band: Difficulty; count: number }> = [];
  for (const band of order) {
    while (diffLeft[band] > 0) {
      const candidates = remaining.filter((p) => p.difficulty === band && typeOk(p));
      if (candidates.length === 0) break;
      const { item, reasons } = pick(candidates);
      take(item, { requirement: 'DIFFICULTY', cellPosition: null, wantedDifficulty: band, reasons, candidates: candidates.length });
    }
    if (diffLeft[band] > 0) deficits.push({ band, count: diffLeft[band] });
  }

  // 4. Fill short bands from the nearest band.
  for (const { band, count } of deficits) {
    for (let k = 0; k < count; k++) {
      const pool2 = remaining.filter(typeOk);
      if (pool2.length === 0) throw new InsufficientBankError(picked.length, design.total);
      const nearest = Math.min(...pool2.map((p) => bandDistance(p.difficulty, band)));
      const candidates = pool2.filter((p) => bandDistance(p.difficulty, band) === nearest);
      const { item, reasons } = pick(candidates);
      // The band it came from gives up a slot it would not otherwise have used (its own quota is already met).
      diffLeft[band]--;
      diffLeft[item.difficulty]++;
      take(item, { requirement: 'SUBSTITUTE', cellPosition: null, wantedDifficulty: band, reasons, candidates: candidates.length });
      const hit = relaxations.find((r) => r.kind === 'DIFFICULTY_SUBSTITUTED' && r.wanted === band && r.got === item.difficulty) as
        | Extract<Relaxation, { kind: 'DIFFICULTY_SUBSTITUTED' }>
        | undefined;
      if (hit) hit.count++;
      else relaxations.push({ kind: 'DIFFICULTY_SUBSTITUTED', wanted: band, got: item.difficulty, count: 1 });
    }
  }

  const chosen = picked.map((p) => p.item);
  const outOfScope = chosen.filter((c) => !inScope(c)).length;
  if (widenReason !== null && (outOfScope > 0 || widenReason === 'NO_FOCUS_CHAPTERS')) {
    relaxations.push({ kind: 'SCOPE_WIDENED', reason: widenReason, outOfScope, ...(widenedTo ? { to: widenedTo } : {}) });
  }
  const seen = chosen.filter((c) => c.lastSeenAt !== null).length;
  if (design.preferUnseen && seen > 0) relaxations.push({ kind: 'SEEN_QUESTIONS_USED', count: seen });
  const watch = chosen.filter((c) => c.health === 'WATCH').length;
  if (watch > 0) relaxations.push({ kind: 'HEALTH_WATCH_USED', count: watch });

  // 5. Presentation order: seeded shuffle, opening with the requested difficulty when there is one.
  const shuffled = shuffle(picked, rng);
  if (design.openingDifficulty) {
    const first = shuffled.findIndex((p) => p.item.difficulty === design.openingDifficulty);
    if (first > 0) [shuffled[0], shuffled[first]] = [shuffled[first], shuffled[0]];
  }

  const items: AssembledItem[] = shuffled.map((p, i) => ({ ...p.item, position: i + 1, optionOrder: shuffle([...OPTION_POSITIONS], rng) }));
  const decisions: AssemblyDecision[] = shuffled.map((p, i) => ({ ...(p.decision as AssemblyDecision), position: i + 1 }));

  const delivered = { EASY: 0, MEDIUM: 0, HARD: 0 } as Record<Difficulty, number>;
  const cognitive = { C1: 0, C2: 0, C3: 0, C4: 0, UNTAGGED: 0 } as AssemblyReport['cognitive'];
  for (const i of items) {
    delivered[i.difficulty]++;
    cognitive[i.cognitive ?? 'UNTAGGED']++;
  }
  return {
    items,
    decisions,
    report: {
      blueprint: design.code,
      version: design.version,
      engine: ASSEMBLY_ENGINE_VERSION,
      requested: { ...design.difficulty },
      delivered,
      substitutions: relaxations
        .filter((r): r is Extract<Relaxation, { kind: 'DIFFICULTY_SUBSTITUTED' }> => r.kind === 'DIFFICULTY_SUBSTITUTED')
        .map(({ wanted, got, count }) => ({ wanted, got, count })),
      relaxations,
      unseen: items.filter((i) => i.lastSeenAt === null).length,
      chapters: chapters.size,
      objectives: objectives.size,
      cognitive,
      scope: { mode: scope.mode, strict: scope.strict, chapters: scope.chapters, ...(objectiveTargets ? { objectives: [...objectiveTargets] } : {}) },
      pool: { offered: pool.length, duplicates, wrongType, outOfScope: outOfScopeRemoved, eligible: unique.length },
    },
  };
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}
