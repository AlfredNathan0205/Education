/** Structured reason codes for human decisions on a question. */
/**
 * Starting registry, taken from the validator dimensions the spec names (answer, curriculum, ambiguity,
 * explanation, distractors, difficulty/cognitive, duplicate/novelty, language/readability) plus safety.
 * The spec calls reason codes versioned data owned by policy; this list is mine and is for you to edit.
 */
export const REASON_CODES = [
  'ANSWER_WRONG',
  'ANSWER_AMBIGUOUS',
  'OFF_CURRICULUM',
  'EXPLANATION_WRONG',
  'EXPLANATION_WEAK',
  'DISTRACTOR_WEAK',
  'DIFFICULTY_MISMATCH',
  'COGNITIVE_MISMATCH',
  'DUPLICATE_OR_NEAR_DUPLICATE',
  'LANGUAGE_OR_READABILITY',
  'UNSAFE_OR_INAPPROPRIATE',
  'LIVE_PERFORMANCE_SIGNAL',
  'OTHER',
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export function isReasonCode(v: unknown): v is ReasonCode {
  return typeof v === 'string' && (REASON_CODES as readonly string[]).includes(v);
}

