import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';
import { DEFAULT_JURISDICTION } from '../student/student.service';
import {
  EXAM_CONFIG,
  InsufficientBankError,
  QUICK10,
  assembleQuick10,
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
  type PoolItem,
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

const SERVED_STATES = ['ACTIVE'] as const;
const DEV_STATES = ['DRAFT', 'AI_STRUCTURED', 'VALIDATION_PENDING', 'VALIDATED', 'ADMIN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'ACTIVE', 'ACTIVE_WITH_REVIEW'] as const;

export interface ExamUnitView {
  subjectVersionId: string;
  curriculumCode: string;
  versionLabel: string;
  gradeCode: string;
  subjectName: string;
  usableQuestions: number;
  ready: boolean;
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
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'VOID';
  expiresAt: string;
  total: number;
  answered: number;
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
  byDifficulty: Record<Difficulty, { total: number; correct: number }>;
  competitiveEligible: boolean;
  items: Array<{
    position: number;
    difficulty: Difficulty;
    stem: string;
    outcome: 'CORRECT' | 'INCORRECT' | 'UNANSWERED';
    explanation: string | null;
    options: Array<{ slot: number; text: string; isCorrect: boolean; chosen: boolean }>;
  }>;
}

export interface AssessmentSummaryRow {
  assessmentId: string;
  mode: AssessmentMode;
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'VOID';
  subjectName: string;
  gradeCode: string;
  startedAt: string;
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
  ) {}

  // ── discovery ────────────────────────────────────────────────────────────

  async listUnits(accountId: string): Promise<ExamUnitView[]> {
    const studentId = await this.gate(accountId);
    const db = this.db.client as unknown as Tx;
    const rows = await db.curriculum_subject_version.findMany({
      where: { state: { in: this.servedStates() } },
      orderBy: { revision: 'desc' },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    const seen = new Set<string>();
    const units: ExamUnitView[] = [];
    for (const r of rows) {
      const key = `${r.curriculum_version_id}|${r.grade_id}|${r.subject_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const pool = await this.loadPool(db, r, studentId);
      units.push({
        subjectVersionId: r.id,
        curriculumCode: r.curriculum_version.curriculum.code,
        versionLabel: r.curriculum_version.label,
        gradeCode: r.grade.code,
        subjectName: r.subject.name,
        usableQuestions: pool.items.length,
        ready: pool.items.length >= QUICK10.total,
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
      subjectName: subjects.find((x) => x.id === s.instance.subject_id)?.name ?? '',
      gradeCode: grades.find((x) => x.id === s.instance.grade_id)?.code ?? '',
      startedAt: s.started_at.toISOString(),
      expiresAt: s.expires_at.toISOString(),
      correct: s.result?.correct ?? null,
      total: s.result?.total ?? null,
    }));
  }

  // ── create ───────────────────────────────────────────────────────────────

  /** Builds and locks a test. If the student already has one open for this subject and mode, returns that. */
  async create(
    accountId: string,
    input: { subjectVersionId: string; mode: string },
  ): Promise<{ assessmentId: string; resumed: boolean }> {
    if (input.mode !== 'TEST' && input.mode !== 'PRACTICE') throw new ExamInputError('mode must be TEST or PRACTICE');
    const mode = input.mode as AssessmentMode;
    const studentId = await this.gate(accountId);

    return this.db.client.$transaction(async (tx: Tx) => {
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
      const now = new Date();

      const unit = await tx.curriculum_subject_version.findUnique({ where: { id: input.subjectVersionId } });
      if (!unit) throw new ExamNotFoundError('Subject not found');
      if (!this.servedStates().includes(unit.state)) throw new ExamUnavailableError('This subject is not open for tests yet');
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

      const open = await tx.assessment_session.findMany({
        where: { student_id: studentId, status: 'IN_PROGRESS' },
        include: { instance: { include: { items: { include: { response: true } } } } },
      });
      for (const s of open) {
        if (s.expires_at <= now) await this.settleExpired(tx, s, now);
        else if (
          s.mode === mode &&
          s.instance.curriculum_version_id === unit.curriculum_version_id &&
          s.instance.grade_id === unit.grade_id &&
          s.instance.subject_id === unit.subject_id
        ) {
          return { assessmentId: s.id, resumed: true };
        }
      }

      const pool = await this.loadPool(tx, unit, studentId);
      const seedUsed = newSeed();
      let assembled;
      try {
        assembled = assembleQuick10(pool.items, seedUsed);
      } catch (e) {
        if (e instanceof InsufficientBankError) throw new ExamUnavailableError('There are not enough approved questions for this subject yet');
        throw e;
      }
      const instance = await tx.assessment_instance.create({
        data: {
          student_id: studentId,
          mode,
          blueprint_code: QUICK10.code,
          blueprint_version: QUICK10.version,
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
        },
        select: { id: true },
      });
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
          payload: { assessmentId: session.id, studentId, mode, blueprint: QUICK10.code },
          idempotencyKey: `${eventType}:${session.id}`,
        });
      }
      return { assessmentId: session.id, resumed: false };
    });
  }

  // ── take the test ─────────────────────────────────────────────────────────

  /** Shows the current question (or the summary). Safe to call again after a refresh. */
  async present(accountId: string, assessmentId: string): Promise<AssessmentView> {
    const studentId = await this.gate(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      const now = new Date();
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) await this.settleExpired(tx, { ...session, instance: { items } }, now);
      const fresh = await this.reload(tx, studentId, assessmentId);
      if (fresh.session.status !== 'IN_PROGRESS') return this.baseView(fresh.session, fresh.items, 'ENDED');

      const step = nextStep(this.progress(fresh.items), fresh.session.revisit_used);
      if (step.kind === 'SUMMARY') {
        return { ...this.baseView(fresh.session, fresh.items, 'SUMMARY'), summary: { answered: step.answered, unanswered: step.unanswered, canReviewSkipped: step.canReviewSkipped } };
      }
      const item = fresh.items.find((i) => i.position === step.position)!;
      const first = !item.response;
      if (first) {
        await tx.student_response.create({ data: { session_id: session.id, instance_question_id: item.id, presented_at: now } });
        await tx.student_question_exposure.upsert({
          where: { student_id_question_id: { student_id: studentId, question_id: item.question_id } },
          create: { student_id: studentId, question_id: item.question_id },
          update: { last_seen_at: now, times_seen: { increment: 1 } },
        });
        await this.event(tx, session.id, item.id, 'PRESENTED', null, now);
      } else if (item.response!.state === 'SKIPPED') {
        await tx.student_response.update({ where: { id: item.response!.id }, data: { presented_at: now } });
        await this.event(tx, session.id, item.id, 'PRESENTED', null, now);
      } else if (!item.response!.presented_at) {
        await tx.student_response.update({ where: { id: item.response!.id }, data: { presented_at: now } });
      }
      // Deliberately selects no is_correct and no explanation.
      const rev = await tx.question_revision.findUnique({
        where: { id: item.question_revision_id },
        select: { stem: true, options: { select: { position: true, text: true } } },
      });
      if (!rev) throw new ExamNotFoundError('Question missing');
      const byPosition = new Map(rev.options.map((o) => [o.position, o.text]));
      return {
        ...this.baseView(fresh.session, fresh.items, 'QUESTION'),
        question: {
          position: item.position,
          total: fresh.items.length,
          pass: step.pass,
          stem: rev.stem,
          options: item.option_order.map((pos, slot) => ({ slot, text: byPosition.get(pos) ?? '' })),
        },
      };
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
        await this.settleExpired(tx, { ...session, instance: { items } }, now);
        return EXPIRED;
      }
      const item = items.find((i) => i.position === position);
      if (!item) throw new ExamNotFoundError('No such question');
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
    return out;
  }

  async skip(accountId: string, assessmentId: string, position: number, input: { activeMs: unknown }): Promise<{ skipped: true }> {
    const studentId = await this.gate(accountId);
    const out = await this.db.client.$transaction(async (tx: Tx) => {
      const { session, items } = await this.open(tx, studentId, assessmentId);
      const now = new Date();
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) {
        await this.settleExpired(tx, { ...session, instance: { items } }, now);
        return EXPIRED;
      }
      if (session.status !== 'IN_PROGRESS') throw new ExamConflictError('This assessment has ended');
      const item = items.find((i) => i.position === position);
      if (!item) throw new ExamNotFoundError('No such question');
      const step = nextStep(this.progress(items), session.revisit_used);
      if (step.kind !== 'ITEM' || step.position !== position) throw new ExamConflictError('That is not the current question');

      const activeMs = clampActiveMs(input.activeMs);
      const skipCount = (item.response?.skip_count ?? 0) + 1;
      const data = { state: 'SKIPPED' as const, skip_count: skipCount, active_ms: activeMs };
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
      const now = new Date();
      if (session.expires_at <= now) {
        await this.settleExpired(tx, { ...session, instance: { items } }, now);
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
      byDifficulty: session.result.by_difficulty as ResultView['byDifficulty'],
      competitiveEligible: session.result.competitive_eligible,
      items: session.instance.items.map((i) => {
        const rev = revisions.find((r) => r.id === i.question_revision_id)!;
        const byPos = new Map<number, { text: string; is_correct: boolean }>(rev.options.map((o: { position: number; text: string; is_correct: boolean }) => [o.position, o]));
        const locked = i.response?.state === 'LOCKED';
        return {
          position: i.position,
          difficulty: i.difficulty,
          stem: rev.stem,
          outcome: !locked ? 'UNANSWERED' : i.response?.is_correct ? 'CORRECT' : 'INCORRECT',
          explanation: rev.explanation,
          options: i.option_order.map((pos, slot) => ({
            slot,
            text: byPos.get(pos)?.text ?? '',
            isCorrect: byPos.get(pos)?.is_correct === true,
            chosen: locked && i.response?.selected_slot === slot,
          })),
        };
      }),
    };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private servedStates() {
    return (this.config.allowUnactivatedCurriculum ? [...DEV_STATES] : [...SERVED_STATES]) as any[];
  }

  /** The account's own student, who must be age-classified and not awaiting guardian consent. Fails closed. */
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

  /** Approved and published questions of the unit whose objective still exists in this curriculum revision. */
  private async loadPool(
    db: Tx,
    unit: { id: string; curriculum_version_id: string; grade_id: string; subject_id: string },
    studentId: string,
  ): Promise<{ items: PoolItem[]; excluded: number }> {
    const chapters = await db.chapter.findMany({
      where: { subject_version_id: unit.id },
      select: { code: true, topics: { select: { code: true, micro_concepts: { select: { code: true, learning_objectives: { select: { code: true } } } } } } },
    });
    const paths = new Set<string>();
    for (const c of chapters) for (const t of c.topics) for (const m of t.micro_concepts) for (const o of m.learning_objectives) paths.add(`${c.code}/${t.code}/${m.code}/${o.code}`);

    const revs = await db.question_revision.findMany({
      where: {
        state: 'APPROVED',
        // Approved is not published: only a version a person has published is served, and not one marked DEGRADED.
        publication: { is: { state: 'PUBLISHED' } },
        question: {
          curriculum_version_id: unit.curriculum_version_id, grade_id: unit.grade_id, subject_id: unit.subject_id,
          NOT: { bank_state: { is: { health: 'DEGRADED' } } },
        },
      },
      select: { id: true, difficulty: true, stem_hash: true, question: { select: { id: true, objective_path: true } } },
    });
    const usable = revs.filter((r) => paths.has(r.question.objective_path));
    const exposures = await db.student_question_exposure.findMany({
      where: { student_id: studentId, question_id: { in: usable.map((r) => r.question.id) } },
      select: { question_id: true, last_seen_at: true },
    });
    const seen = new Map(exposures.map((e) => [e.question_id, e.last_seen_at]));
    return {
      items: usable.map((r) => ({
        revisionId: r.id,
        questionId: r.question.id,
        objectivePath: r.question.objective_path,
        difficulty: r.difficulty,
        stemHash: r.stem_hash,
        lastSeenAt: seen.get(r.question.id) ?? null,
      })),
      excluded: revs.length - usable.length,
    };
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
      if (session.status === 'IN_PROGRESS' && session.expires_at <= now) await this.settleExpired(tx, { ...session, instance: { items } }, now);
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
    }
  }

  private async finalize(tx: Tx, session: any, items: any[], reason: 'STUDENT' | 'EXPIRED', now: Date): Promise<void> {
    const score = scoreAssessment(
      items.map((i) => ({ difficulty: i.difficulty, locked: i.response?.state === 'LOCKED', isCorrect: i.response?.is_correct ?? null })),
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
        scoring_policy: QUICK10.scoringPolicy,
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

  private progress(items: any[]): ItemProgress[] {
    return items.map((i) => ({ position: i.position, state: i.response?.state ?? null, skipCount: i.response?.skip_count ?? 0 }));
  }

  private baseView(session: any, items: any[], phase: AssessmentView['phase']): AssessmentView {
    return {
      assessmentId: session.id,
      mode: session.mode,
      status: session.status,
      expiresAt: session.expires_at.toISOString(),
      total: items.length,
      answered: items.filter((i) => i.response?.state === 'LOCKED').length,
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
