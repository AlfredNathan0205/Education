/**
 * Step 21: content readiness (spec DECISION_10 10O: "strict EQC/diversity/QC/LO gates; unavailable if not ready").
 * Pure: the service loads what students would actually be served (the same pool as test assembly) and this decides.
 *
 * Where numbers come from the spec (INVARIANTS_AND_POLICIES "Coverage/diversity baseline") they say so; every other
 * number is PROVISIONAL and is for the academic lead to confirm or change (a new policy version, then sign-off).
 */
import type { ReleasedTier, Tier } from './release-domain';

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export const DIFFICULTIES: Difficulty[] = ['EASY', 'MEDIUM', 'HARD'];
export type ObjectiveState = 'NOT_READY' | 'LIMITED' | 'ASSESSMENT_READY' | 'ROBUST';
export const OBJECTIVE_STATES: ObjectiveState[] = ['NOT_READY', 'LIMITED', 'ASSESSMENT_READY', 'ROBUST'];
export const RELEASED: ReleasedTier[] = ['INTERNAL', 'CONTROLLED', 'GENERAL'];

export interface TierRequirement {
  /** Share of objectives at LIMITED or better (1 = no objective NOT_READY). */
  objectivesLimitedShare: number;
  /** Share of objectives at ASSESSMENT_READY or better. */
  objectivesReadyShare: number;
  /** Share of objectives that are ROBUST. */
  objectivesRobustShare: number;
  /** Servable distinct questions in every chapter. */
  chapterMin: number;
  /** In every chapter, at least this many of each difficulty. */
  chapterMinPerDifficulty: number;
  /** In every chapter, at least this many cognitive levels (C1..C4). */
  chapterMinCognitive: number;
  /** Quarantined plus DEGRADED, as a share of approved plus quarantined, at most. */
  maxQualityIssueShare: number;
  /** Every whole-subject test design: each difficulty's supply at least this many times its count in the design. */
  designDepth: number;
}

export interface ReadinessPolicy {
  code: string;
  /** Distinct servable questions an objective needs for each state (an upper bound on EQC: see eqcNote). */
  objective: { limited: number; assessmentReady: number; robust: number };
  tiers: Record<ReleasedTier, TierRequirement>;
}

/**
 * READINESS_V1 (PROVISIONAL, 16 October 2026). The objective thresholds follow the spec's tier C minimum (5), tier B
 * minimum (8) and tier B target (12), with every objective treated as tier B until objectives carry a tier. GENERAL's
 * chapter minimum of 120 is the spec's launch minimum per chapter; the spec's quality target is major+critical < 1%.
 * Everything else (INTERNAL and CONTROLLED numbers, shares, depths) is a provisional proposal.
 */
export const READINESS_V1: ReadinessPolicy = {
  code: 'READINESS_V1',
  objective: { limited: 5, assessmentReady: 8, robust: 12 },
  tiers: {
    INTERNAL: { objectivesLimitedShare: 0.5, objectivesReadyShare: 0, objectivesRobustShare: 0, chapterMin: 10, chapterMinPerDifficulty: 1, chapterMinCognitive: 1, maxQualityIssueShare: 0.05, designDepth: 2 },
    CONTROLLED: { objectivesLimitedShare: 1, objectivesReadyShare: 0.8, objectivesRobustShare: 0, chapterMin: 60, chapterMinPerDifficulty: 5, chapterMinCognitive: 2, maxQualityIssueShare: 0.02, designDepth: 5 },
    GENERAL: { objectivesLimitedShare: 1, objectivesReadyShare: 1, objectivesRobustShare: 0.5, chapterMin: 120, chapterMinPerDifficulty: 15, chapterMinCognitive: 3, maxQualityIssueShare: 0.01, designDepth: 10 },
  },
};

