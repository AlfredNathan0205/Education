/**
 * Competitive points (CP), participation points (XP) and weekly leaderboards (Step 15). Pure: no database, no clock
 * beyond the `now` passed in.
 *
 * Spec (INVARIANTS_AND_POLICIES, COMPETITION_CHALLENGES):
 * - Score != Mastery != CP; CP != XP; CP != Rank. Practice earns XP only.
 * - Quick10 base max 100 CP, Chapter20 200, Subject25 250. The formula is versioned and accuracy-dominant, with
 *   difficulty, exposure and integrity, plus small improvement (and, later, challenge) components.
 * - Exact or near repeats cannot inflate CP as fresh evidence. Speed is not a general ranking factor.
 * - The CP ledger is immutable; corrections are compensating entries.
 * - Weekly leaderboard first. Ranking needs at least 2 qualified assessments and 20 eligible questions. Ties: average
 *   accuracy, fresh evidence, qualified difficulty, then the same rank.
 *
 * The exact weights are not in the spec: CP_V1 below is PROVISIONAL and lives in a versioned policy row.
 */

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';

export interface CompetitionPolicy {
  /** Maximum CP per competitive design. A design not listed (practice, retest, drafts) earns no CP. */
  base: Record<string, number>;
  difficultyWeight: Record<Difficulty, number>;
  /** Shares of the base: accuracy (on fresh questions) and improvement over the last comparable test. Sum <= 1. */
  accuracyShare: number;
  improvementShare: number;
  /** A test with fewer counted questions earns no CP. */
  minEligibleQuestions: number;
  ranking: { minQualified: number; minEligibleQuestions: number; boardSize: number };
  xp: { perAnswer: number; perFinish: number };
  /** Weeks start on Monday 00:00 at this offset from UTC (330 = India). */
  week: { utcOffsetMinutes: number };
}

export const CP_V1: CompetitionPolicy = {
  base: { QUICK10: 100, FOCUS10: 100, SUBJECT20: 200, SUBJECT25: 250 },
  difficultyWeight: { EASY: 1, MEDIUM: 1.25, HARD: 1.5 },
  accuracyShare: 0.9,
  improvementShare: 0.1,
  minEligibleQuestions: 5,
  ranking: { minQualified: 2, minEligibleQuestions: 20, boardSize: 10 },
  xp: { perAnswer: 1, perFinish: 5 },
  week: { utcOffsetMinutes: 330 },
};

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

export function parseCompetitionPolicy(raw: unknown): CompetitionPolicy {
  const p = raw as CompetitionPolicy;
  const need: Array<[string, unknown]> = [
    ['difficultyWeight.EASY', p?.difficultyWeight?.EASY],
    ['difficultyWeight.MEDIUM', p?.difficultyWeight?.MEDIUM],
    ['difficultyWeight.HARD', p?.difficultyWeight?.HARD],
    ['accuracyShare', p?.accuracyShare],
    ['improvementShare', p?.improvementShare],
    ['minEligibleQuestions', p?.minEligibleQuestions],
    ['ranking.minQualified', p?.ranking?.minQualified],
    ['ranking.minEligibleQuestions', p?.ranking?.minEligibleQuestions],
    ['ranking.boardSize', p?.ranking?.boardSize],
    ['xp.perAnswer', p?.xp?.perAnswer],
    ['xp.perFinish', p?.xp?.perFinish],
    ['week.utcOffsetMinutes', p?.week?.utcOffsetMinutes],
  ];
  const bad = need.filter(([, v]) => !num(v)).map(([k]) => k);
  if (!p?.base || typeof p.base !== 'object' || Object.values(p.base).some((v) => !num(v) || (v as number) <= 0)) bad.unshift('base');
  if (bad.length) throw new Error(`competition policy is missing or has bad values for: ${bad.join(', ')}`);
  if (p.accuracyShare < 0 || p.improvementShare < 0 || p.accuracyShare + p.improvementShare > 1) throw new Error('competition policy shares must be >= 0 and add up to at most 1');
  return p;
}

// ── qualification and CP for one test ──────────────────────────────────────

