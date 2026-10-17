import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { ReleaseService } from '../release/release.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';
import { DEFAULT_JURISDICTION } from '../student/student.service';
import { EmptyScopeError, InsufficientBankError, assemble } from '../assembly/assembly-engine';
import { loadServablePool } from '../assembly/pool';
import { appliesTo, designOf, isTargeted, resolveScope } from '../blueprint/blueprint-domain';
import {
  DEFAULT_BLUEPRINT_CODE,
  blueprintByCode,
  recordAssemblyRun,
  servableBlueprints,
  type ServableBlueprint,
} from '../blueprint/blueprint-store';
import {
  EXAM_CONFIG,
  OPTION_COUNT,
  allExcluded,
  clampActiveMs,
  newSeed,
  nextStep,
  revealsAfterLock,
  scoreAssessment,
  slotToPosition,
  type AssessmentMode,
  type Difficulty,
  type ExamConfig,
  type ItemProgress,
  scoringPolicyFor,
  servedCurriculumStates,
} from './exam-domain';
import {
  ExamConflictError,
  ExamInputError,
  ExamNotFoundError,
  ExamNotPermittedError,
  ExamUnavailableError,
} from './exam.errors';

type Tx = Prisma.TransactionClient;

/** Returned from inside a transaction so the expiry is saved before the caller is told no. */
const EXPIRED = Symbol('expired');
const expiredError = () => new ExamConflictError('This assessment has expired');


export type SessionStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'VOID' | 'INVALIDATED';
/** Returned from inside a transaction so a technical-failure exclusion is saved before the caller is told. */
const TECH_FAILED = Symbol('technical-failure');
const REMOVED = 'This question was removed from your test and does not count. Carry on with the next one.';
const TECHNICAL = 'This question had a technical problem and was removed from your test. It does not count against you.';
const CANCELLED = 'This assessment was cancelled because its questions were removed. It does not count.';

/** A question can be shown only if it has its wording and exactly the options the instance expects. */
export function presentable(rev: { stem: string; options: Array<{ position: number }> } | null, optionOrder: number[]): boolean {
  if (!rev || !rev.stem || rev.stem.trim() === '') return false;
  if (rev.options.length !== OPTION_COUNT) return false;
  const have = new Set(rev.options.map((o) => o.position));
  return optionOrder.length === OPTION_COUNT && optionOrder.every((p) => have.has(p));
}

export interface ExamUnitView {
  subjectVersionId: string;
  curriculumCode: string;
  versionLabel: string;
  gradeCode: string;
  subjectCode: string;
  subjectName: string;
  usableQuestions: number;
  /** How many chapters the student chose to focus on in this subject (Step 5). */
  chosenChapters: number;
  /** The default test (Quick 10) can be built now. */
  ready: boolean;
  /** Every test a student may be given for this subject: switched on, published, and for this subject (or any). */
  tests: Array<{ code: string; name: string; total: number; ready: boolean }>;
}

export interface QuestionView {
  position: number;
  total: number;
  pass: 'MAIN' | 'REVISIT';
  stem: string;
  options: Array<{ slot: number; text: string }>;
}

export interface AssessmentView {
  assessmentId: string;
  mode: AssessmentMode;
  status: SessionStatus;
  expiresAt: string;
  total: number;
  answered: number;
  /** Questions taken out of this test (technical failure or invalidation). They do not count. */
  removed: number;
  phase: 'QUESTION' | 'SUMMARY' | 'ENDED';
  question?: QuestionView;
  summary?: { answered: number; unanswered: number; canReviewSkipped: boolean };
}

export interface LockResult {
  locked: true;
  /** PRACTICE only: the answer for this one question, shown after it is locked. */
  reveal?: { correct: boolean; correctSlot: number; explanation: string | null };
}

export interface ResultView {
  assessmentId: string;
  mode: AssessmentMode;
  total: number;
  correct: number;
  unanswered: number;
  /** Questions that do not count (technical failure or invalidation). `total` already leaves them out. */
  removed: number;
  /** The result was changed after scoring because a question was invalidated. */
  corrected: boolean;
  byDifficulty: Record<Difficulty, { total: number; correct: number }>;
  competitiveEligible: boolean;
  items: Array<{
    position: number;
    difficulty: Difficulty;
    stem: string;
    outcome: 'CORRECT' | 'INCORRECT' | 'UNANSWERED' | 'EXCLUDED';
    excludedReason: 'TECHNICAL_FAILURE' | 'INVALIDATED' | null;
    explanation: string | null;
    options: Array<{ slot: number; text: string; isCorrect: boolean; chosen: boolean }>;
  }>;
}

export interface AssessmentSummaryRow {
  assessmentId: string;
  mode: AssessmentMode;
  status: SessionStatus;
  subjectCode: string;
  subjectName: string;
  gradeCode: string;
  blueprint: string;
  startedAt: string;
  submittedAt: string | null;
  expiresAt: string;
  correct: number | null;
  total: number | null;
}

/**
 * Domain: Assessment assembly and execution (Quick 10; TEST and PRACTICE).
 *
 * - The instance (exact question revisions, option order) is locked when the test is created.
 * - One question at a time; a locked answer is final; skipped questions are revisited once.
 * - The student never receives answer keys before submitting. PRACTICE reveals one question's answer
 *   after that question is locked, and nothing else.
 * - Scoring is deterministic and needs no AI.
 * - Every state-changing call runs in a transaction holding a row lock on the session.
 */
