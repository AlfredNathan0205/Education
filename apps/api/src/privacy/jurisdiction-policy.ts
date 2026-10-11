/**
 * Jurisdiction policy: the legal parameters that govern how a student is
 * classified and how consent must be obtained.
 *
 * Design rule (see docs/implementation/CONSTRUCTION-002_INTERPRETATION.md):
 * legal answers live in versioned DATA, never as constants in code. Counsel has
 * not yet confirmed the UAE rules (docs/decisions/BLOCKER_01_*.md), so nothing
 * here hard-codes an age threshold or a mandatory verification method.
 */

export interface JurisdictionPolicyConfig {
  /** Age (in full years) below which a person is a minor. null = not yet established by counsel. */
  minorAgeThreshold: number | null;
  /** Age below which guardian consent is required. null = not yet established by counsel. */
  guardianConsentAgeThreshold: number | null;
  /** Accepted ways to establish a date of birth, e.g. SELF_DECLARED. Empty = not yet established. */
  acceptedDobEvidenceMethods: string[];
  /** Accepted ways to verify a guardian relationship. Empty = not yet established. */
  acceptedGuardianVerificationMethods: string[];
}

export type LegalReviewStatus = 'UNREVIEWED' | 'COUNSEL_REVIEWED';

export class PolicyConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyConfigError';
  }
}

export class PolicyActivationError extends Error {
  constructor(readonly reasons: string[]) {
    super(`Jurisdiction policy cannot be activated: ${reasons.join('; ')}`);
    this.name = 'PolicyActivationError';
  }
}

const CONFIG_KEYS = [
  'minorAgeThreshold',
  'guardianConsentAgeThreshold',
  'acceptedDobEvidenceMethods',
  'acceptedGuardianVerificationMethods',
] as const;

const METHOD_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const MIN_THRESHOLD = 1;
const MAX_THRESHOLD = 30;

/** A config that establishes nothing. Used on read paths so we fail closed. */
export function emptyPolicyConfig(): JurisdictionPolicyConfig {
  return {
    minorAgeThreshold: null,
    guardianConsentAgeThreshold: null,
    acceptedDobEvidenceMethods: [],
    acceptedGuardianVerificationMethods: [],
  };
}

function parseThreshold(value: unknown, key: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new PolicyConfigError(`${key} must be an integer or null`);
  }
  if (value < MIN_THRESHOLD || value > MAX_THRESHOLD) {
    throw new PolicyConfigError(`${key} must be between ${MIN_THRESHOLD} and ${MAX_THRESHOLD}`);
  }
  return value;
}

function parseMethods(value: unknown, key: string): string[] {
  if (!Array.isArray(value)) throw new PolicyConfigError(`${key} must be an array`);
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string' || !METHOD_CODE.test(item)) {
      throw new PolicyConfigError(`${key} entries must be UPPER_SNAKE_CASE codes`);
    }
    seen.add(item);
  }
  return [...seen];
}

/** Strict parse. Throws on any malformed, missing or unknown field. */
export function parsePolicyConfig(raw: unknown): JurisdictionPolicyConfig {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new PolicyConfigError('config must be an object');
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new PolicyConfigError(`unknown config key: ${key}`);
    }
  }
  for (const key of CONFIG_KEYS) {
    if (!(key in obj)) throw new PolicyConfigError(`missing config key: ${key}`);
  }
  return {
    minorAgeThreshold: parseThreshold(obj.minorAgeThreshold, 'minorAgeThreshold'),
    guardianConsentAgeThreshold: parseThreshold(
      obj.guardianConsentAgeThreshold,
      'guardianConsentAgeThreshold',
    ),
    acceptedDobEvidenceMethods: parseMethods(
      obj.acceptedDobEvidenceMethods,
      'acceptedDobEvidenceMethods',
    ),
    acceptedGuardianVerificationMethods: parseMethods(
      obj.acceptedGuardianVerificationMethods,
      'acceptedGuardianVerificationMethods',
    ),
  };
}

/** True when both thresholds have been established. */
export function hasThresholds(config: JurisdictionPolicyConfig): boolean {
  return config.minorAgeThreshold !== null && config.guardianConsentAgeThreshold !== null;
}

export interface ActivatablePolicy {
  legalReview: LegalReviewStatus;
  legalReviewReference: string | null;
  config: JurisdictionPolicyConfig;
}

/**
 * The legal gate, expressed as code. A policy may only become ACTIVE once counsel
 * has reviewed it, the review is referenced, and every parameter is established.
 * Throws PolicyActivationError listing every unmet condition.
 */
export function assertPolicyActivatable(policy: ActivatablePolicy): void {
  const reasons: string[] = [];
  const { config } = policy;

  if (policy.legalReview !== 'COUNSEL_REVIEWED') {
    reasons.push('legal review is not COUNSEL_REVIEWED');
  }
  if (!policy.legalReviewReference || policy.legalReviewReference.trim() === '') {
    reasons.push('legal review reference is missing');
  }
  if (config.minorAgeThreshold === null) reasons.push('minorAgeThreshold is not established');
  if (config.guardianConsentAgeThreshold === null) {
    reasons.push('guardianConsentAgeThreshold is not established');
  }
  if (
    config.minorAgeThreshold !== null &&
    config.guardianConsentAgeThreshold !== null &&
    config.guardianConsentAgeThreshold > config.minorAgeThreshold
  ) {
    // Sanity invariant: someone who is not a minor should not need guardian consent.
    reasons.push('guardianConsentAgeThreshold cannot exceed minorAgeThreshold');
  }
  if (config.acceptedDobEvidenceMethods.length === 0) {
    reasons.push('no accepted DOB evidence methods are listed');
  }
  if (config.acceptedGuardianVerificationMethods.length === 0) {
    reasons.push('no accepted guardian verification methods are listed');
  }

  if (reasons.length > 0) throw new PolicyActivationError(reasons);
}
