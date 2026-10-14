/**
 * Pure mastery rules (spec: MASTERY_DIAGNOSTICS, INVARIANTS "Mastery baseline" and "Claim baseline").
 *
 * - Primary unit = learning objective. Score != mastery; mastery != confidence; unknown != zero.
 * - Evidence weight = independence x context x item quality (scope attribution and exposure are 1 today: every
 *   question maps to exactly one objective and repeats are handled by independence), capped.
 * - Initial estimator: weighted Bayesian accumulator with a mild neutral prior. alpha += w*score, beta += w*(1-score),
 *   mastery = alpha / (alpha + beta).
 * - Confidence combines effective volume, diversity, sessions, item quality and recency. Recency lowers confidence, never
 *   mastery. The formula is provisional and lives in the versioned policy so it can be changed by an approved change.
 * - Claims are gated: below the gate the label is BUILDING_EVIDENCE, never a negative label. Practice alone cannot pass.
 * No database, no clock (the caller passes `now`).
 */

export type Difficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type Cognitive = 'C1' | 'C2' | 'C3' | 'C4';
export type Health = 'NEW' | 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'QUARANTINED';
export type Mode = 'TEST' | 'PRACTICE';
export type Label = 'NOT_STARTED' | 'BUILDING_EVIDENCE' | 'NEEDS_ATTENTION' | 'DEVELOPING' | 'SECURE' | 'STRONG';
export const LABELS: Label[] = ['NOT_STARTED', 'BUILDING_EVIDENCE', 'NEEDS_ATTENTION', 'DEVELOPING', 'SECURE', 'STRONG'];

export interface MasteryPolicy {
  prior: { alpha: number; beta: number };
  independence: { distinct: number; exactRepeat: number };
  /** A TEST with fewer questions than fullTestMinQuestions is a Quick test. */
  context: { fullTest: number; quickTest: number; practice: number; fullTestMinQuestions: number };
  quality: Record<Health, number>;
  weightCap: number;
  confidence: {
    volumeScale: number;
    diversityBase: number;
    diversityPerFamily: number;
    singleSessionFactor: number;
    recencyFullDays: number;
    recencyFloorDays: number;
    recencyFloor: number;
  };
  gates: {
    ordinary: { confidence: number; effective: number; families: number; sessions: number; controlled: number };
    strong: { mastery: number; confidence: number; effective: number; families: number; sessions: number };
    weak: { effective: number; families: number; sessions: number };
  };
  bands: { strong: number; secure: number; developing: number };
  rollup: { minReportableShare: number; minReportable: number };
}

/** Policy MASTERY_V1, seeded by the Step 13 migration with exactly these numbers. */
export const MASTERY_V1: MasteryPolicy = {
  prior: { alpha: 1, beta: 1 },
  independence: { distinct: 1, exactRepeat: 0.05 },
  context: { fullTest: 1, quickTest: 0.9, practice: 0.6, fullTestMinQuestions: 20 },
  quality: { HEALTHY: 1, NEW: 0.9, WATCH: 0.7, DEGRADED: 0.3, QUARANTINED: 0 },
  weightCap: 1,
  confidence: {
    volumeScale: 2.5,
    diversityBase: 0.6,
    diversityPerFamily: 0.2,
    singleSessionFactor: 0.85,
    recencyFullDays: 30,
    recencyFloorDays: 180,
    recencyFloor: 0.8,
  },
  gates: {
    ordinary: { confidence: 75, effective: 5, families: 2, sessions: 2, controlled: 1 },
    strong: { mastery: 85, confidence: 85, effective: 6, families: 3, sessions: 2 },
    weak: { effective: 6, families: 3, sessions: 2 },
  },
  bands: { strong: 85, secure: 70, developing: 55 },
  rollup: { minReportableShare: 0.6, minReportable: 2 },
};

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);

