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
 *   schools plan ...   (school academic plans; run `schools plan` for the list)
 */
import type { SchoolPlanService } from '../school-plan.service';
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
  schools plan chapters <curriculumCode> <gradeCode>
  schools plan create   <schoolId> <curriculumCode> <gradeCode> <academicYear>
  schools plan add      <planId> "<term>" "<assessment or ->" <subjectCode> <chapterCode>
  schools plan remove   <planId> "<term>" "<assessment or ->" <subjectCode> <chapterCode>
  schools plan publish  <planId>
  schools plan reopen   <planId>
  schools plan show     <planId>
  schools plan list     [schoolId]
Set ADMIN_OPERATOR to your name or email for the audit trail.`;

type Deps = {
  registry: Pick<
    SchoolRegistryService,
    'addSchool' | 'addAlias' | 'addBranch' | 'retireSchool' | 'listSchools' | 'listPendingCandidates' | 'resolveCandidate'
  >;
  plans?: Pick<SchoolPlanService, 'createPlan' | 'addEntry' | 'removeEntry' | 'publish' | 'reopen' | 'show' | 'list' | 'chapters'>;
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
    case 'plan': {
      if (!deps.plans) throw new CliUsageError(USAGE);
      return runPlan(argv.slice(1), deps.plans, operator);
    }
    default:
      void extra;
      throw new CliUsageError(USAGE);
  }
}

async function runPlan(args: string[], plans: NonNullable<Deps['plans']>, operator: string): Promise<string> {
  const [cmd, ...r] = args;
  const need = (n: number) => {
    if (r.length !== n) throw new CliUsageError(USAGE);
  };
  const dash = (v: string) => (v === '-' ? '' : v);
  switch (cmd) {
    case 'chapters': {
      need(2);
      const subjects = await plans.chapters(r[0], r[1]);
      if (!subjects.length) return 'No chapters available for that curriculum and grade (is the curriculum loaded and open for tests?).';
      return subjects.map((s) => `${s.subjectCode}  ${s.subjectName}\n${s.chapters.map((c) => `    ${c.code}  ${c.title}`).join('\n')}`).join('\n');
    }
    case 'create': {
      need(4);
      const x = await plans.createPlan({ schoolId: r[0], curriculumCode: r[1], gradeCode: r[2], academicYear: r[3], operator });
      return x.created ? `Created draft plan ${x.id}.` : `A plan for that school, grade and year already exists: ${x.id}.`;
    }
    case 'add': {
      need(5);
      const x = await plans.addEntry({ planId: r[0], termLabel: r[1], assessmentLabel: dash(r[2]), subjectCode: r[3], chapterCode: r[4], operator });
      return x.added ? 'Chapter added to the plan.' : 'That chapter is already in the plan for that term and assessment.';
    }
    case 'remove': {
      need(5);
      const x = await plans.removeEntry({ planId: r[0], termLabel: r[1], assessmentLabel: dash(r[2]), subjectCode: r[3], chapterCode: r[4], operator });
      return x.removed ? 'Chapter removed from the plan.' : 'Nothing matched; the plan is unchanged.';
    }
    case 'publish': {
      need(1);
      const x = await plans.publish({ planId: r[0], operator });
      return x.published ? 'Plan published: students of this school will see it as a suggestion.' : 'Plan was already published.';
    }
    case 'reopen': {
      need(1);
      const x = await plans.reopen({ planId: r[0], operator });
      return x.reopened ? 'Plan is a draft again and no longer shown to students.' : 'Plan was already a draft.';
    }
    case 'show': {
      need(1);
      const p = await plans.show(r[0]);
      const lines = p.entries.map((e) => `  ${e.termLabel}${e.assessmentLabel ? ` / ${e.assessmentLabel}` : ''}: ${e.subjectCode} ${e.chapterCode}`);
      return [`${p.schoolName} · ${p.curriculumCode} ${p.gradeCode} · ${p.academicYear} · ${p.status}`, ...(lines.length ? lines : ['  (no chapters yet)'])].join('\n');
    }
    case 'list': {
      if (r.length > 1) throw new CliUsageError(USAGE);
      const rows = await plans.list(r[0]);
      return rows.length ? rows.map((x) => `${x.id}  ${x.schoolName}  ${x.gradeCode}  ${x.academicYear}  ${x.status}  ${x.entries} chapters`).join('\n') : 'No plans yet.';
    }
    default:
      throw new CliUsageError(USAGE);
  }
}