export interface ScoredItem {
  difficulty: Difficulty;
  /** Locked and correct. */
  correct: boolean;
  /** Left out of the score (technical failure, invalidated). */
  excluded: boolean;
  /** The student met this question before this test (an earlier test or practice): not fresh evidence. */
  seenBefore: boolean;
}

export type NotQualifiedReason =
  | 'NOT_A_TEST'
  | 'NOT_COMPETITIVE_DESIGN'
  | 'NOT_COMMITTED'
  | 'INVALIDATED'
  | 'TOO_FEW_QUESTIONS';

export interface TestFacts {
  mode: 'TEST' | 'PRACTICE';
  blueprint: string;
  /** The result says the attempt was committed (first answer locked) and still counts. */
  competitiveEligible: boolean;
  invalidated: boolean;
  items: ScoredItem[];
  /** Accuracy (correct / eligible) of the student's previous qualified test of the same design in this subject. */
  previousAccuracy: number | null;
}

export interface Qualification {
  qualified: boolean;
  reasons: NotQualifiedReason[];
  eligibleQuestions: number;
  freshQuestions: number;
  correct: number;
  /** correct / eligible, 0..1. */
  accuracy: number;
  /** Difficulty-weighted accuracy on fresh questions, 0..1. */
  weightedAccuracy: number;
  /** Average difficulty weight of the counted questions (for tie-breaks). */
  difficultyScore: number;
  cp: number;
  parts: { base: number; accuracy: number; improvement: number };
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

/**
 * CP for one finished test. Accuracy dominates: up to `accuracyShare` of the base for difficulty-weighted accuracy on
 * questions the student had not met before (repeats earn nothing and cost nothing), scaled by the share of fresh
 * questions; plus up to `improvementShare` of the base for beating their last comparable test. Unanswered is wrong
 * (integrity: skipping is not a way to protect accuracy). Rounded, never negative, never above the base.
 */
export function qualify(t: TestFacts, policy: CompetitionPolicy): Qualification {
  const counted = t.items.filter((i) => !i.excluded);
  const fresh = counted.filter((i) => !i.seenBefore);
  const w = (d: Difficulty) => policy.difficultyWeight[d];
  const correct = counted.filter((i) => i.correct).length;
  const accuracy = counted.length ? correct / counted.length : 0;
  const freshWeight = fresh.reduce((a, i) => a + w(i.difficulty), 0);
  const weightedAccuracy = freshWeight ? fresh.filter((i) => i.correct).reduce((a, i) => a + w(i.difficulty), 0) / freshWeight : 0;
  const difficultyScore = counted.length ? counted.reduce((a, i) => a + w(i.difficulty), 0) / counted.length : 0;

  const reasons: NotQualifiedReason[] = [];
  const base = policy.base[t.blueprint] ?? 0;
  if (t.mode !== 'TEST') reasons.push('NOT_A_TEST');
  if (!base) reasons.push('NOT_COMPETITIVE_DESIGN');
  if (t.invalidated) reasons.push('INVALIDATED');
  else if (t.mode === 'TEST' && !t.competitiveEligible) reasons.push('NOT_COMMITTED');
  if (counted.length < policy.minEligibleQuestions) reasons.push('TOO_FEW_QUESTIONS');

  const out = {
    eligibleQuestions: counted.length,
    freshQuestions: fresh.length,
    correct,
    accuracy: round3(accuracy),
    weightedAccuracy: round3(weightedAccuracy),
    difficultyScore: round3(difficultyScore),
  };
  if (reasons.length) return { qualified: false, reasons, ...out, cp: 0, parts: { base, accuracy: 0, improvement: 0 } };

  const freshShare = fresh.length / counted.length;
  const accPart = policy.accuracyShare * base * weightedAccuracy * freshShare;
  const impPart = t.previousAccuracy === null ? 0 : policy.improvementShare * base * Math.max(0, accuracy - t.previousAccuracy);
  const cp = Math.max(0, Math.min(base, Math.round(accPart + impPart)));
  return { qualified: true, reasons: [], ...out, cp, parts: { base, accuracy: round3(accPart), improvement: round3(impPart) } };
}

/**
 * The ledger entry that brings a test's CP to its new value: an AWARD the first time, then an ADJUSTMENT for any
 * change, or a REVERSAL when it no longer earns anything. Nothing when the total is already right.
 */
export function ledgerEntry(alreadyAwarded: number, nowEarns: number, firstTime: boolean): { kind: 'AWARD' | 'ADJUSTMENT' | 'REVERSAL'; amount: number } | null {
  const delta = nowEarns - alreadyAwarded;
  if (delta === 0) return null;
  if (firstTime && alreadyAwarded === 0 && delta > 0) return { kind: 'AWARD', amount: delta };
  if (nowEarns === 0) return { kind: 'REVERSAL', amount: delta };
  return { kind: 'ADJUSTMENT', amount: delta };
}

/** XP for taking part: every finished test or practice, whatever the score. Never reversed (the effort happened). */
export function xpFor(lockedAnswers: number, policy: CompetitionPolicy): number {
  return lockedAnswers > 0 ? lockedAnswers * policy.xp.perAnswer + policy.xp.perFinish : 0;
}

// ── weeks ───────────────────────────────────────────────────────────────────

/** The week containing `at`: Monday 00:00 to the next Monday 00:00, at the policy's offset, as UTC instants. */
export function weekOf(at: Date, policy: CompetitionPolicy): { start: Date; end: Date } {
  const off = policy.week.utcOffsetMinutes * 60_000;
  const local = new Date(at.getTime() + off);
  const day = (local.getUTCDay() + 6) % 7; // Monday = 0
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day);
  return { start: new Date(startLocal - off), end: new Date(startLocal - off + 7 * 86_400_000) };
}

