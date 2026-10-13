/**
 * AI Question Factory rules (Domain 05/06). Pure: no database, no model calls.
 *
 * The factory only ever proposes DRAFT questions. A person must submit and a different person approve
 * (see question-domain.ts); nothing here approves, publishes or activates anything. The operator decides
 * demand (see bank-coverage); the generator never does.
 */
import { GENERATION_LIMITS } from '../bank-coverage/coverage-domain';
import { OPTION_COUNT, OPTION_LABELS, type QuestionCognitive, type QuestionDifficulty } from '../question/question-domain';
import type { ConfidenceDimension, ValidatorEvidence } from '../question/question-governance';

export { GENERATION_LIMITS };

export const AI_ROLES = [
  'QUESTION_GENERATOR',
  'ANSWER_SOLVER',
  'CURRICULUM_VALIDATOR',
  'AMBIGUITY_REVIEWER',
  'EXPLANATION_VALIDATOR',
  'DISTRACTOR_VALIDATOR',
  'DIFFICULTY_COGNITIVE_VALIDATOR',
  'READABILITY_REVIEWER',
  'ADVERSARIAL_REVIEWER',
] as const;
export type AiRole = (typeof AI_ROLES)[number];

/** Recorded on every call so a result can always be tied to the exact wording and rules that produced it. */
export const PROMPT_VERSION = 'p1';
export const SCHEMA_VERSION = 's1';
export const CONFIG_VERSION = 'f1';

/**
 * The spec gives the yield breaker (below 30% accepted) and duplicate saturation (above 40%) but not how many
 * attempts to see first. Judging on two or three attempts would stop good batches by chance, so nothing is
 * judged before this many. My assumption; change it here.
 */
export const BREAKER_MIN_ATTEMPTS = 10;

// ------------------------------------------------------------------ config

export interface FactoryConfig {
  /** Kill switch. Off unless FACTORY_ENABLED=true. */
  enabled: boolean;
  /** Tokens (in + out) all batches may use per UTC day. Required, no default: spending is your decision. */
  dailyTokenBudget: number | null;
  /** How many times the blind answer solver runs per candidate. */
  solverPasses: number;
  callTimeoutMs: number;
}

