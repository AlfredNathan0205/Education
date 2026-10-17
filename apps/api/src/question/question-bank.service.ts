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
import { QuestionConflictError, QuestionForbiddenError } from './question.errors';
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

  // ── Step 22: one question at a time, in a form ─────────────────────────────

  /** The objectives a question can be written for (the unit's newest revision), with where they sit. */
  async objectives(accountId: string, unitId: string): Promise<Array<{ code: string; path: string; statement: string; chapter: string; ambiguous: boolean }>> {
    await this.rolesOf(accountId, true);
    const unit = await this.questions.unitIdentity(unitId);
    const out = (await this.questions.objectiveList(unit.latestRevisionId)).map((o) => ({ ...o, ambiguous: false }));
    // An objective code used twice in the tree cannot be chosen by code (the upload would refuse it): say so.
    const counts = new Map<string, number>();
    for (const o of out) counts.set(o.code, (counts.get(o.code) ?? 0) + 1);
    return out.map((o) => ({ ...o, ambiguous: (counts.get(o.code) ?? 0) > 1 }));
  }

  /**
   * Writes or edits ONE question through exactly the same path as a file upload (the same checks, codes, revisions
   * and contributor tracking): a new code creates a draft; the code of a draft or sent-back question edits it; the
   * code of an approved question makes a new revision. Returns the result and the revision to open next.
   */
  async saveOne(accountId: string, unitId: string, raw: unknown): Promise<QuestionImportResult & { revisionId: string | null }> {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new QuestionConflictError('Request body must be a JSON object');
    const b = raw as Record<string, unknown>;
    const question = {
      code: b.code,
      objectiveCode: b.objectiveCode,
      stem: b.stem,
      options: b.options,
      correct: b.correct,
      difficulty: b.difficulty,
      cognitive: b.cognitive === '' ? undefined : b.cognitive,
      explanation: b.explanation === '' ? undefined : b.explanation,
    };
    const text = JSON.stringify({ questions: [question] });
    const result = await this.upload(accountId, unitId, 'json', text);
    const unit = await this.questions.unitIdentity(unitId);
    const revisionId = result.written && typeof b.code === 'string' ? await this.questions.revisionIdByCode(unit, b.code.trim().toUpperCase()) : null;
    return { ...result, revisionId };
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

  async requestChanges(accountId: string, revisionId: string, input: { reasonCode: string; note: string }): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may send a question back');
    return { state: await this.questions.transition(revisionId, 'CHANGES_REQUIRED', actor, input) };
  }

  async retire(accountId: string, revisionId: string, input: { reasonCode: string; note: string }): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may retire a question');
    return { state: await this.questions.transition(revisionId, 'RETIRED', actor, input) };
  }

  /** Pulls an approved question out of serving at once. Any reviewer may; bringing it back is for an approver. */
  async quarantine(accountId: string, revisionId: string, input: { reasonCode: string; note: string }): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may quarantine a question');
    return { state: await this.questions.transition(revisionId, 'QUARANTINED', actor, input) };
  }

  async restore(accountId: string, revisionId: string, input: { reasonCode: string; note: string }): Promise<{ state: QuestionState }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only an approver may restore a quarantined question');
    return { state: await this.questions.transition(revisionId, 'APPROVED', actor, input) };
  }

  /**
   * Quarantines every approved question that came from one AI import (identified by its file hash), for a
   * defect found in a whole batch. Each question is moved on its own, so a failure on one is reported and the
   * rest still go. Returns what was quarantined and what was not.
   */
  async quarantineBatch(accountId: string, aiSource: string, input: { reasonCode: string; note: string }): Promise<{ quarantined: number; failed: Array<{ revisionId: string; message: string }> }> {
    const actor = await this.actorFor(accountId, REVIEW_ROLES, 'only a reviewer or approver may quarantine a batch');
    const ids = await this.questions.approvedRevisionIdsFromSource(aiSource);
    const failed: Array<{ revisionId: string; message: string }> = [];
    let quarantined = 0;
    for (const id of ids) {
      try {
        await this.questions.transition(id, 'QUARANTINED', actor, input);
        quarantined++;
      } catch (e) {
        failed.push({ revisionId: id, message: (e as Error).message });
      }
    }
    return { quarantined, failed };
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