// ── ranking ─────────────────────────────────────────────────────────────────

export interface Standing {
  studentId: string;
  cp: number;
  qualified: number;
  eligibleQuestions: number;
  /** Average accuracy over the period's qualified tests, 0..1. */
  accuracy: number;
  /** When the latest qualified test in the period was finished. */
  latestAt: Date;
  /** Average difficulty score of the period's qualified tests. */
  difficulty: number;
}

export interface Ranked extends Standing {
  rank: number;
}

export const isRankable = (s: Standing, policy: CompetitionPolicy) =>
  s.qualified >= policy.ranking.minQualified && s.eligibleQuestions >= policy.ranking.minEligibleQuestions;

/**
 * Standard competition ranking (1, 1, 3): CP, then average accuracy, then the fresher evidence, then the harder
 * tests. Students equal on all four share a rank. Speed plays no part. Only rankable students are ranked.
 */
export function rank(standings: Standing[], policy: CompetitionPolicy): Ranked[] {
  const cmp = (a: Standing, b: Standing) =>
    b.cp - a.cp || b.accuracy - a.accuracy || b.latestAt.getTime() - a.latestAt.getTime() || b.difficulty - a.difficulty;
  const sorted = standings.filter((s) => isRankable(s, policy)).sort((a, b) => cmp(a, b) || a.studentId.localeCompare(b.studentId));
  const out: Ranked[] = [];
  sorted.forEach((s, i) => {
    const prev = out[i - 1];
    out.push({ ...s, rank: prev && cmp(prev, s) === 0 ? prev.rank : i + 1 });
  });
  return out;
}

/** What a student still needs to be ranked this week. */
export function stillNeeded(s: Pick<Standing, 'qualified' | 'eligibleQuestions'>, policy: CompetitionPolicy): { tests: number; questions: number } {
  return {
    tests: Math.max(0, policy.ranking.minQualified - s.qualified),
    questions: Math.max(0, policy.ranking.minEligibleQuestions - s.eligibleQuestions),
  };
}

/** A safe public handle: no name, school or place. Ambiguous letters left out. */
export function publicHandle(random: () => number): string {
  const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 6; i++) s += ALPHABET[Math.floor(random() * ALPHABET.length)];
  return `Learner-${s}`;
}

/**
 * CP_V2 (Step 16): CP_V1 plus ranked challenges, which earn CP like a Quick 10 (both players answer the same ten
 * questions, unseen by either). No win bonus and no CP loss (spec). Seeded ACTIVE by the Step 16 migration, which
 * retires CP_V1.
 */
export const CP_V2: CompetitionPolicy = { ...CP_V1, base: { ...CP_V1.base, CHALLENGE10: 100 } };
