import { Injectable } from '@nestjs/common';
import { AuthzService } from '../authz/authz.service';
import { pickRole } from '../authz/roles';
import { CurriculumService, type UnitSummary } from '../curriculum/curriculum.service';
import {
  REVIEW_ROLES,
  SUBMIT_ROLES,
  type QuestionActor,
  type QuestionState,
} from './question-domain';
import { QuestionForbiddenError } from './question.errors';
import {
  QuestionService,
  type PlanAction,
  type QuestionDetail,
  type QuestionPlan,
  type QuestionRow,
  type UnitIdentity,
} from './question.service';
import {
  QuestionFormatError,
  parseQuestions,
  type QuestionFormat,
  type QuestionIssue,
} from './import/question-import';

export interface QuestionImportResult {
  ok: boolean;
  written: boolean;
  counts: Record<PlanAction, number>;
  issues: QuestionIssue[];
}

const NONE: Record<PlanAction, number> = { CREATE: 0, UPDATE: 0, NEW_REVISION: 0, UNCHANGED: 0 };

export function summarise(plan: QuestionPlan): Record<PlanAction, number> {
  const counts = { ...NONE };
  for (const i of plan.items) counts[i.action]++;
  return counts;
}

/** Reads a file and works out what it would do. A file that cannot be read at all is an issue, not a 500. */
export async function analyseQuestionFile(
  questions: Pick<QuestionService, 'plan'>,
  unit: UnitIdentity,
  format: QuestionFormat,
  text: unknown,
): Promise<{ plan: QuestionPlan | null; result: QuestionImportResult }> {
  try {
    const parsed = parseQuestions(format, text);
    const plan = await questions.plan(unit, parsed);
    return { plan, result: { ok: plan.issues.length === 0, written: false, counts: summarise(plan), issues: plan.issues.slice(0, 200) } };
  } catch (e) {
    if (!(e instanceof QuestionFormatError)) throw e;
    return { plan: null, result: { ok: false, written: false, counts: { ...NONE }, issues: [{ where: 'file', message: e.message }] } };
  }
}

/**
 * Account-based layer for the question bank. The role is read from the database on every call (never taken
 * from the request), the same way curriculum content upload works. Questions are reviewed with the curriculum
 * roles: an EDITOR writes and submits, a REVIEWER, APPROVER or SUPER_ADMIN decides, and never on their own work.
 */
@Injectable()
export class QuestionBankService {
  constructor(
    private readonly questions: QuestionService,
    private readonly curriculum: CurriculumService,
    private readonly authz: AuthzService,
  ) {}

  async listUnits(accountId: string): Promise<UnitSummary[]> {
    await this.rolesOf(accountId, true);
    return this.curriculum.listSubjectVersions();
  }

  async preview(accountId: string, unitId: string, format: QuestionFormat, text: unknown): Promise<QuestionImportResult> {
    await this.actorFor(accountId, SUBMIT_ROLES, 'only an editor may upload questions');
    const unit = await this.questions.unitIdentity(unitId);
    return (await analyseQuestionFile(this.questions, unit, format, text)).result;
  }

  async upload(accountId: string, unitId: string, format: QuestionFormat, text: unknown): Promise<QuestionImportResult> {
    const actor = await this.actorFor(accountId, SUBMIT_ROLES, 'only an editor may upload questions');
    const unit = await this.questions.unitIdentity(unitId);
    const { plan, result } = await analyseQuestionFile(this.questions, unit, format, text);
    if (!plan || !result.ok) return result;
    const counts = await this.questions.apply(unit, plan, { actor, origin: 'HUMAN' });
    return { ...result, written: true, counts };
  }

  async list(accountId: string, unitId: string, state?: QuestionState): Promise<QuestionRow[]> {
    await this.rolesOf(accountId, true);
    return this.questions.list(await this.questions.unitIdentity(unitId), state);
  }

  async detail(accountId: string, revisionId: string): Promise<QuestionDetail> {
    await this.rolesOf(accountId, true);
    return this.questions.detail(revisionId);
  }

  async submit(accountId: string, revisionId: string): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, SUBMIT_ROLES, 'only an editor may submit a question for review');
    return { state: await this.questions.transition(revisionId, 'IN_REVIEW', actor, {}) };
  }

  async approve(accountId: string, revisionId: string, input: { answerVerified: boolean; note?: string | null }): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may approve a question');
    return { state: await this.questions.transition(revisionId, 'APPROVED', actor, input) };
  }

  async requestChanges(accountId: string, revisionId: string, note: string): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may send a question back');
    return { state: await this.questions.transition(revisionId, 'CHANGES_REQUIRED', actor, { note }) };
  }

  async retire(accountId: string, revisionId: string, note: string): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may retire a question');
    return { state: await this.questions.transition(revisionId, 'RETIRED', actor, { note }) };
  }

  // ---------------------------------------------------------------- roles

  private async rolesOf(accountId: string, requireAny: boolean) {
    const roles = await this.authz.curriculumRolesFor(accountId);
    if (requireAny && roles.length === 0) throw new QuestionForbiddenError('your account does not hold a curriculum role');
    return roles;
  }

  private async actorFor(accountId: string, allowed: readonly import('../curriculum/curriculum-state').CurriculumRole[], deny: string): Promise<QuestionActor> {
    const roles = await this.rolesOf(accountId, false);
    const role = pickRole(roles, allowed);
    if (!role) throw new QuestionForbiddenError(deny);
    return { kind: 'HUMAN', accountId, role };
  }
}