export function loadFactoryConfig(env: Record<string, string | undefined> = process.env): FactoryConfig {
  const flag = env.FACTORY_ENABLED?.trim().toLowerCase();
  if (flag !== undefined && flag !== '' && flag !== 'true' && flag !== 'false') throw new Error('FACTORY_ENABLED must be "true" or "false"');
  const int = (name: string, min: number, max: number): number | null => {
    const raw = env[name]?.trim();
    if (!raw) return null;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be a whole number from ${min} to ${max}`);
    return n;
  };
  return {
    enabled: flag === 'true',
    dailyTokenBudget: int('FACTORY_DAILY_TOKEN_BUDGET', 1, 2_000_000_000),
    solverPasses: int('FACTORY_SOLVER_PASSES', 1, 3) ?? 1,
    callTimeoutMs: int('FACTORY_CALL_TIMEOUT_MS', 1000, 600_000) ?? 60_000,
  };
}

export class FactoryDisabledError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryDisabledError';
  }
}

/** Throws unless the factory may run at all. */
export function assertFactoryMayRun(c: FactoryConfig): number {
  if (!c.enabled) throw new FactoryDisabledError('The question factory is switched off. Set FACTORY_ENABLED=true to allow it.');
  if (c.dailyTokenBudget === null) throw new FactoryDisabledError('Set FACTORY_DAILY_TOKEN_BUDGET (tokens per day). There is no default: how much to spend is your decision.');
  return c.dailyTokenBudget;
}

// ---------------------------------------------------------------- requests

export interface GenerationRequest {
  difficulty: QuestionDifficulty;
  cognitive: QuestionCognitive;
  count: number;
}

export class FactoryRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryRequestError';
  }
}

/** The per-cycle cap is the spec's; asking for more is refused rather than quietly trimmed. */
export function validateRequest(r: GenerationRequest): void {
  if (!Number.isInteger(r.count) || r.count < 1) throw new FactoryRequestError('count must be a whole number of at least 1');
  if (r.count > GENERATION_LIMITS.maxPerCellPerCycle) {
    throw new FactoryRequestError(`at most ${GENERATION_LIMITS.maxPerCellPerCycle} questions per cell per cycle`);
  }
}

/** Provisional daily cap on candidates for one cell (spec: max 50 candidates/cell/day). */
export function dailyCellRoom(candidatesToday: number): number {
  return Math.max(0, GENERATION_LIMITS.provisionalMaxCandidatesPerCellPerDay - candidatesToday);
}

// ------------------------------------------------------ model output shapes

export interface Candidate {
  stem: string;
  options: string[];
  correctIndex: number;
  explanation: string | null;
}

export class OutputFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutputFormatError';
  }
}

/** Models often wrap JSON in a code fence or add a sentence around it. Take the outermost object, nothing else. */
export function extractJsonObject(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new OutputFormatError('no JSON object in the reply');
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new OutputFormatError('the reply is not valid JSON');
  }
}

function obj(v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new OutputFormatError('expected a JSON object');
  return v as Record<string, unknown>;
}

function label(v: unknown): number {
  const i = typeof v === 'string' ? (OPTION_LABELS as readonly string[]).indexOf(v.trim().toUpperCase()) : -1;
  if (i < 0) throw new OutputFormatError('the answer must be A, B, C or D');
  return i;
}

export function parseCandidate(text: string): Candidate {
  const o = obj(extractJsonObject(text));
  if (typeof o.stem !== 'string') throw new OutputFormatError('stem must be text');
  if (!Array.isArray(o.options) || o.options.length !== OPTION_COUNT || o.options.some((x) => typeof x !== 'string')) {
    throw new OutputFormatError(`options must be a list of ${OPTION_COUNT} texts`);
  }
  const explanation = o.explanation === undefined || o.explanation === null ? null : o.explanation;
  if (explanation !== null && typeof explanation !== 'string') throw new OutputFormatError('explanation must be text');
  const clean = (s: string) => s.replace(/\s+/g, ' ').trim();
  return {
    stem: clean(o.stem),
    options: (o.options as string[]).map(clean),
    correctIndex: label(o.correct),
    explanation: explanation === null || clean(explanation) === '' ? null : clean(explanation),
  };
}

/** The solver sees the question without the key; null means it could not decide. */
export function parseSolverAnswer(text: string): number | null {
  const o = obj(extractJsonObject(text));
  if (o.answer === null) return null;
  return label(o.answer);
}

export interface Verdict {
  score: number;
  critical: boolean;
  issues: string[];
}

export function parseVerdict(text: string): Verdict {
  const o = obj(extractJsonObject(text));
  if (typeof o.score !== 'number' || !Number.isFinite(o.score) || o.score < 0 || o.score > 1) throw new OutputFormatError('score must be a number from 0 to 1');
  if (typeof o.critical !== 'boolean') throw new OutputFormatError('critical must be true or false');
  const issues = o.issues === undefined ? [] : o.issues;
  if (!Array.isArray(issues) || issues.length > 10 || issues.some((x) => typeof x !== 'string' || x.length > 300)) {
    throw new OutputFormatError('issues must be a short list of short texts');
  }
  return { score: o.score, critical: o.critical, issues: issues as string[] };
}

// ------------------------------------------------------------------ novelty

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3));
}

/** Word-overlap similarity 0..1. Advisory only: the spec says similarity alone never rejects a question. */
export function similarity(a: string, b: string): number {
  const x = tokens(a);
  const y = tokens(b);
  if (x.size === 0 || y.size === 0) return 0;
  let both = 0;
  for (const t of x) if (y.has(t)) both++;
  return both / (x.size + y.size - both);
}

export function noveltyScore(candidateText: string, existing: string[]): number {
  let max = 0;
  for (const e of existing) max = Math.max(max, similarity(candidateText, e));
  return Math.round((1 - max) * 1000) / 1000;
}

// --------------------------------------------------------------- evidence

/** Validators that judge the question and map to a confidence dimension. */
export const JUDGES: Array<{ role: AiRole; dimension: ConfidenceDimension }> = [
  { role: 'CURRICULUM_VALIDATOR', dimension: 'curriculum' },
  { role: 'AMBIGUITY_REVIEWER', dimension: 'ambiguity' },
  { role: 'EXPLANATION_VALIDATOR', dimension: 'explanation' },
  { role: 'DISTRACTOR_VALIDATOR', dimension: 'distractors' },
  { role: 'DIFFICULTY_COGNITIVE_VALIDATOR', dimension: 'cognitiveDifficulty' },
  { role: 'READABILITY_REVIEWER', dimension: 'readability' },
];

/** Weak scores here can be fixed by rewriting; a wrong key or an off-curriculum question cannot. */
export const REPAIRABLE_DIMENSIONS: readonly ConfidenceDimension[] = ['explanation', 'distractors', 'readability', 'cognitiveDifficulty'];
export const MAX_REPAIRS = GENERATION_LIMITS.maxRepairs;

export interface RawEvidence {
  /** What each blind solver pass chose (null = could not decide), compared with the key. */
  solverAnswers: Array<number | null>;
  keyIndex: number;
  verdicts: Partial<Record<AiRole, Verdict>>;
  novelty: number;
}

export interface BuiltEvidence {
  evidence: ValidatorEvidence;
  issues: Array<{ role: string; message: string }>;
}

/**
 * Turns validator output into the evidence the spec's confidence calculation uses.
 * - answer: share of blind solver passes that matched the key; any miss is a critical gate.
 * - a critical verdict is a gate on its dimension; the adversarial reviewer's critical counts on ambiguity.
 * - unresolved conflict: the solver passes disagree with each other.
 * - repairable: no gate, something is weak, and every weak dimension (novelty aside) is one a rewrite can fix.
 */
export function buildEvidence(raw: RawEvidence, greenThreshold: number): BuiltEvidence {
  const scores: Partial<Record<ConfidenceDimension, number>> = {};
  const gates = new Set<ConfidenceDimension>();
  const issues: Array<{ role: string; message: string }> = [];

  const passes = raw.solverAnswers;
  if (passes.length > 0) {
    const matched = passes.filter((a) => a === raw.keyIndex).length;
    scores.answer = matched / passes.length;
    if (matched < passes.length) {
      gates.add('answer');
      issues.push({ role: 'ANSWER_SOLVER', message: `blind solver did not reproduce the key in ${passes.length - matched} of ${passes.length} pass(es)` });
    }
  }
  for (const j of JUDGES) {
    const v = raw.verdicts[j.role];
    if (!v) continue;
    scores[j.dimension] = v.score;
    if (v.critical) gates.add(j.dimension);
    for (const m of v.issues) issues.push({ role: j.role, message: m });
  }
  const adv = raw.verdicts.ADVERSARIAL_REVIEWER;
  if (adv) {
    if (adv.critical) gates.add('ambiguity');
    if (scores.ambiguity !== undefined) scores.ambiguity = Math.min(scores.ambiguity, adv.score);
    for (const m of adv.issues) issues.push({ role: 'ADVERSARIAL_REVIEWER', message: m });
  }
  scores.novelty = raw.novelty;

  const distinct = new Set(passes.filter((a) => a !== null));
  const unresolvedConflict = passes.length > 1 && distinct.size > 1 && passes.some((a) => a === raw.keyIndex);
  // Novelty is advisory (the spec says similarity alone never rejects) and a small dip must not block a repair of something real.
  const weak = (Object.keys(scores) as ConfidenceDimension[]).filter((d) => d !== 'novelty' && (scores[d] as number) < greenThreshold);
  const repairable = gates.size === 0 && weak.length > 0 && weak.every((d) => REPAIRABLE_DIMENSIONS.includes(d));
  return { evidence: { scores, criticalGates: [...gates], unresolvedConflict, repairable }, issues };
}

// ----------------------------------------------------------------- routing

export type NextStep = 'STORE' | 'STORE_FLAGGED' | 'REPAIR' | 'REJECT' | 'FAIL';

/**
 * GREEN: store as a draft for a person. YELLOW: repair (at most twice), then a person looks. AMBER: store flagged
 * for a person. RED: reject. No route (evidence incomplete): fail, store nothing. Nothing is ever auto-approved:
 * the spec allows that only under a trust policy that does not exist yet.
 */
export function nextStep(route: 'GREEN' | 'YELLOW' | 'AMBER' | 'RED' | null, repairsDone: number): NextStep {
  if (route === null) return 'FAIL';
  if (route === 'GREEN') return 'STORE';
  if (route === 'YELLOW') return repairsDone < MAX_REPAIRS ? 'REPAIR' : 'STORE_FLAGGED';
  if (route === 'AMBER') return 'STORE_FLAGGED';
  return 'REJECT';
}

export interface BatchTally {
  attempted: number;
  stored: number;
  duplicates: number;
}

/** Stops a batch that is wasting money. Returns the reason, or null to carry on. */
export function breakerReason(t: BatchTally): string | null {
  if (t.attempted < BREAKER_MIN_ATTEMPTS) return null;
  if (t.stored / t.attempted < GENERATION_LIMITS.yieldBreakerBelow) {
    return `yield breaker: only ${t.stored} of ${t.attempted} candidates were usable (below ${GENERATION_LIMITS.yieldBreakerBelow * 100}%)`;
  }
  if (t.duplicates / t.attempted > GENERATION_LIMITS.duplicateSaturationAbove) {
    return `duplicate saturation: ${t.duplicates} of ${t.attempted} candidates were duplicates (above ${GENERATION_LIMITS.duplicateSaturationAbove * 100}%)`;
  }
  return null;
}