/** A policy from stored JSON (or a file an operator publishes): every number present and sensible, tiers non-decreasing. */
export function parsePolicy(code: string, raw: unknown): ReadinessPolicy {
  const fail = (m: string): never => {
    throw new Error(`Readiness policy ${code}: ${m}`);
  };
  if (!/^[A-Z][A-Z0-9_]{2,31}$/.test(code)) fail('the code must be 3 to 32 capitals, digits or underscores');
  const o = raw as any;
  if (!o || typeof o !== 'object') fail('not an object');
  const int = (v: unknown, what: string, min = 0, max = 100_000) => (Number.isInteger(v) && (v as number) >= min && (v as number) <= max ? (v as number) : fail(`${what} must be a whole number from ${min} to ${max}`));
  const share = (v: unknown, what: string) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : fail(`${what} must be from 0 to 1`));
  const objective = {
    limited: int(o.objective?.limited, 'objective.limited', 1),
    assessmentReady: int(o.objective?.assessmentReady, 'objective.assessmentReady', 1),
    robust: int(o.objective?.robust, 'objective.robust', 1),
  };
  if (!(objective.limited <= objective.assessmentReady && objective.assessmentReady <= objective.robust)) fail('objective thresholds must not decrease (limited ≤ assessmentReady ≤ robust)');
  const tiers = {} as Record<ReleasedTier, TierRequirement>;
  for (const t of RELEASED) {
    const r = o.tiers?.[t];
    if (!r) fail(`tiers.${t} is missing`);
    tiers[t] = {
      objectivesLimitedShare: share(r.objectivesLimitedShare, `${t}.objectivesLimitedShare`),
      objectivesReadyShare: share(r.objectivesReadyShare, `${t}.objectivesReadyShare`),
      objectivesRobustShare: share(r.objectivesRobustShare, `${t}.objectivesRobustShare`),
      chapterMin: int(r.chapterMin, `${t}.chapterMin`),
      chapterMinPerDifficulty: int(r.chapterMinPerDifficulty, `${t}.chapterMinPerDifficulty`),
      chapterMinCognitive: int(r.chapterMinCognitive, `${t}.chapterMinCognitive`, 0, 4),
      maxQualityIssueShare: share(r.maxQualityIssueShare, `${t}.maxQualityIssueShare`),
      designDepth: int(r.designDepth, `${t}.designDepth`, 1, 100),
    };
  }
  // A wider audience never asks for less.
  for (let i = 1; i < RELEASED.length; i++) {
    const lo = tiers[RELEASED[i - 1]];
    const hi = tiers[RELEASED[i]];
    for (const k of Object.keys(lo) as Array<keyof TierRequirement>) {
      const stricter = k === 'maxQualityIssueShare' ? hi[k] <= lo[k] : hi[k] >= lo[k];
      if (!stricter) fail(`${RELEASED[i]}.${k} is less strict than ${RELEASED[i - 1]}.${k}`);
    }
  }
  return { code, objective, tiers };
}

export interface ReadinessInput {
  curriculumState: string;
  chapters: Array<{ code: string; title: string; objectives: string[] }>;
  /** What students would be served (assembly's pool). */
  items: Array<{ questionId: string; objectivePath: string; difficulty: Difficulty; cognitive: string | null; stemHash: string }>;
  /** Questions approved but not yet published: not served, shown so the gap is visible. */
  awaitingPublication: number;
  quality: { approved: number; quarantined: number; degraded: number };
  /** Switched-on, published whole-subject or chapter designs for this subject (practice and retest are per objective). */
  designs: Array<{ code: string; name: string; total: number; difficulty: Record<Difficulty, number> }>;
}

export interface Check {
  code: string;
  ok: boolean;
  message: string;
}

export interface ReadinessResult {
  policy: string;
  eqcNote: string;
  totals: { servable: number; distinct: number; awaitingPublication: number; objectives: number; chapters: number };
  objectiveStates: Record<ObjectiveState, number>;
  /** Worst first. */
  objectives: Array<{ path: string; chapter: string; eqc: number; state: ObjectiveState }>;
  chapters: Array<{ code: string; title: string; servable: number; difficulty: Record<Difficulty, number>; cognitive: number; objectives: number; notReady: number }>;
  quality: { approved: number; quarantined: number; degraded: number; issueShare: number };
  designs: Array<{ code: string; name: string; need: Record<Difficulty, number>; have: Record<Difficulty, number> }>;
  tiers: Record<ReleasedTier, { pass: boolean; checks: Check[] }>;
  /** The highest tier whose checks, and every lower tier's, all pass. */
  highest: Tier;
}