@Injectable()
export class ExamService {
  constructor(
    private readonly db: DatabaseService,
    private readonly privacy: PrivacyService,
    private readonly outbox: OutboxService,
    @Inject(EXAM_CONFIG) private readonly config: ExamConfig,
    // Step 18: limits on tests a student starts themselves. Absent (as in older tests) = no limits.
    @Optional() private readonly entitlements?: EntitlementService,
    // Step 21: release tiers. Absent (as in older tests) = every served subject is visible.
    @Optional() private readonly release?: ReleaseService,
  ) {}

  /** Step 21: whether this student may see a subject at its release tier. */
  private async released(db: Tx, studentId: string, unit: { curriculum_version_id: string; grade_id: string; subject_id: string }): Promise<boolean> {
    return this.release ? this.release.visible(db, studentId, unit) : true;
  }

  // ── discovery ────────────────────────────────────────────────────────────

  /**
   * The subjects this student may be tested on: only those of their own curriculum and grade (spec STUDENT_WEB:
   * unsupported cohorts are Coming Soon, never silently substituted). None until the student has chosen a grade.
   */
  async listUnits(accountId: string): Promise<ExamUnitView[]> {
    const studentId = await this.gate(accountId);
    const db = this.db.client as unknown as Tx;
    const cohort = await this.cohortOf(db, studentId);
    if (!cohort) return [];
    const chosen = await db.student_chapter_selection.findMany({ where: { student_id: studentId }, select: { subject_code: true } });
    const rows = await db.curriculum_subject_version.findMany({
      where: {
        state: { in: this.servedStates() },
        curriculum_version: { curriculum: { code: cohort.curriculumCode } },
        grade: { code: cohort.gradeCode },
      },
      orderBy: { revision: 'desc' },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    const blueprints = await servableBlueprints(db);
    const seen = new Set<string>();
    const units: ExamUnitView[] = [];
    for (const r of rows) {
      const key = `${r.curriculum_version_id}|${r.grade_id}|${r.subject_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      // Belt and braces: the query already filters by cohort.
      if (r.curriculum_version.curriculum.code !== cohort.curriculumCode || r.grade.code !== cohort.gradeCode) continue;
      // Step 21: a subject not released to this student is not offered (Coming soon).
      if (!(await this.released(db, studentId, r))) continue;
      const pool = await loadServablePool(db, r, studentId);
      const codes = { curriculumCode: r.curriculum_version.curriculum.code, gradeCode: r.grade.code, subjectCode: r.subject.code };
      const tests = blueprints
        // Practice and retest designs (objective scope) are started from a recommendation, never chosen directly.
        .filter((b) => appliesTo(b, codes) && !isTargeted(b.published!.scope_mode))
        .map((b) => ({ code: b.code, name: b.name, total: b.published!.total_questions, ready: pool.items.length >= b.published!.total_questions }));
      units.push({
        subjectVersionId: r.id,
        curriculumCode: codes.curriculumCode,
        versionLabel: r.curriculum_version.label,
        gradeCode: r.grade.code,
        subjectCode: r.subject.code,
        subjectName: r.subject.name,
        usableQuestions: pool.items.length,
        chosenChapters: chosen.filter((c: { subject_code: string }) => c.subject_code === r.subject.code).length,
        ready: tests.find((t) => t.code === DEFAULT_BLUEPRINT_CODE)?.ready ?? false,
        tests,
      });
    }
    return units.sort((a, b) => `${a.gradeCode}${a.subjectName}`.localeCompare(`${b.gradeCode}${b.subjectName}`));
  }

  async listMine(accountId: string): Promise<AssessmentSummaryRow[]> {
    const studentId = await this.gate(accountId);
    const db = this.db.client as unknown as Tx;
    const stale = await db.assessment_session.findMany({
      where: { student_id: studentId, status: 'IN_PROGRESS', expires_at: { lte: new Date() } },
      select: { id: true },
    });
    for (const s of stale) await this.settle(studentId, s.id);

    const sessions = await db.assessment_session.findMany({
      where: { student_id: studentId },
      orderBy: { started_at: 'desc' },
      take: 20,
      include: { instance: true, result: true },
    });
    const subjects = await db.subject.findMany({ where: { id: { in: sessions.map((s) => s.instance.subject_id) } } });
    const grades = await db.grade.findMany({ where: { id: { in: sessions.map((s) => s.instance.grade_id) } } });
    return sessions.map((s) => ({
      assessmentId: s.id,
      mode: s.mode,
      status: s.status,
      subjectCode: subjects.find((x) => x.id === s.instance.subject_id)?.code ?? '',
      subjectName: subjects.find((x) => x.id === s.instance.subject_id)?.name ?? '',
      gradeCode: grades.find((x) => x.id === s.instance.grade_id)?.code ?? '',
      blueprint: s.instance.blueprint_code,
      startedAt: s.started_at.toISOString(),
      submittedAt: s.submitted_at ? s.submitted_at.toISOString() : null,
      expiresAt: s.expires_at.toISOString(),
      correct: s.result?.correct ?? null,
      total: s.result?.total ?? null,
    }));
  }

  // ── create ───────────────────────────────────────────────────────────────

  /**
   * Builds and locks a test from the published version of a blueprint (Quick 10 unless another is asked for). If the
   * student already has the same test open for this subject and mode, returns that.
   */
  async create(
    accountId: string,
    input: { subjectVersionId: string; mode: string; blueprint?: string },
  ): Promise<{ assessmentId: string; resumed: boolean }> {
    if (input.mode !== 'TEST' && input.mode !== 'PRACTICE') throw new ExamInputError('mode must be TEST or PRACTICE');
    const mode = input.mode as AssessmentMode;
    const blueprintCode = input.blueprint ?? DEFAULT_BLUEPRINT_CODE;
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(blueprintCode)) throw new ExamInputError('blueprint is not valid');
    const studentId = await this.gate(accountId);
    return this.db.client.$transaction((tx: Tx) => this.createIn(tx, studentId, { subjectVersionId: input.subjectVersionId, mode, blueprint: blueprintCode, selfStarted: true }));
  }

  /**
   * The body of create, inside the caller's transaction, for a student who has already passed the gate. Step 14
   * recommendations call it with a `target`: the objectives of a practice or retest set and the recommendation it is for.
   * A targeted (objective-scope) blueprint needs a target, and only a targeted blueprint takes one.
   */
  async createIn(
    tx: Tx,
    studentId: string,
    input: { subjectVersionId: string; mode: AssessmentMode; blueprint: string; target?: { objectives: string[]; recommendationId: string }; selfStarted?: boolean },
  ): Promise<{ assessmentId: string; resumed: boolean }> {
    const mode = input.mode;
    const blueprintCode = input.blueprint;
    const target = input.target ?? null;
    {
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
      const now = new Date();

      const unit = await tx.curriculum_subject_version.findUnique({
        where: { id: input.subjectVersionId },
        include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
      });
      if (!unit) throw new ExamNotFoundError('Subject not found');
      if (!this.servedStates().includes(unit.state)) throw new ExamUnavailableError('This subject is not open for tests yet');
      const cohort = await this.cohortOf(tx, studentId);
      if (!cohort) throw new ExamUnavailableError('Choose your curriculum and grade in your profile first');
      if (unit.curriculum_version.curriculum.code !== cohort.curriculumCode || unit.grade.code !== cohort.gradeCode) {
        throw new ExamUnavailableError('This subject is not part of your curriculum and grade');
      }
      const newest = await tx.curriculum_subject_version.findFirst({
        where: {
          curriculum_version_id: unit.curriculum_version_id,
          grade_id: unit.grade_id,
          subject_id: unit.subject_id,
          state: { in: this.servedStates() },
        },
        orderBy: { revision: 'desc' },
        select: { id: true },
      });
      if (!newest || newest.id !== unit.id) throw new ExamConflictError('This subject was updated. Reload the page and try again.');
      if (!(await this.released(tx, studentId, unit))) throw new ExamUnavailableError('This subject is not open for tests yet');

      const open = await tx.assessment_session.findMany({
        where: { student_id: studentId, status: 'IN_PROGRESS' },
        include: { instance: { include: { items: { include: { response: true } } } } },
      });
      for (const s of open) {
        if (s.expires_at <= now) await this.settleExpired(tx, s, now);
        else if (
          s.mode === mode &&
          s.instance.blueprint_code === blueprintCode &&
          s.instance.curriculum_version_id === unit.curriculum_version_id &&
          s.instance.grade_id === unit.grade_id &&
          s.instance.subject_id === unit.subject_id &&
          (s.instance.recommendation_id ?? null) === (target?.recommendationId ?? null)
        ) {
          return { assessmentId: s.id, resumed: true };
        }
      }

      const blueprint = await this.blueprintFor(tx, blueprintCode, unit);
      const version = blueprint.published!;
      if (isTargeted(version.scope_mode) && !target) throw new ExamUnavailableError('This practice set is started from a recommendation');
      if (!isTargeted(version.scope_mode) && target) throw new ExamInputError('Only a practice or retest design takes target objectives');
      // Step 18: a NEW test or practice set the student chose themselves is subject to their plan (resuming is not).
      if (input.selfStarted && this.entitlements) await this.entitlements.assertCanStart(tx, studentId, version.total_questions, now);
      const design = designOf(blueprint.code, version);
      const focus = version.scope_mode === 'STUDENT_FOCUS' ? await this.focusChapters(tx, studentId, unit.subject.code) : null;
      const pool = await loadServablePool(tx, unit, studentId);
      const seedUsed = newSeed();
      let assembled;
      try {
        assembled = assemble(pool.items, design, seedUsed, resolveScope(version, focus, target?.objectives ?? null));
      } catch (e) {
        if (e instanceof InsufficientBankError) throw new ExamUnavailableError('There are not enough approved questions for this test yet');
        if (e instanceof EmptyScopeError) {
          throw new ExamUnavailableError(target ? 'There is nothing to practise here yet' : 'Choose the chapters you are studying for this subject first');
        }
        throw e;
      }
      const instance = await tx.assessment_instance.create({
        data: {
          student_id: studentId,
          mode,
          blueprint_code: blueprint.code,
          blueprint_version: version.version,
          curriculum_version_id: unit.curriculum_version_id,
          grade_id: unit.grade_id,
          subject_id: unit.subject_id,
          subject_version_id: unit.id,
          seed: seedUsed,
          assembly_report: { ...assembled.report, excludedUnmappedObjective: pool.excluded } as unknown as Prisma.InputJsonValue,
          items: {
            create: assembled.items.map((i) => ({
              position: i.position,
              question_revision_id: i.revisionId,
              question_id: i.questionId,
              objective_path: i.objectivePath,
              difficulty: i.difficulty,
              option_order: i.optionOrder,
            })),
          },
          recommendation_id: target?.recommendationId ?? null,
          target_objectives: target?.objectives ?? [],
        },
        select: { id: true },
      });
      await recordAssemblyRun(tx, { instanceId: instance.id, versionId: version.id, seed: seedUsed, mode, result: assembled });
      const expires = new Date(now.getTime() + this.config.resumeHours * 3600_000);
      const session = await tx.assessment_session.create({
        data: { instance_id: instance.id, student_id: studentId, mode, expires_at: expires },
        select: { id: true },
      });
      for (const eventType of ['assessment.created.v1', 'assessment.started.v1']) {
        await this.outbox.publish(tx, {
          aggregateType: 'assessment',
          aggregateId: session.id,
          eventType,
          payload: { assessmentId: session.id, studentId, mode, blueprint: blueprint.code, blueprintVersion: version.version, recommendationId: target?.recommendationId ?? null },
          idempotencyKey: `${eventType}:${session.id}`,
        });
      }
      return { assessmentId: session.id, resumed: false };
    }
  }

  /**
   * Step 16: a TEST built from a question set fixed elsewhere (a ranked challenge, where both players answer exactly the
   * same questions in the same order). The caller has gated the student and holds their row lock; nothing is assembled
   * here, and the instance keeps the challenge's assembly report.
   */
  async createFixed(
    tx: Tx,
    studentId: string,
    input: {
      unit: { subjectVersionId: string; curriculumVersionId: string; gradeId: string; subjectId: string };
      blueprint: string;
      seed: string;
      assemblyReport: unknown;
      items: Array<{ position: number; revisionId: string; questionId: string; objectivePath: string; difficulty: string; optionOrder: number[] }>;
    },
  ): Promise<{ assessmentId: string }> {
    const now = new Date();
    // Step 21: both players must be able to see the subject (a challenge cannot open an unreleased subject).
    if (!(await this.released(tx, studentId, { curriculum_version_id: input.unit.curriculumVersionId, grade_id: input.unit.gradeId, subject_id: input.unit.subjectId }))) {
      throw new ExamUnavailableError('This subject is not open for tests yet');
    }
    const instance = await tx.assessment_instance.create({
      data: {
        student_id: studentId,
        mode: 'TEST',
        blueprint_code: input.blueprint,
        blueprint_version: 1,
        curriculum_version_id: input.unit.curriculumVersionId,
        grade_id: input.unit.gradeId,
        subject_id: input.unit.subjectId,
        subject_version_id: input.unit.subjectVersionId,
        seed: input.seed,
        assembly_report: input.assemblyReport as Prisma.InputJsonValue,
        items: {
          create: input.items.map((i) => ({
            position: i.position,
            question_revision_id: i.revisionId,
            question_id: i.questionId,
            objective_path: i.objectivePath,
            difficulty: i.difficulty as any,
            option_order: i.optionOrder,
          })),
        },
      },
      select: { id: true },
    });
    const session = await tx.assessment_session.create({
      data: { instance_id: instance.id, student_id: studentId, mode: 'TEST', expires_at: new Date(now.getTime() + this.config.resumeHours * 3600_000) },
      select: { id: true },
    });
    for (const eventType of ['assessment.created.v1', 'assessment.started.v1']) {
      await this.outbox.publish(tx, {
        aggregateType: 'assessment',
        aggregateId: session.id,
        eventType,
        payload: { assessmentId: session.id, studentId, mode: 'TEST', blueprint: input.blueprint, blueprintVersion: 1 },
        idempotencyKey: `${eventType}:${session.id}`,
      });
    }
    return { assessmentId: session.id };
  }

  /** The newest served revision of a subject (what a new test must be built from), or null when none is served. */
  async servedUnitId(tx: Tx, unit: { curriculumVersionId: string; gradeId: string; subjectId: string }): Promise<string | null> {
    const row = await tx.curriculum_subject_version.findFirst({
      where: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId, state: { in: this.servedStates() } },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  // ── take the test ─────────────────────────────────────────────────────────

  /**
   * Shows the current question (or the summary). Safe to call again after a refresh. A question that cannot be shown
   * properly is excluded as a technical failure (it never counts against the student) and the next one is shown.
   */
  async present(accountId: string, assessmentId: string): Promise<AssessmentView> {
    const studentId = await this.gate(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      const now = new Date();
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) await this.settleExpired(tx, { ...session, instance: { ...session.instance, items } }, now);

      // Bounded: each pass either returns or excludes one more item.
      for (let guard = 0; guard <= items.length; guard++) {
        const fresh = await this.reload(tx, studentId, assessmentId);
        if (fresh.session.status !== 'IN_PROGRESS') return this.baseView(fresh.session, fresh.items, 'ENDED');

        const step = nextStep(this.progress(fresh.items), fresh.session.revisit_used);
        if (step.kind === 'SUMMARY') {
          return { ...this.baseView(fresh.session, fresh.items, 'SUMMARY'), summary: { answered: step.answered, unanswered: step.unanswered, canReviewSkipped: step.canReviewSkipped } };
        }
        const item = fresh.items.find((i) => i.position === step.position)!;
        // Deliberately selects no is_correct and no explanation.
        const rev = await tx.question_revision.findUnique({
          where: { id: item.question_revision_id },
          select: { stem: true, options: { select: { position: true, text: true } } },
        });
        if (!presentable(rev, item.option_order)) {
          await this.exclude(tx, fresh.session, fresh.items, item, 'TECHNICAL_FAILURE', now);
          continue;
        }

        if (!item.response) {
          await tx.student_response.create({ data: { session_id: session.id, instance_question_id: item.id, presented_at: now } });
          await tx.student_question_exposure.upsert({
            where: { student_id_question_id: { student_id: studentId, question_id: item.question_id } },
            create: { student_id: studentId, question_id: item.question_id },
            update: { last_seen_at: now, times_seen: { increment: 1 } },
          });
          await this.event(tx, session.id, item.id, 'PRESENTED', null, now);
        } else if (item.response.state === 'SKIPPED') {
          await tx.student_response.update({ where: { id: item.response.id }, data: { presented_at: now } });
          await this.event(tx, session.id, item.id, 'PRESENTED', null, now);
        } else if (!item.response.presented_at) {
          await tx.student_response.update({ where: { id: item.response.id }, data: { presented_at: now } });
        }
        const byPosition = new Map(rev!.options.map((o: { position: number; text: string }) => [o.position, o.text]));
        return {
          ...this.baseView(fresh.session, fresh.items, 'QUESTION'),
          question: {
            position: item.position,
            total: fresh.items.length,
            pass: step.pass,
            stem: rev!.stem,
            options: (item.option_order as number[]).map((pos, slot) => ({ slot, text: byPosition.get(pos) ?? '' })),
          },
        };
      }
      throw new Error('present: no progress');
    });
  }

  async lock(
    accountId: string,
    assessmentId: string,
    position: number,
    input: { slot: number; activeMs: unknown; idempotencyKey: string },
  ): Promise<LockResult> {
    const studentId = await this.gate(accountId);
    const out = await this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      const now = new Date();
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) {
        await this.settleExpired(tx, { ...session, instance: { ...session.instance, items } }, now);
        return EXPIRED;
      }
      const item = items.find((i) => i.position === position);
      if (!item) throw new ExamNotFoundError('No such question');
      if (item.excluded) throw new ExamConflictError(REMOVED);
      const existing = item.response;

      // Replay of the same request: same answer back, nothing changes.
      if (existing?.state === 'LOCKED') {
        if (existing.idempotency_key === input.idempotencyKey && existing.selected_slot === input.slot) {
          return this.lockResult(tx, session.mode, item, existing.selected_position as number);
        }
        throw new ExamConflictError('This question already has a locked answer');
      }
      if (session.status !== 'IN_PROGRESS') throw new ExamConflictError('This assessment has ended');
      if (items.some((i) => i.id !== item.id && i.response?.idempotency_key === input.idempotencyKey)) {
        throw new ExamConflictError('That request key was already used');
      }
      const step = nextStep(this.progress(items), session.revisit_used);
      if (step.kind !== 'ITEM' || step.position !== position) throw new ExamConflictError('That is not the current question');

      const chosen = slotToPosition(item.option_order, input.slot);
      if (chosen === null) throw new ExamInputError('Choose one of the four options');
      const options = await tx.question_option.findMany({ where: { revision_id: item.question_revision_id }, select: { position: true, is_correct: true } });
      // Cannot be scored safely (wrong number of options, or not exactly one correct): a technical failure, not the student's error.
      if (options.length !== OPTION_COUNT || options.filter((o) => o.is_correct).length !== 1 || !options.some((o) => o.position === chosen)) {
        await this.exclude(tx, session, items, item, 'TECHNICAL_FAILURE', now);
        return TECH_FAILED;
      }
      const isCorrect = options.find((o) => o.position === chosen)?.is_correct === true;

      const activeMs = clampActiveMs(input.activeMs);
      const presentedAt = existing?.presented_at ?? null;
      const data = {
        state: 'LOCKED' as const,
        selected_slot: input.slot,
        selected_position: chosen,
        is_correct: isCorrect,
        locked_at: now,
        active_ms: activeMs,
        server_elapsed_ms: presentedAt ? Math.max(0, now.getTime() - presentedAt.getTime()) : null,
        idempotency_key: input.idempotencyKey,
      };
      if (existing) await tx.student_response.update({ where: { id: existing.id }, data });
      else await tx.student_response.create({ data: { session_id: session.id, instance_question_id: item.id, ...data } });

      const commits = session.mode === 'TEST' && session.committed_at === null;
      await tx.assessment_session.update({
        where: { id: session.id },
        data: { last_activity_at: now, ...(commits ? { committed_at: now } : {}) },
      });
      await this.event(tx, session.id, item.id, 'LOCKED', activeMs, now);
      await this.outbox.publish(tx, {
        aggregateType: 'assessment',
        aggregateId: session.id,
        eventType: 'assessment.answer_locked.v1',
        payload: { assessmentId: session.id, position, questionRevisionId: item.question_revision_id, committedAttempt: commits },
        idempotencyKey: `assessment.answer_locked.v1:${session.id}:${item.id}`,
      });
      return this.lockResult(tx, session.mode, item, chosen);
    });
    if (out === EXPIRED) throw expiredError();
    if (out === TECH_FAILED) throw new ExamConflictError(TECHNICAL);
    return out;
  }

  /** With a request key, a retried skip returns the same answer instead of a conflict. */
  async skip(accountId: string, assessmentId: string, position: number, input: { activeMs: unknown; idempotencyKey?: string }): Promise<{ skipped: true }> {
    const studentId = await this.gate(accountId);
    const out = await this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      const now = new Date();
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) {
        await this.settleExpired(tx, { ...session, instance: { ...session.instance, items } }, now);
        return EXPIRED;
      }
      const item = items.find((i) => i.position === position);
      if (!item) throw new ExamNotFoundError('No such question');
      // Replay of the same skip: same answer back, nothing changes.
      if (input.idempotencyKey && item.response?.state === 'SKIPPED' && item.response.skip_idempotency_key === input.idempotencyKey) {
        return { skipped: true as const };
      }
      if (session.status !== 'IN_PROGRESS') throw new ExamConflictError('This assessment has ended');
      if (item.excluded) throw new ExamConflictError(REMOVED);
      const step = nextStep(this.progress(items), session.revisit_used);
      if (step.kind !== 'ITEM' || step.position !== position) throw new ExamConflictError('That is not the current question');

      const activeMs = clampActiveMs(input.activeMs);
      const skipCount = (item.response?.skip_count ?? 0) + 1;
      const data = { state: 'SKIPPED' as const, skip_count: skipCount, active_ms: activeMs, skip_idempotency_key: input.idempotencyKey ?? null };
      if (item.response) await tx.student_response.update({ where: { id: item.response.id }, data });
      else await tx.student_response.create({ data: { session_id: session.id, instance_question_id: item.id, ...data } });
      await tx.assessment_session.update({ where: { id: session.id }, data: { last_activity_at: now } });
      await this.event(tx, session.id, item.id, 'SKIPPED', activeMs, now);
      await this.outbox.publish(tx, {
        aggregateType: 'assessment',
        aggregateId: session.id,
        eventType: 'assessment.question_skipped.v1',
        payload: { assessmentId: session.id, position, skipCount },
        idempotencyKey: `assessment.question_skipped.v1:${session.id}:${item.id}:${skipCount}`,
      });
      return { skipped: true as const };
    });
    if (out === EXPIRED) throw expiredError();
    return out;
  }

  /** From the summary, go back through the skipped questions once. */
  async reviewSkipped(accountId: string, assessmentId: string): Promise<{ ok: true }> {
    const studentId = await this.gate(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      if (session.status !== 'IN_PROGRESS' || session.expires_at <= new Date()) throw new ExamConflictError('This assessment has ended');
      const step = nextStep(this.progress(items), session.revisit_used);
      if (step.kind !== 'SUMMARY' || !step.canReviewSkipped) throw new ExamConflictError('There is nothing to review');
      await tx.assessment_session.update({ where: { id: session.id }, data: { revisit_used: true, last_activity_at: new Date() } });
      return { ok: true as const };
    });
  }

  async submit(accountId: string, assessmentId: string): Promise<{ submitted: true }> {
    const studentId = await this.gate(accountId);
    const out = await this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      if (session.status === 'SUBMITTED') return { submitted: true as const };
      if (session.status === 'VOID') throw new ExamConflictError('This assessment expired before any answer was locked');
      if (session.status === 'INVALIDATED') throw new ExamConflictError(CANCELLED);
      const now = new Date();
      if (session.expires_at <= now) {
        await this.settleExpired(tx, { ...session, instance: { ...session.instance, items } }, now);
        return EXPIRED;
      }
      const step = nextStep(this.progress(items), session.revisit_used);
      if (step.kind !== 'SUMMARY') throw new ExamConflictError('Answer or skip every question first');
      await this.finalize(tx, session, items, 'STUDENT', now);
      return { submitted: true as const };
    });
    if (out === EXPIRED) throw expiredError();
    return out;
  }

  // ── after submit ───────────────────────────────────────────────────────────

  async result(accountId: string, assessmentId: string): Promise<ResultView> {
    const studentId = await this.gate(accountId);
    await this.settle(studentId, assessmentId);
    const db = this.db.client as unknown as Tx;
    const session = await db.assessment_session.findFirst({
      where: { id: assessmentId, student_id: studentId },
      include: { result: true, instance: { include: { items: { orderBy: { position: 'asc' }, include: { response: true } } } } },
    });
    if (!session) throw new ExamNotFoundError('Assessment not found');
    if (session.status === 'VOID') throw new ExamConflictError('This assessment expired before any answer was locked');
    if (session.status === 'INVALIDATED') throw new ExamConflictError(CANCELLED);
    if (session.status !== 'SUBMITTED' || !session.result) throw new ExamConflictError('The result is available after you submit');

    const revisions = await db.question_revision.findMany({
      where: { id: { in: session.instance.items.map((i) => i.question_revision_id) } },
      select: { id: true, stem: true, explanation: true, options: { select: { position: true, text: true, is_correct: true } } },
    });
    return {
      assessmentId: session.id,
      mode: session.mode,
      total: session.result.total,
      correct: session.result.correct,
      unanswered: session.result.unanswered,
      removed: session.instance.items.filter((i) => i.excluded).length,
      corrected: session.result.corrected_at !== null && session.result.corrected_at !== undefined,
      byDifficulty: session.result.by_difficulty as ResultView['byDifficulty'],
      competitiveEligible: session.result.competitive_eligible,
      items: session.instance.items.map((i) => {
        const rev = revisions.find((r) => r.id === i.question_revision_id) ?? { stem: '', explanation: null, options: [] };
        const byPos = new Map<number, { text: string; is_correct: boolean }>(rev.options.map((o: { position: number; text: string; is_correct: boolean }) => [o.position, o]));
        const locked = i.response?.state === 'LOCKED';
        return {
          position: i.position,
          difficulty: i.difficulty,
          stem: rev.stem,
          outcome: i.excluded ? 'EXCLUDED' : !locked ? 'UNANSWERED' : i.response?.is_correct ? 'CORRECT' : 'INCORRECT',
          excludedReason: i.excluded ?? null,
          // A removed question's key may be the very thing that was wrong: show no answer and no explanation for it.
          explanation: i.excluded ? null : rev.explanation,
          options: i.option_order.map((pos, slot) => ({
            slot,
            text: byPos.get(pos)?.text ?? '',
            isCorrect: !i.excluded && byPos.get(pos)?.is_correct === true,
            chosen: locked && i.response?.selected_slot === slot,
          })),
        };
      }),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private servedStates() {
    return servedCurriculumStates(this.config) as any[];
  }

  /** The account's own student, who must be age-classified and not awaiting guardian consent. Fails closed. */
  /** The student behind this account, after the same checks as every test call (profile, age, consent). */
  async studentFor(accountId: string): Promise<string> {
    return this.gate(accountId);
  }

  /**
   * Step 17: the subjects of a student's cohort that are open for tests (latest served revision of each), without the
   * account gate. Callers must already have authorised access to this student (the parent view does).
   */
  async subjectsFor(studentId: string): Promise<Array<{ subjectVersionId: string; subjectCode: string; subjectName: string }>> {
    const db = this.db.client as unknown as Tx;
    const cohort = await this.cohortOf(db, studentId);
    if (!cohort) return [];
    const rows = await db.curriculum_subject_version.findMany({
      where: {
        state: { in: this.servedStates() },
        curriculum_version: { curriculum: { code: cohort.curriculumCode } },
        grade: { code: cohort.gradeCode },
      },
      orderBy: { revision: 'desc' },
      include: { subject: true },
    });
    const seen = new Set<string>();
    const out: Array<{ subjectVersionId: string; subjectCode: string; subjectName: string }> = [];
    for (const r of rows) {
      const key = `${r.curriculum_version_id}|${r.grade_id}|${r.subject_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (!(await this.released(db, studentId, r))) continue;
      out.push({ subjectVersionId: r.id, subjectCode: r.subject.code, subjectName: r.subject.name });
    }
    return out.sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  }

  /** The curriculum and grade the student said they study (Step 5), or null before they choose. */
  private async cohortOf(db: Tx, studentId: string): Promise<{ curriculumCode: string; gradeCode: string } | null> {
    const ctx = await db.student_academic_context.findUnique({ where: { student_id: studentId } });
    return ctx ? { curriculumCode: ctx.curriculum_code, gradeCode: ctx.grade_code } : null;
  }

  private async gate(accountId: string): Promise<string> {
    const db = this.db.client as unknown as Tx;
    const access = await db.account_student_access.findFirst({
      where: { account_id: accountId, access_kind: 'SELF', revoked_at: null },
    });
    if (!access) throw new ExamNotPermittedError('Create your profile before taking a test');
    const studentId = access.student_id as string;
    await this.privacy.reclassifyIfStale(studentId, DEFAULT_JURISDICTION);
    const summary = await this.privacy.getClassificationSummary(studentId);
    if (!summary.classified) throw new ExamNotPermittedError('Finish your profile before taking a test');
    if (summary.requiresGuardianConsent && !summary.consentSatisfied) throw new ExamNotPermittedError('A parent or guardian must give consent before you can take a test');
    return studentId;
  }

  /** The published, switched-on blueprint for this code, if it applies to this subject. */
  private async blueprintFor(
    tx: Tx,
    code: string,
    unit: { curriculum_version: { curriculum: { code: string } }; grade: { code: string }; subject: { code: string } },
  ): Promise<ServableBlueprint> {
    const b = await blueprintByCode(tx, code);
    const codes = { curriculumCode: unit.curriculum_version.curriculum.code, gradeCode: unit.grade.code, subjectCode: unit.subject.code };
    if (!b || !b.enabled || !b.published || !appliesTo(b, codes)) throw new ExamUnavailableError('This test is not available for this subject');
    return b;
  }

  /** The chapters the student chose for this subject (Step 5). Empty when they chose none. */
  private async focusChapters(tx: Tx, studentId: string, subjectCode: string): Promise<string[]> {
    const rows = await tx.student_chapter_selection.findMany({ where: { student_id: studentId, subject_code: subjectCode }, select: { chapter_code: true } });
    return rows.map((r) => r.chapter_code);
  }


  private async open(tx: Tx, studentId: string, assessmentId: string) {
    await tx.$queryRaw`SELECT id FROM assessment_session WHERE id = ${assessmentId}::uuid AND student_id = ${studentId}::uuid FOR UPDATE`;
    return this.reload(tx, studentId, assessmentId);
  }

  private async reload(tx: Tx, studentId: string, assessmentId: string) {
    const session = await tx.assessment_session.findFirst({
      where: { id: assessmentId, student_id: studentId },
      include: { instance: { include: { items: { orderBy: { position: 'asc' }, include: { response: true } } } } },
    });
    if (!session) throw new ExamNotFoundError('Assessment not found');
    return { session, items: session.instance.items };
  }

  /** Applies the resume window to a session, in its own transaction. */
  private async settle(studentId: string, assessmentId: string): Promise<void> {
    await this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      const now = new Date();
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) await this.settleExpired(tx, { ...session, instance: { ...session.instance, items } }, now);
    });
  }

