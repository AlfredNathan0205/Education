import { createHash } from 'node:crypto';

/**
 * Pure rules for assembling and running an assessment (spec: ASSESSMENT_ENGINE). No database, no clock,
 * no randomness except a seeded generator, so every rule here is testable and an assembly is reproducible.
 */

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];
export type AssessmentMode = 'TEST' | 'PRACTICE';

/**
 * Quick 10. The spec's mix is D1=2, D2=3, D3=3, D4=1, D5=1 across five levels; the question bank has three
 * bands, so D1+D2 -> EASY (5), D3 -> MEDIUM (3), D4+D5 -> HARD (2). Revisit when the bank gets five levels.
 */
export const QUICK10 = {
  code: 'QUICK10',
  version: 1,
  total: 10,
  mix: { EASY: 5, MEDIUM: 3, HARD: 2 } as Record<Difficulty, number>,
  scoringPolicy: 'QUICK10_V1',
} as const;

export const OPTION_COUNT = 4;
export const MAX_ACTIVE_MS = 15 * 60 * 1000;

// ── seeded randomness ──────────────────────────────────────────────────────

/** mulberry32 seeded from SHA-256 of the seed string. */
export function makeRng(seed: string): () => number {
  let a = createHash('sha256').update(seed).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const a = [...items];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── assembly ───────────────────────────────────────────────────────────────

export interface PoolItem {
  revisionId: string;
  questionId: string;
  objectivePath: string; // "chapter/topic/concept/objective"
  difficulty: Difficulty;
  stemHash: string;
  /** When this student last saw the question, or null if never. */
  lastSeenAt: Date | null;
}

export interface AssembledItem extends PoolItem {
  position: number;
  /** Displayed slot i shows the stored option at position optionOrder[i] (1..4). */
  optionOrder: number[];
}

export interface AssemblyReport {
  blueprint: string;
  version: number;
  requested: Record<Difficulty, number>;
  delivered: Record<Difficulty, number>;
  /** Places where a band was short and a neighbouring band filled in. */
  substitutions: Array<{ wanted: Difficulty; got: Difficulty; count: number }>;
  unseen: number;
  chapters: number;
  objectives: number;
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

const chapterOf = (path: string) => path.split('/')[0] ?? path;
const bandDistance = (a: Difficulty, b: Difficulty) => Math.abs(DIFFICULTIES.indexOf(a) - DIFFICULTIES.indexOf(b));

/**
 * Blueprint-driven, never random-first: fill the difficulty mix, prefer questions the student has not
 * seen, spread across chapters then objectives, and use the seeded generator only as the last tie-break.
 */
export function assembleQuick10(pool: PoolItem[], seed: string): { items: AssembledItem[]; report: AssemblyReport } {
  const seenQuestions = new Set<string>();
  const seenStems = new Set<string>();
  const unique: PoolItem[] = [];
  for (const p of pool) {
    if (seenQuestions.has(p.questionId) || seenStems.has(p.stemHash)) continue;
    seenQuestions.add(p.questionId);
    seenStems.add(p.stemHash);
    unique.push(p);
  }
  if (unique.length < QUICK10.total) throw new InsufficientBankError(unique.length, QUICK10.total);

  const rng = makeRng(seed);
  const remaining = [...unique];
  const chosen: PoolItem[] = [];
  const chapters = new Set<string>();
  const objectives = new Set<string>();

  const pick = (candidates: PoolItem[]): PoolItem => {
    let best: PoolItem | null = null;
    let bestKey: number[] = [];
    for (const c of candidates) {
      const key = [
        c.lastSeenAt === null ? 0 : 1,
        chapters.has(chapterOf(c.objectivePath)) ? 1 : 0,
        objectives.has(c.objectivePath) ? 1 : 0,
        c.lastSeenAt === null ? 0 : c.lastSeenAt.getTime(),
        rng(),
      ];
      if (best === null || compareKeys(key, bestKey) < 0) {
        best = c;
        bestKey = key;
      }
    }
    return best as PoolItem;
  };
  const take = (item: PoolItem) => {
    remaining.splice(remaining.indexOf(item), 1);
    chosen.push(item);
    chapters.add(chapterOf(item.objectivePath));
    objectives.add(item.objectivePath);
  };

  // Scarcest band first, so a short band is not starved by the others.
  const available = (d: Difficulty) => unique.filter((p) => p.difficulty === d).length;
  const order = [...DIFFICULTIES].sort((a, b) => available(a) / QUICK10.mix[a] - available(b) / QUICK10.mix[b]);
  const deficits: Array<{ band: Difficulty; count: number }> = [];
  for (const band of order) {
    let need = QUICK10.mix[band];
    while (need > 0) {
      const candidates = remaining.filter((p) => p.difficulty === band);
      if (candidates.length === 0) break;
      take(pick(candidates));
      need--;
    }
    if (need > 0) deficits.push({ band, count: need });
  }

  const substitutions: AssemblyReport['substitutions'] = [];
  for (const { band, count } of deficits) {
    for (let i = 0; i < count; i++) {
      const nearest = Math.min(...remaining.map((p) => bandDistance(p.difficulty, band)));
      const candidates = remaining.filter((p) => bandDistance(p.difficulty, band) === nearest);
      const got = pick(candidates);
      take(got);
      const hit = substitutions.find((s) => s.wanted === band && s.got === got.difficulty);
      if (hit) hit.count++;
      else substitutions.push({ wanted: band, got: got.difficulty, count: 1 });
    }
  }

  // Order: shuffled, but open with the easiest available question.
  const shuffled = shuffle(chosen, rng);
  const firstEasy = shuffled.findIndex((p) => p.difficulty === 'EASY');
  if (firstEasy > 0) [shuffled[0], shuffled[firstEasy]] = [shuffled[firstEasy], shuffled[0]];

  const items: AssembledItem[] = shuffled.map((p, i) => ({
    ...p,
    position: i + 1,
    optionOrder: shuffle([1, 2, 3, 4], rng),
  }));

  const delivered = { EASY: 0, MEDIUM: 0, HARD: 0 } as Record<Difficulty, number>;
  for (const i of items) delivered[i.difficulty]++;
  return {
    items,
    report: {
      blueprint: QUICK10.code,
      version: QUICK10.version,
      requested: { ...QUICK10.mix },
      delivered,
      substitutions,
      unseen: items.filter((i) => i.lastSeenAt === null).length,
      chapters: chapters.size,
      objectives: objectives.size,
    },
  };
}

function compareKeys(a: number[], b: number[]): number {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// ── running the assessment ────────────────────────────────────────────────

export interface ItemProgress {
  position: number;
  state: 'SKIPPED' | 'LOCKED' | null;
  skipCount: number;
}

export type NextStep =
  | { kind: 'ITEM'; position: number; pass: 'MAIN' | 'REVISIT' }
  | { kind: 'SUMMARY'; answered: number; unanswered: number; canReviewSkipped: boolean };

/**
 * One question at a time, in order. Skipped questions are revisited once, at the end. There is no going
 * back to a locked answer. Derived entirely from what was stored, so a resumed session lands correctly.
 */
export function nextStep(items: ItemProgress[], revisitUsed: boolean): NextStep {
  const sorted = [...items].sort((a, b) => a.position - b.position);
  if (!revisitUsed) {
    const fresh = sorted.find((i) => i.state === null);
    if (fresh) return { kind: 'ITEM', position: fresh.position, pass: 'MAIN' };
  } else {
    const pending = sorted.find((i) => i.state === 'SKIPPED' && i.skipCount === 1);
    if (pending) return { kind: 'ITEM', position: pending.position, pass: 'REVISIT' };
  }
  const answered = sorted.filter((i) => i.state === 'LOCKED').length;
  const unanswered = sorted.length - answered;
  return { kind: 'SUMMARY', answered, unanswered, canReviewSkipped: !revisitUsed && unanswered > 0 };
}

export function clampActiveMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(Math.floor(value), MAX_ACTIVE_MS);
}

// ── scoring ────────────────────────────────────────────────────────────────

export interface ScoredItem {
  difficulty: Difficulty;
  locked: boolean;
  isCorrect: boolean | null;
}

export interface ScoreSummary {
  total: number;
  correct: number;
  unanswered: number;
  byDifficulty: Record<Difficulty, { total: number; correct: number }>;
}

/** Deterministic: one mark per correct locked answer; skipped and unanswered score zero. No LLM involved. */
export function scoreAssessment(items: ScoredItem[]): ScoreSummary {
  const byDifficulty = {
    EASY: { total: 0, correct: 0 },
    MEDIUM: { total: 0, correct: 0 },
    HARD: { total: 0, correct: 0 },
  } as ScoreSummary['byDifficulty'];
  let correct = 0;
  let unanswered = 0;
  for (const i of items) {
    byDifficulty[i.difficulty].total++;
    if (!i.locked) unanswered++;
    else if (i.isCorrect === true) {
      correct++;
      byDifficulty[i.difficulty].correct++;
    }
  }
  return { total: items.length, correct, unanswered, byDifficulty };
}

/** Map a displayed slot (0..3) to the stored option position (1..4) for this item. */
export function slotToPosition(optionOrder: number[], slot: number): number | null {
  if (!Number.isInteger(slot) || slot < 0 || slot >= optionOrder.length) return null;
  return optionOrder[slot];
}

/** What the student may be told when they lock an answer. TEST reveals nothing; PRACTICE reveals that item only. */
export function revealsAfterLock(mode: AssessmentMode): boolean {
  return mode === 'PRACTICE';
}

export function newSeed(): string {
  return createHash('sha256').update(`${Date.now()}:${Math.random()}:${process.pid}`).digest('hex').slice(0, 32);
}

// ── configuration ──────────────────────────────────────────────────────────

export interface ExamConfig {
  /** Dev only: serve approved questions from a curriculum that is not ACTIVE. Refused in production. */
  allowUnactivatedCurriculum: boolean;
  resumeHours: number;
}

export function loadExamConfig(env: Record<string, string | undefined> = process.env): ExamConfig {
  const raw = env.EXAM_ALLOW_UNACTIVATED_CURRICULUM?.trim().toLowerCase();
  if (raw !== undefined && raw !== '' && raw !== 'true' && raw !== 'false') {
    throw new Error('EXAM_ALLOW_UNACTIVATED_CURRICULUM must be "true" or "false"');
  }
  const allow = raw === 'true';
  if (allow && env.NODE_ENV === 'production') {
    throw new Error('EXAM_ALLOW_UNACTIVATED_CURRICULUM is not permitted when NODE_ENV=production');
  }
  const hoursRaw = env.EXAM_RESUME_HOURS?.trim();
  const hours = hoursRaw ? Number(hoursRaw) : 24;
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    throw new Error('EXAM_RESUME_HOURS must be a number from 1 to 168');
  }
  return { allowUnactivatedCurriculum: allow, resumeHours: hours };
}

export const EXAM_CONFIG = Symbol('EXAM_CONFIG');