const pct = (x: number) => `${Math.round(x * 1000) / 10}%`;

export function objectiveState(eqc: number, p: ReadinessPolicy): ObjectiveState {
  if (eqc >= p.objective.robust) return 'ROBUST';
  if (eqc >= p.objective.assessmentReady) return 'ASSESSMENT_READY';
  if (eqc >= p.objective.limited) return 'LIMITED';
  return 'NOT_READY';
}

/** Evaluates a subject against every released tier. */
export function evaluateReadiness(input: ReadinessInput, policy: ReadinessPolicy): ReadinessResult {
  // EQC: exact duplicates (the same normalised stem) count 0 (spec "exact0"). Variant levels are not recorded yet, so
  // every other question counts 1: an upper bound.
  const seenStem = new Set<string>();
  const distinct = input.items.filter((i) => (seenStem.has(i.stemHash) ? false : (seenStem.add(i.stemHash), true)));

  const byObjective = new Map<string, typeof distinct>();
  for (const i of distinct) byObjective.set(i.objectivePath, [...(byObjective.get(i.objectivePath) ?? []), i]);

  const objectives = input.chapters
    .flatMap((c) => c.objectives.map((path) => ({ path, chapter: c.code, eqc: byObjective.get(path)?.length ?? 0 })))
    .map((o) => ({ ...o, state: objectiveState(o.eqc, policy) }))
    .sort((a, b) => a.eqc - b.eqc || a.path.localeCompare(b.path));
  const objectiveStates = Object.fromEntries(OBJECTIVE_STATES.map((s) => [s, objectives.filter((o) => o.state === s).length])) as Record<ObjectiveState, number>;

  const chapters = input.chapters.map((c) => {
    const own = distinct.filter((i) => i.objectivePath.split('/')[0] === c.code);
    const difficulty = Object.fromEntries(DIFFICULTIES.map((d) => [d, own.filter((i) => i.difficulty === d).length])) as Record<Difficulty, number>;
    return {
      code: c.code,
      title: c.title,
      servable: own.length,
      difficulty,
      cognitive: new Set(own.map((i) => i.cognitive).filter((x): x is string => !!x)).size,
      objectives: c.objectives.length,
      notReady: objectives.filter((o) => o.chapter === c.code && o.state === 'NOT_READY').length,
    };
  });

  const q = input.quality;
  const issueShare = q.approved + q.quarantined > 0 ? (q.quarantined + q.degraded) / (q.approved + q.quarantined) : 0;
  const supply = Object.fromEntries(DIFFICULTIES.map((d) => [d, distinct.filter((i) => i.difficulty === d).length])) as Record<Difficulty, number>;
  const designs = input.designs.map((d) => ({ code: d.code, name: d.name, need: d.difficulty, have: supply }));

  const n = objectives.length;
  const share = (states: ObjectiveState[]) => (n === 0 ? 0 : objectives.filter((o) => states.includes(o.state)).length / n);
  const limitedShare = share(['LIMITED', 'ASSESSMENT_READY', 'ROBUST']);
  const readyShare = share(['ASSESSMENT_READY', 'ROBUST']);
  const robustShare = share(['ROBUST']);

  const tiers = {} as ReadinessResult['tiers'];
  for (const t of RELEASED) {
    const r = policy.tiers[t];
    const checks: Check[] = [];
    const add = (code: string, ok: boolean, message: string) => checks.push({ code, ok, message });
    add('CURRICULUM_ACTIVE', input.curriculumState === 'ACTIVE', input.curriculumState === 'ACTIVE' ? 'The curriculum is active.' : `The curriculum is ${input.curriculumState}, not ACTIVE.`);
    add('HAS_OBJECTIVES', n > 0, n > 0 ? `${n} objectives in ${chapters.length} chapters.` : 'The curriculum has no objectives.');
    add('OBJECTIVES_LIMITED', n > 0 && limitedShare >= r.objectivesLimitedShare, `${pct(limitedShare)} of objectives have at least ${policy.objective.limited} questions (needs ${pct(r.objectivesLimitedShare)}).`);
    if (r.objectivesReadyShare > 0) add('OBJECTIVES_READY', readyShare >= r.objectivesReadyShare, `${pct(readyShare)} of objectives have at least ${policy.objective.assessmentReady} questions (needs ${pct(r.objectivesReadyShare)}).`);
    if (r.objectivesRobustShare > 0) add('OBJECTIVES_ROBUST', robustShare >= r.objectivesRobustShare, `${pct(robustShare)} of objectives have at least ${policy.objective.robust} questions (needs ${pct(r.objectivesRobustShare)}).`);
    const small = chapters.filter((c) => c.servable < r.chapterMin);
    add('CHAPTER_SIZE', chapters.length > 0 && small.length === 0, small.length ? `${small.length} of ${chapters.length} chapters have fewer than ${r.chapterMin} questions: ${small.map((c) => `${c.code} (${c.servable})`).join(', ')}.` : `Every chapter has at least ${r.chapterMin} questions.`);
    const thin = chapters.filter((c) => DIFFICULTIES.some((d) => c.difficulty[d] < r.chapterMinPerDifficulty));
    add('CHAPTER_DIFFICULTY', chapters.length > 0 && thin.length === 0, thin.length ? `${thin.length} chapters have fewer than ${r.chapterMinPerDifficulty} of some difficulty: ${thin.map((c) => `${c.code} (${DIFFICULTIES.filter((d) => c.difficulty[d] < r.chapterMinPerDifficulty).join('/')})`).join(', ')}.` : `Every chapter has at least ${r.chapterMinPerDifficulty} easy, medium and hard questions.`);
    if (r.chapterMinCognitive > 0) {
      const narrow = chapters.filter((c) => c.cognitive < r.chapterMinCognitive);
      add('CHAPTER_COGNITIVE', chapters.length > 0 && narrow.length === 0, narrow.length ? `${narrow.length} chapters test fewer than ${r.chapterMinCognitive} cognitive levels: ${narrow.map((c) => `${c.code} (${c.cognitive})`).join(', ')}.` : `Every chapter tests at least ${r.chapterMinCognitive} cognitive levels.`);
    }
    add('QUALITY', issueShare <= r.maxQualityIssueShare, `${pct(issueShare)} of approved questions are quarantined or degraded (at most ${pct(r.maxQualityIssueShare)}).`);
    for (const d of designs) {
      const short = DIFFICULTIES.filter((x) => d.have[x] < d.need[x] * r.designDepth);
      add(`DESIGN_${d.code}`, short.length === 0, short.length ? `${d.name}: needs ${r.designDepth}× its mix; short of ${short.map((x) => `${x.toLowerCase()} (${d.have[x]} of ${d.need[x] * r.designDepth})`).join(', ')}.` : `${d.name} can be built ${r.designDepth} times over.`);
    }
    tiers[t] = { pass: checks.every((c) => c.ok), checks };
  }
  let highest: Tier = 'FOUNDATION_ONLY';
  for (const t of RELEASED) {
    if (!tiers[t].pass) break;
    highest = t;
  }
  return {
    policy: policy.code,
    eqcNote: 'Effective question count here is the number of distinct questions (exact duplicates count 0). Variant levels (surface, parameter, scenario, reasoning) are not recorded yet, so this is an upper bound on the spec\'s EQC.',
    totals: { servable: input.items.length, distinct: distinct.length, awaitingPublication: input.awaitingPublication, objectives: n, chapters: chapters.length },
    objectiveStates,
    objectives,
    chapters,
    quality: { ...q, issueShare: Math.round(issueShare * 10_000) / 10_000 },
    designs,
    tiers,
    highest,
  };
}
