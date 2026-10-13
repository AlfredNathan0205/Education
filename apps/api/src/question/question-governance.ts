/**
 * Question governance rules (Domain 05) that need no database and no AI:
 *  - structured reason codes,
 *  - the deterministic checks that run before any AI validation,
 *  - the confidence and routing calculation, using the spec's weights and thresholds.
 *
 * Nothing here approves a question. Approval stays a human act (see question-domain.ts). The confidence
 * calculation has no producer yet: the independent validators arrive with the AI Question Factory.
 */
import { OPTION_COUNT, validateQuestionDraft, type QuestionDraft } from './question-domain';

export { REASON_CODES, isReasonCode, type ReasonCode } from './reason-codes';

// -------------------------------------------------------- deterministic checks

export const DETERMINISTIC_VALIDATOR_VERSION = 'det-1';

export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR';
export interface Finding {
  code: string;
  severity: Severity;
  message: string;
}
export interface DeterministicResult {
  validatorVersion: string;
  passed: boolean;
  critical: number;
  major: number;
  minor: number;
  findings: Finding[];
}

const ALL_NONE = /\b(all|none) of the (above|these)\b|\bboth (a|b) and (b|c|d)\b/i;

/**
 * Checks that need no judgement. CRITICAL blocks submission; MAJOR and MINOR are shown to the reviewer.
 * A pass means "well formed", never "correct": whether the answer is right is for a human (and, later,
 * independent validators).
 */
export function runDeterministicChecks(draft: QuestionDraft): DeterministicResult {
  const findings: Finding[] = [];
  for (const p of validateQuestionDraft(draft)) findings.push({ code: 'STRUCTURE', severity: 'CRITICAL', message: p });
  if (draft.cognitive === null) {
    findings.push({ code: 'COGNITIVE_MISSING', severity: 'CRITICAL', message: 'the cognitive level (C1 to C4) must be set before review' });
  }
  if (draft.explanation === null || draft.explanation.trim() === '') {
    findings.push({ code: 'EXPLANATION_MISSING', severity: 'MAJOR', message: 'there is no explanation for students to read after the test' });
  }
  if (draft.options.length === OPTION_COUNT) {
    if (draft.options.some((o) => ALL_NONE.test(o))) {
      findings.push({ code: 'ALL_NONE_OPTION', severity: 'MINOR', message: 'an option says "all/none of the above" or combines options, which makes the answer depend on the other options' });
    }
    const lens = draft.options.map((o) => o.trim().length);
    const correct = lens[draft.correctIndex];
    const others = lens.filter((_, i) => i !== draft.correctIndex);
    if (correct !== undefined && others.length && correct >= 40 && correct >= 2 * Math.max(...others)) {
      findings.push({ code: 'LENGTH_CUE', severity: 'MINOR', message: 'the correct option is much longer than every other option, which can give the answer away' });
    }
  }
  const critical = findings.filter((f) => f.severity === 'CRITICAL').length;
  return {
    validatorVersion: DETERMINISTIC_VALIDATOR_VERSION,
    passed: critical === 0,
    critical,
    major: findings.filter((f) => f.severity === 'MAJOR').length,
    minor: findings.filter((f) => f.severity === 'MINOR').length,
    findings,
  };
}

// ----------------------------------------------------- confidence and routing

/** Spec weights (INVARIANTS_AND_POLICIES, "Question QC baseline"). */
export const CONFIDENCE_WEIGHTS = {
  answer: 0.3,
  curriculum: 0.2,
  ambiguity: 0.15,
  explanation: 0.1,
  distractors: 0.08,
  cognitiveDifficulty: 0.06,
  readability: 0.05,
  novelty: 0.06,
} as const;
export type ConfidenceDimension = keyof typeof CONFIDENCE_WEIGHTS;

export const ROUTE_THRESHOLDS = { green: 0.985, yellow: 0.95, amber: 0.9 } as const;
export type Route = 'GREEN' | 'YELLOW' | 'AMBER' | 'RED';

export interface ValidatorEvidence {
  /** 0..1 per dimension. A missing dimension means that validator has not run. */
  scores: Partial<Record<ConfidenceDimension, number>>;
  /** Dimensions where a validator raised a critical gate. A hard gate overrides any score. */
  criticalGates: ConfidenceDimension[];
  /** Validators disagreed and nobody has resolved it. */
  unresolvedConflict: boolean;
  /** The issues found are of a kind an automatic repair can fix. */
  repairable: boolean;
}

export interface ConfidenceAssessment {
  /** Null when evidence is incomplete: a question is never routed on partial evidence. */
  score: number | null;
  route: Route | null;
  reason: string;
}

/**
 * Derives confidence from validator evidence (never from a generator's own opinion).
 *  RED: a critical gate, an unresolved conflict, or a score below .900.
 *  GREEN: at least .985 with no gate and no conflict.
 *  YELLOW: .950 up to .985 and repairable. AMBER: the remaining .900 up to .985.
 * The spec's YELLOW and AMBER ranges overlap in print (".950" and ".900-.984"); reading YELLOW as "repairable
 * and at least .950" and AMBER as everything else from .900 is my interpretation. Extra thresholds for
 * high-risk items are not applied because risk is not stored yet.
 */
export function assessConfidence(e: ValidatorEvidence): ConfidenceAssessment {
  const dims = Object.keys(CONFIDENCE_WEIGHTS) as ConfidenceDimension[];
  for (const d of dims) {
    const v = e.scores[d];
    if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1)) {
      throw new RangeError(`score for ${d} must be between 0 and 1`);
    }
  }
  if (e.criticalGates.length) return { score: null, route: 'RED', reason: `critical gate: ${e.criticalGates.join(', ')}` };
  if (e.unresolvedConflict) return { score: null, route: 'RED', reason: 'validators disagree and the conflict is unresolved' };
  const missing = dims.filter((d) => e.scores[d] === undefined);
  if (missing.length) return { score: null, route: null, reason: `evidence incomplete: ${missing.join(', ')}` };
  const score = Math.round(dims.reduce((s, d) => s + CONFIDENCE_WEIGHTS[d] * (e.scores[d] as number), 0) * 1000) / 1000;
  if (score >= ROUTE_THRESHOLDS.green) return { score, route: 'GREEN', reason: 'all validators agree at or above the green threshold' };
  if (score >= ROUTE_THRESHOLDS.yellow && e.repairable) return { score, route: 'YELLOW', reason: 'repairable issues' };
  if (score >= ROUTE_THRESHOLDS.amber) return { score, route: 'AMBER', reason: 'needs a second opinion or a person' };
  return { score, route: 'RED', reason: 'below the amber threshold' };
}