  /**
   * The resume window ended. With at least one locked answer the attempt counts and is scored as it
   * stands (unanswered questions score zero); with none it is void and has no result.
   */
  private async settleExpired(tx: Tx, session: any, now: Date): Promise<void> {
    const items = session.instance.items as any[];
    if (items.some((i) => i.response?.state === 'LOCKED')) {
      await this.finalize(tx, session, items, 'EXPIRED', now);
    } else {
      await tx.assessment_session.update({ where: { id: session.id }, data: { status: 'VOID' } });
      await this.outbox.publish(tx, {
        aggregateType: 'assessment',
        aggregateId: session.id,
        eventType: 'assessment.expired_incomplete.v1',
        payload: { assessmentId: session.id, studentId: session.student_id, mode: session.mode },
        idempotencyKey: `assessment.expired_incomplete.v1:${session.id}`,
      });
    }
  }

  private async finalize(tx: Tx, session: any, items: any[], reason: 'STUDENT' | 'EXPIRED', now: Date): Promise<void> {
    if (allExcluded(items.map((i) => ({ excluded: !!i.excluded })))) {
      await this.markInvalidated(tx, session, now);
      return;
    }
    const score = scoreAssessment(
      items.map((i) => ({ difficulty: i.difficulty, locked: i.response?.state === 'LOCKED', isCorrect: i.response?.is_correct ?? null, excluded: !!i.excluded })),
    );
    await tx.assessment_submission.create({
      data: { session_id: session.id, reason, answered_count: score.total - score.unanswered, unanswered_count: score.unanswered, submitted_at: now },
    });
    const competitive = session.mode === 'TEST' && session.committed_at !== null;
    await tx.assessment_result.create({
      data: {
        session_id: session.id,
        student_id: session.student_id,
        mode: session.mode,
        scoring_policy: scoringPolicyFor(session.instance?.blueprint_code ?? DEFAULT_BLUEPRINT_CODE),
        total: score.total,
        correct: score.correct,
        unanswered: score.unanswered,
        by_difficulty: score.byDifficulty as unknown as Prisma.InputJsonValue,
        competitive_eligible: competitive,
        scored_at: now,
      },
    });
    await tx.assessment_session.update({ where: { id: session.id }, data: { status: 'SUBMITTED', submitted_at: now, last_activity_at: now } });
    for (const eventType of ['assessment.submitted.v1', 'assessment.scored.v1']) {
      await this.outbox.publish(tx, {
        aggregateType: 'assessment',
        aggregateId: session.id,
        eventType,
        payload: { assessmentId: session.id, studentId: session.student_id, mode: session.mode, reason, correct: score.correct, total: score.total, competitiveEligible: competitive },
        idempotencyKey: `${eventType}:${session.id}`,
      });
    }
  }

