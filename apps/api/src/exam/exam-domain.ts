import { createHash } from 'node:crypto';
import {
  assemble,
  type AssembledItem,
  type AssemblyDesign,
  type AssemblyReport,
  type Candidate,
  type Difficulty,
} from '../assembly/assembly-engine';

/**
 * Pure rules for running an assessment (spec: ASSESSMENT_ENGINE). No database, no clock, no randomness except a
 * seeded generator, so every rule here is testable. Assembly itself lives in ../assembly (Step 10).
 */

export { DIFFICULTIES, InsufficientBankError } from '../assembly/assembly-engine';
export type { AssembledItem, AssemblyReport, Difficulty } from '../assembly/assembly-engine';
export { makeRng } from '../assembly/seeded-random';
export type AssessmentMode = 'TEST' | 'PRACTICE';

/**
 * Quick 10 as it was built in code before Step 10. The database now holds blueprints (QUICK10 v1 is seeded with these
 * same numbers); this constant stays as the reference design and for the pure tests. The spec's mix is D1=2, D2=3,
 * D3=3, D4=1, D5=1 across five levels; the bank has three, so D1+D2 -> EASY (5), D3 -> MEDIUM (3), D4+D5 -> HARD (2).
 */
export const QUICK10 = {
  code: 'QUICK10',
  version: 1,
  total: 10,
  mix: { EASY: 5, MEDIUM: 3, HARD: 2 } as Record<Difficulty, number>,
  scoringPolicy: 'QUICK10_V1',
} as const;

export const QUICK10_DESIGN: AssemblyDesign = {
  code: QUICK10.code,
  version: QUICK10.version,
  total: QUICK10.total,
  difficulty: { ...QUICK10.mix },
  types: [{ type: 'MCQ', count: QUICK10.total }],
  cells: [],
  preferUnseen: true,
  openingDifficulty: 'EASY',
};

/** Results of every blueprint are scored the same way today: one mark per correct locked answer. */
export function scoringPolicyFor(blueprintCode: string): string {
  return blueprintCode === QUICK10.code ? QUICK10.scoringPolicy : 'ONE_MARK_PER_CORRECT_V1';
}

export const OPTION_COUNT = 4;
export const MAX_ACTIVE_MS = 15 * 60 * 1000;

/** What the exam engine loads for assembly. */
export type PoolItem = Candidate;

/** The Quick 10 design applied to a pool, whole subject. Kept for the pure tests; the service assembles from the published blueprint. */
export function assembleQuick10(pool: PoolItem[], seed: string): { items: AssembledItem[]; report: AssemblyReport } {
  const { items, report } = assemble(pool, QUICK10_DESIGN, seed);
  return { items, report };
}

// ── running the assessment ────────────────────────────────────────────────

export interface ItemProgress {
  position: number;
  state: 'SKIPPED' | 'LOCKED' | null;
  skipCount: number;
  /** Excluded items (technical failure or invalidation) are never presented again and do not count. */
  excluded?: boolean;
}

export type NextStep =
  | { kind: 'ITEM'; position: number; pass: 'MAIN' | 'REVISIT' }
  | { kind: 'SUMMARY'; answered: number; unanswered: number; canReviewSkipped: boolean };

/**
 * One question at a time, in order. Skipped questions are revisited once, at the end. There is no going
 * back to a locked answer. Derived entirely from what was stored, so a resumed session lands correctly.
 */
export function nextStep(items: ItemProgress[], revisitUsed: boolean): NextStep {
  const sorted = [...items].filter((i) => !i.excluded).sort((a, b) => a.position - b.position);
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
  /** Technical failure or invalidation: left out of the score entirely, never counted as the learner's error. */
  excluded?: boolean;
}

export interface ScoreSummary {
  /** Items that count (excluded items are not in it). */
  total: number;
  correct: number;
  unanswered: number;
  excluded: number;
  byDifficulty: Record<Difficulty, { total: number; correct: number }>;
}

/** Every item excluded: the attempt cannot be scored and is invalidated rather than given 0/0. */
export function allExcluded(items: Array<{ excluded?: boolean }>): boolean {
  return items.length > 0 && items.every((i) => i.excluded === true);
}

/**
 * Deterministic: one mark per correct locked answer; skipped and unanswered score zero; excluded items are left out
 * (invariant 12: a technical or item failure never counts as learner error). No LLM involved.
 */
export function scoreAssessment(items: ScoredItem[]): ScoreSummary {
  const byDifficulty = {
    EASY: { total: 0, correct: 0 },
    MEDIUM: { total: 0, correct: 0 },
    HARD: { total: 0, correct: 0 },
  } as ScoreSummary['byDifficulty'];
  let correct = 0;
  let unanswered = 0;
  let excluded = 0;
  for (const i of items) {
    if (i.excluded) {
      excluded++;
      continue;
    }
    byDifficulty[i.difficulty].total++;
    if (!i.locked) unanswered++;
    else if (i.isCorrect === true) {
      correct++;
      byDifficulty[i.difficulty].correct++;
    }
  }
  return { total: items.length - excluded, correct, unanswered, excluded, byDifficulty };
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
