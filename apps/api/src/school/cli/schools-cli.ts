/**
 * Operator tooling for the school registry (Domain 04). Needs database access, so it is trusted like
 * the policy and roles CLIs. Nothing is invented or imported: every school is typed in by a person.
 *
 *   schools add        "<name>" <countryCode> ["<city>"]
 *   schools alias      <schoolId> "<alias>"
 *   schools branch     <schoolId> "<name>" ["<city>"]
 *   schools retire     <schoolId>
 *   schools list
 *   schools candidates
 *   schools accept     <candidateId> <schoolId>
 *   schools reject     <candidateId>
 */
import type { SchoolRegistryService } from '../school-registry.service';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const USAGE = `Usage:
  schools add        "<name>" <countryCode> ["<city>"]
  schools alias      <schoolId> "<alias>"
  schools branch     <schoolId> "<name>" ["<city>"]
  schools retire     <schoolId>
  schools list
  schools candidates
  schools accept     <candidateId> <schoolId>
  schools reject     <candidateId>
Set ADMIN_OPERATOR to your name or email for the audit trail.`;

type Deps = {
  registry: Pick<
    SchoolRegistryService,
    'addSchool' | 'addAlias' | 'addBranch' | 'retireSchool' | 'listSchools' | 'listPendingCandidates' | 'resolveCandidate'
  >;
  operator?: string;
};

export async function runSchoolsCli(argv: string[], deps: Deps): Promise<string> {
  const operator = deps.operator?.trim();
  if (!operator) throw new CliUsageError('ADMIN_OPERATOR must be set (who is running this?)');
  const [command, a, b, c, ...extra] = argv;
  const exact = (n: number) => {
    if (argv.length !== n) throw new CliUsageError(USAGE);
  };

  switch (command) {
    case 'add': {
      if (!a || !b || argv.length > 4) throw new CliUsageError(USAGE);
      const r = await deps.registry.addSchool({ name: a, countryCode: b, city: c, operator });
      return r.created ? `Added school ${r.id}.` : `Already in the registry: ${r.id}.`;
    }
    case 'alias': {
      exact(3);
      const r = await deps.registry.addAlias({ schoolId: a, alias: b, operator });
      return r.added ? 'Alias added.' : 'That alias already exists.';
    }
    case 'branch': {
      if (!a || !b || argv.length > 4) throw new CliUsageError(USAGE);
      const r = await deps.registry.addBranch({ schoolId: a, name: b, city: c, operator });
      return r.created ? `Added branch ${r.id}.` : `Branch already exists: ${r.id}.`;
    }
    case 'retire': {
      exact(2);
      const r = await deps.registry.retireSchool({ schoolId: a, operator });
      return r.retired ? 'School retired (hidden from search; history kept).' : 'School was already retired.';
    }
    case 'list': {
      exact(1);
      const rows = await deps.registry.listSchools();
      return rows.length
        ? rows.map((r) => `${r.id}  ${r.countryCode}  ${r.status}  ${r.name}${r.city ? ` (${r.city})` : ''}`).join('\n')
        : 'No schools in the registry yet.';
    }
    case 'candidates': {
      exact(1);
      const rows = await deps.registry.listPendingCandidates();
      return rows.length
        ? rows.map((r) => `${r.id}  ${r.countryCode}  "${r.nameAsEntered}"`).join('\n')
        : 'No pending school suggestions.';
    }
    case 'accept': {
      exact(3);
      await deps.registry.resolveCandidate({ candidateId: a, decision: { action: 'accept', schoolId: b }, operator });
      return 'Suggestion accepted as an alias; open associations now point at the registry school.';
    }
    case 'reject': {
      exact(2);
      await deps.registry.resolveCandidate({ candidateId: a, decision: { action: 'reject' }, operator });
      return 'Suggestion rejected; affected students can choose again.';
    }
    default:
      void extra;
      throw new CliUsageError(USAGE);
  }
}