  /**
   * Settles tests whose resume window has passed, oldest first, so results and events do not wait for the student to
   * come back. Each one is settled in its own transaction under the session row lock, so a concurrent request or a
   * second API instance cannot settle it twice. Returns how many it settled.
   */
  async sweepExpired(limit = 100, now = new Date()): Promise<number> {
    const due = await this.db.client.assessment_session.findMany({
      where: { status: 'IN_PROGRESS', expires_at: { lte: now } },
      orderBy: { expires_at: 'asc' },
      take: limit,
      select: { id: true, student_id: true },
    });
    let settled = 0;
    for (const d of due) {
      await this.db.client.$transaction(async (tx: Tx) => {
        const { session, items } = await this.open(tx, d.student_id, d.id);
        if (session.status === 'IN_PROGRESS' && session.expires_at <= new Date()) {
          await this.settleExpired(tx, { ...session, instance: { ...session.instance, items } }, new Date());
          settled++;
        }
      });
    }
    return settled;
  }

  /** Takes one item out of a test that is still running. The caller holds the session row lock. */
  private async exclude(tx: Tx, session: any, items: any[], item: any, kind: 'TECHNICAL_FAILURE', now: Date): Promise<void> {
    await tx.assessment_instance_question.update({ where: { id: item.id }, data: { excluded: kind, excluded_at: now } });
    item.excluded = kind;
    await this.event(tx, session.id, item.id, kind, null, now);
    await this.outbox.publish(tx, {
      aggregateType: 'assessment',
      aggregateId: session.id,
      eventType: 'assessment.item_excluded.v1',
      payload: { assessmentId: session.id, position: item.position, questionRevisionId: item.question_revision_id, reason: kind },
      idempotencyKey: `assessment.item_excluded.v1:${session.id}:${item.id}`,
    });
    if (allExcluded(items.map((i) => ({ excluded: !!i.excluded })))) await this.markInvalidated(tx, session, now);
  }