/** Refuses a stored policy that does not have every number this code needs (fail closed: no update with a bad policy). */
export function parsePolicy(raw: unknown): MasteryPolicy {
  const p = raw as MasteryPolicy;
  const need: Array<[string, unknown]> = [
    ['prior.alpha', p?.prior?.alpha],
    ['prior.beta', p?.prior?.beta],
    ['independence.distinct', p?.independence?.distinct],
    ['independence.exactRepeat', p?.independence?.exactRepeat],
    ['context.fullTest', p?.context?.fullTest],
    ['context.quickTest', p?.context?.quickTest],
    ['context.practice', p?.context?.practice],
    ['context.fullTestMinQuestions', p?.context?.fullTestMinQuestions],
    ['weightCap', p?.weightCap],
    ...(['HEALTHY', 'NEW', 'WATCH', 'DEGRADED', 'QUARANTINED'] as Health[]).map((h) => [`quality.${h}`, p?.quality?.[h]] as [string, unknown]),
    ...Object.keys(MASTERY_V1.confidence).map((k) => [`confidence.${k}`, (p?.confidence as any)?.[k]] as [string, unknown]),
    ...Object.keys(MASTERY_V1.gates.ordinary).map((k) => [`gates.ordinary.${k}`, (p?.gates?.ordinary as any)?.[k]] as [string, unknown]),
    ...Object.keys(MASTERY_V1.gates.strong).map((k) => [`gates.strong.${k}`, (p?.gates?.strong as any)?.[k]] as [string, unknown]),
    ...Object.keys(MASTERY_V1.gates.weak).map((k) => [`gates.weak.${k}`, (p?.gates?.weak as any)?.[k]] as [string, unknown]),
    ['bands.strong', p?.bands?.strong],
    ['bands.secure', p?.bands?.secure],
    ['bands.developing', p?.bands?.developing],
    ['rollup.minReportableShare', p?.rollup?.minReportableShare],
    ['rollup.minReportable', p?.rollup?.minReportable],
  ];
  const missing = need.filter(([, v]) => !num(v)).map(([k]) => k);
  if (missing.length) throw new Error(`mastery policy is missing or has bad values for: ${missing.join(', ')}`);
  if (p.prior.alpha <= 0 || p.prior.beta <= 0) throw new Error('mastery policy prior must be positive');
  return p;
}

// ── evidence weights ─────────────────────────────────────────────────────

export interface EvidenceFacts {
  mode: Mode;
  /** Questions in the test (decides Quick vs chapter/subject). */
  testSize: number;
  /** Bank health of the question when answered; null = never set (treated as NEW). */
  health: Health | null;
  /** The student already has valid evidence from this exact question. */
  repeat: boolean;
}

export interface Weights {
  independence: number;
  context: number;
  quality: number;
  weight: number;
}

export function weightsFor(f: EvidenceFacts, p: MasteryPolicy): Weights {
  const independence = f.repeat ? p.independence.exactRepeat : p.independence.distinct;
  const context = f.mode === 'PRACTICE' ? p.context.practice : f.testSize >= p.context.fullTestMinQuestions ? p.context.fullTest : p.context.quickTest;
  const quality = p.quality[f.health ?? 'NEW'];
  const weight = Math.min(p.weightCap, independence * context * quality);
  return { independence, context, quality, weight: round4(weight) };
}

// ── state ────────────────────────────────────────────────────────────────

export interface EvidenceRow {
  score: number;
  weight: number;
  wQuality: number;
  mode: Mode;
  questionId: string;
  sessionId: string;
  at: Date;
}

export interface ObjectiveState {
  alpha: number;
  beta: number;
  mastery: number;
  confidence: number;
  effectiveEvidence: number;
  evidenceCount: number;
  families: number;
  sessions: number;
  controlledEvidence: number;
  label: Label;
  reportable: boolean;
  lastEvidenceAt: Date | null;
}

/**
 * Folds all valid evidence for one objective. Families: the bank has no reasoning/scenario families yet, so distinct
 * questions stand in for them (this overstates diversity; see CONSTRUCTION-013).
 */
export function objectiveState(rows: EvidenceRow[], p: MasteryPolicy, now: Date): ObjectiveState {
  let alpha = p.prior.alpha;
  let beta = p.prior.beta;
  let effective = 0;
  let qualitySum = 0;
  let last: Date | null = null;
  for (const r of rows) {
    alpha += r.weight * r.score;
    beta += r.weight * (1 - r.score);
    effective += r.weight;
    qualitySum += r.wQuality * r.weight;
    if (!last || r.at > last) last = r.at;
  }
  const counted = rows.filter((r) => r.weight > 0);
  const families = new Set(counted.map((r) => r.questionId)).size;
  const sessions = new Set(counted.map((r) => r.sessionId)).size;
  const controlled = counted.filter((r) => r.mode === 'TEST').length;
  const mastery = alpha / (alpha + beta);
  const quality = effective > 0 ? qualitySum / effective : 0;
  const confidence = confidenceOf({ effective, families, sessions, quality, last, now }, p);
  const base = { alpha: round4(alpha), beta: round4(beta), mastery: round4(mastery), confidence, effectiveEvidence: round4(effective), evidenceCount: rows.length, families, sessions, controlledEvidence: controlled, lastEvidenceAt: last };
  const { label, reportable } = labelFor({ ...base, effectiveEvidence: effective }, p);
  return { ...base, label, reportable };
}

