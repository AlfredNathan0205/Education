/**
 * Operator tooling for jurisdiction policies (Domain 01b). Pure argument handling
 * lives here so it can be tested; the executable wrapper is policy.ts.
 *
 * Workflow (each step is a separate, audited command):
 *   1. draft    <JURISDICTION> <config.json>     creates an UNREVIEWED DRAFT
 *   2. review   <policyId> <reference>           records that counsel reviewed it
 *   3. activate <policyId>                       legal gate, then ACTIVE
 *
 * No legal value is ever defaulted here. The template ships with null thresholds.
 *
 * seed-dev-policy — local-development-only shortcut that creates and activates a
 * TEST_ONLY jurisdiction policy in a single call. Refuses in production and
 * requires ALLOW_DEV_TEST_POLICY=true.
 */
import { readFileSync } from 'node:fs';
import { DEV_DRAFT_WORDING_REFERENCE } from '../../guardian/consent-texts';
import { CORE_PURPOSE, type PrivacyService } from '../privacy.service';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const USAGE = `Usage:
  policy draft <JURISDICTION> <config.json>
  policy review <policyId> <legalReviewReference>
  policy activate <policyId>
  policy consent-wording <PURPOSE_CODE> <textReference> <description...>
  policy seed-dev-policy

Set POLICY_OPERATOR to a name or email for the audit trail.`;

/** The test-only policy config. Thresholds of 18 with SELF_DECLARED DOB. */
export const DEV_TEST_POLICY_CONFIG = {
  minorAgeThreshold: 18,
  guardianConsentAgeThreshold: 18,
  acceptedDobEvidenceMethods: ['SELF_DECLARED'],
  acceptedGuardianVerificationMethods: ['SELF_DECLARED', 'EMAIL_LINK_ATTESTATION'],
} as const;

export const DEV_TEST_JURISDICTION = 'XX';
export const DEV_TEST_REVIEW_REF = 'NOT A LEGAL VALUE - LOCAL TESTING ONLY';

export interface CliDeps {
  service: Pick<
    PrivacyService,
    'createJurisdictionPolicyDraft' | 'markPolicyCounselReviewed' | 'activateJurisdictionPolicy' | 'publishConsentWording'
  >;
  readFile?: (path: string) => string;
  operator?: string;
  /** Defaults to process.env when not injected (tests override this). */
  env?: { NODE_ENV?: string; ALLOW_DEV_TEST_POLICY?: string };
}

export async function runPolicyCli(argv: string[], deps: CliDeps): Promise<string> {
  const [command, ...args] = argv;
  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, 'utf8'));
  const operator = deps.operator?.trim();
  if (!operator) throw new CliUsageError('POLICY_OPERATOR must be set (who is running this?)');

  switch (command) {
    case 'draft': {
      const [jurisdiction, file] = args;
      if (!jurisdiction || !file || args.length !== 2) throw new CliUsageError(USAGE);
      let config: unknown;
      try {
        config = JSON.parse(readFile(file));
      } catch (e) {
        throw new CliUsageError(`cannot read JSON from ${file}: ${(e as Error).message}`);
      }
      const out = await deps.service.createJurisdictionPolicyDraft(
        { jurisdictionCode: jurisdiction, config },
        null,
        operator,
      );
      return `Created DRAFT ${jurisdiction} v${out.version} (id ${out.id}). Not reviewed, not active.`;
    }
    case 'review': {
      const [id, ...ref] = args;
      if (!id || ref.length === 0) throw new CliUsageError(USAGE);
      await deps.service.markPolicyCounselReviewed(id, ref.join(' '), null, operator);
      return `Marked ${id} as COUNSEL_REVIEWED. Not yet active.`;
    }
    case 'activate': {
      const [id] = args;
      if (!id || args.length !== 1) throw new CliUsageError(USAGE);
      await deps.service.activateJurisdictionPolicy(id, null);
      return `Activated ${id}.`;
    }
    case 'consent-wording': {
      const [purpose, reference, ...description] = args;
      if (!purpose || !reference || description.length === 0) throw new CliUsageError(USAGE);
      const out = await deps.service.publishConsentWording({
        purposeCode: purpose,
        textReference: reference,
        description: description.join(' '),
      });
      return `Published ${purpose} wording v${out.version} (${reference}). Earlier versions are retired.`;
    }
    case 'seed-dev-policy': {
      if (args.length !== 0) throw new CliUsageError(USAGE);
      assertDevEnvironment(deps);

      const draft = await deps.service.createJurisdictionPolicyDraft(
        { jurisdictionCode: DEV_TEST_JURISDICTION, config: DEV_TEST_POLICY_CONFIG },
        null,
        operator,
      );
      await deps.service.markPolicyCounselReviewed(
        draft.id,
        DEV_TEST_REVIEW_REF,
        null,
        operator,
      );
      await deps.service.activateJurisdictionPolicy(draft.id, null);
      const wording = await deps.service.publishConsentWording({
        purposeCode: CORE_PURPOSE,
        textReference: DEV_DRAFT_WORDING_REFERENCE,
        description: 'Core service: tests, marking and progress (DEV DRAFT WORDING)',
      });
      return (
        `[DEV TEST POLICY] Consent wording ${CORE_PURPOSE} v${wording.version} is the unreviewed draft. ` +
        `[DEV TEST POLICY] Created and activated ${DEV_TEST_JURISDICTION} ` +
        `v${draft.version} (id ${draft.id}). ` +
        `NOT A LEGAL VALUE - LOCAL TESTING ONLY.`
      );
    }
    default:
      throw new CliUsageError(USAGE);
  }
}

/**
 * Guard: seed-dev-policy must never run in production, and requires an explicit
 * opt-in flag so it cannot be triggered by accident.
 */
export function assertDevEnvironment(deps: CliDeps): void {
  const env = deps.env ?? process.env;
  if (env.NODE_ENV === 'production') {
    throw new CliUsageError('seed-dev-policy refuses to run when NODE_ENV=production');
  }
  if (env.ALLOW_DEV_TEST_POLICY !== 'true') {
    throw new CliUsageError(
      'seed-dev-policy requires ALLOW_DEV_TEST_POLICY=true (set it in .env)',
    );
  }
}