  private async markInvalidated(tx: Tx, session: any, now: Date): Promise<void> {
    await tx.assessment_session.update({ where: { id: session.id }, data: { status: 'INVALIDATED', last_activity_at: now } });
    await this.outbox.publish(tx, {
      aggregateType: 'assessment',
      aggregateId: session.id,
      eventType: 'assessment.invalidated.v1',
      payload: { assessmentId: session.id, studentId: session.student_id, mode: session.mode, reason: 'ALL_ITEMS_EXCLUDED' },
      idempotencyKey: `assessment.invalidated.v1:${session.id}`,
    });
  }

  private progress(items: any[]): ItemProgress[] {
    return items.map((i) => ({ position: i.position, state: i.response?.state ?? null, skipCount: i.response?.skip_count ?? 0, excluded: !!i.excluded }));
  }

  private baseView(session: any, items: any[], phase: AssessmentView['phase']): AssessmentView {
    return {
      assessmentId: session.id,
      mode: session.mode,
      status: session.status,
      expiresAt: session.expires_at.toISOString(),
      total: items.length,
      answered: items.filter((i) => !i.excluded && i.response?.state === 'LOCKED').length,
      removed: items.filter((i) => i.excluded).length,
      phase,
    };
  }

  private async event(tx: Tx, sessionId: string, itemId: string, type: string, activeMs: number | null, at: Date): Promise<void> {
    await tx.student_response_event.create({
      data: { session_id: sessionId, instance_question_id: itemId, event_type: type, active_ms: activeMs, occurred_at: at },
    });
  }

  private async lockResult(tx: Tx, mode: AssessmentMode, item: any, chosenPosition: number): Promise<LockResult> {
    if (!revealsAfterLock(mode)) return { locked: true };
    const rev = await tx.question_revision.findUnique({
      where: { id: item.question_revision_id },
      select: { explanation: true, options: { select: { position: true, is_correct: true } } },
    });
    const correctPosition = rev?.options.find((o) => o.is_correct)?.position;
    return {
      locked: true,
      reveal: {
        correct: correctPosition === chosenPosition,
        correctSlot: (item.option_order as number[]).indexOf(correctPosition as number),
        explanation: rev?.explanation ?? null,
      },
    };
  }
}