export function confidenceOf(
  x: { effective: number; families: number; sessions: number; quality: number; last: Date | null; now: Date },
  p: MasteryPolicy,
): number {
  if (x.effective <= 0) return 0;
  const c = p.confidence;
  const volume = 1 - Math.exp(-x.effective / c.volumeScale);
  const diversity = Math.min(1, c.diversityBase + c.diversityPerFamily * x.families);
  const sessions = x.sessions >= 2 ? 1 : c.singleSessionFactor;
  const days = x.last ? (x.now.getTime() - x.last.getTime()) / 86_400_000 : Infinity;
  let recency = 1;
  if (days > c.recencyFullDays) {
    const span = Math.max(1, c.recencyFloorDays - c.recencyFullDays);
    recency = Math.max(c.recencyFloor, 1 - ((1 - c.recencyFloor) * (days - c.recencyFullDays)) / span);
  }
  return Math.round(100 * volume * diversity * sessions * x.quality * recency * 10) / 10;
}

/** The gate decides whether any band may be shown; below it the label is BUILDING_EVIDENCE (never a negative label). */
export function labelFor(
  s: { mastery: number; confidence: number; effectiveEvidence: number; families: number; sessions: number; controlledEvidence: number; evidenceCount: number },
  p: MasteryPolicy,
): { label: Label; reportable: boolean } {
  if (s.evidenceCount === 0) return { label: 'NOT_STARTED', reportable: false };
  const g = p.gates.ordinary;
  const reportable =
    s.confidence >= g.confidence && s.effectiveEvidence >= g.effective && s.families >= g.families && s.sessions >= g.sessions && s.controlledEvidence >= g.controlled;
  if (!reportable) return { label: 'BUILDING_EVIDENCE', reportable: false };
  const m = s.mastery * 100;
  if (m >= p.bands.strong) {
    const sg = p.gates.strong;
    const strong = m >= sg.mastery && s.confidence >= sg.confidence && s.effectiveEvidence >= sg.effective && s.families >= sg.families && s.sessions >= sg.sessions;
    return { label: strong ? 'STRONG' : 'SECURE', reportable: true };
  }
  if (m >= p.bands.secure) return { label: 'SECURE', reportable: true };
  if (m >= p.bands.developing) return { label: 'DEVELOPING', reportable: true };
  // A weakness claim needs more evidence than an ordinary one: one bad test is not a weakness.
  const wg = p.gates.weak;
  const weak = s.effectiveEvidence >= wg.effective && s.families >= wg.families && s.sessions >= wg.sessions;
  return weak ? { label: 'NEEDS_ATTENTION', reportable: true } : { label: 'BUILDING_EVIDENCE', reportable: false };
}

/** Same accumulator for a difficulty or cognitive slice (no gate: these feed diagnostics, not claims). */
export function sliceState(rows: Array<{ score: number; weight: number }>, p: MasteryPolicy): { mastery: number; effectiveEvidence: number; evidenceCount: number } {
  let a = p.prior.alpha;
  let b = p.prior.beta;
  let e = 0;
  for (const r of rows) {
    a += r.weight * r.score;
    b += r.weight * (1 - r.score);
    e += r.weight;
  }
  return { mastery: round4(a / (a + b)), effectiveEvidence: round4(e), evidenceCount: rows.length };
}

// ── rollup ───────────────────────────────────────────────────────────────

export interface RollupInput {
  label: Label;
  reportable: boolean;
  mastery: number;
  effectiveEvidence: number;
}

/**
 * A chapter label from its objectives. Shown only when enough of the chapter's objectives are themselves reportable,
 * so a rollup never hides gaps; and a chapter with any objective needing attention is never above DEVELOPING.
 */
export function rollup(objectives: RollupInput[], p: MasteryPolicy): { label: Label; reportable: number; total: number; started: number } {
  const total = objectives.length;
  const started = objectives.filter((o) => o.label !== 'NOT_STARTED').length;
  const rep = objectives.filter((o) => o.reportable);
  if (started === 0) return { label: 'NOT_STARTED', reportable: 0, total, started };
  if (rep.length < p.rollup.minReportable || rep.length / Math.max(1, total) < p.rollup.minReportableShare) {
    return { label: 'BUILDING_EVIDENCE', reportable: rep.length, total, started };
  }
  const w = rep.reduce((a, o) => a + o.effectiveEvidence, 0);
  const mean = (rep.reduce((a, o) => a + o.mastery * o.effectiveEvidence, 0) / w) * 100;
  let label: Label = mean >= p.bands.strong ? (rep.every((o) => o.label === 'STRONG') ? 'STRONG' : 'SECURE') : mean >= p.bands.secure ? 'SECURE' : mean >= p.bands.developing ? 'DEVELOPING' : 'NEEDS_ATTENTION';
  if (rep.some((o) => o.label === 'NEEDS_ATTENTION') && (label === 'STRONG' || label === 'SECURE')) label = 'DEVELOPING';
  return { label, reportable: rep.length, total, started };
}

function round4(x: number): number {
  return Math.round(x * 10000) / 10000;
}
