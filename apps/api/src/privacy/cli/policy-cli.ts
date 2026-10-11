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
 */
import { readFileSync } from 'node:fs';
import type { PrivacyService } from '../privacy.service';

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

Set POLICY_OPERATOR to a name or email for the audit trail.`;

export interface CliDeps {
  service: Pick<
    PrivacyService,
    'createJurisdictionPolicyDraft' | 'markPolicyCounselReviewed' | 'activateJurisdictionPolicy'
  >;
  readFile?: (path: string) => string;
  operator?: string;
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
    default:
      throw new CliUsageError(USAGE);
  }
}
