import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { AI_QUESTION_ACTOR } from '../question/import/ai-question-import';
import { runDeterministicChecks, assessConfidence, ROUTE_THRESHOLDS, type Route } from '../question/question-governance';
import { stemHash, type QuestionCognitive, type QuestionDifficulty, type QuestionDraft } from '../question/question-domain';
import { QuestionService, type UnitIdentity } from '../question/question.service';
import { AiGateway, BudgetExceededError } from './ai-gateway';
import {
  AI_ROLES,
  CONFIG_VERSION,
  FactoryRequestError,
  JUDGES,
  assertFactoryMayRun,
  breakerReason,
  buildEvidence,
  dailyCellRoom,
  nextStep,
  noveltyScore,
  parseCandidate,
  parseSolverAnswer,
  parseVerdict,
  validateRequest,
  type Candidate,
  type FactoryConfig,
  type RawEvidence,
  type Verdict,
} from './factory-domain';
import { generatorPrompt, judgePrompt, solverPrompt, type CellContext } from './prompts';

export interface RunInput {
  curriculumCode: string;
  gradeCode: string;
  subjectCode: string;
  objectiveCode: string;
  difficulty: QuestionDifficulty;
  cognitive: QuestionCognitive;
  count: number;
  operator: string;
}

export interface BatchSummary {
  batchId: string;
  status: 'COMPLETED' | 'STOPPED';
  stopReason: string | null;
  requested: number;
  attempted: number;
  draftsStored: number;
  rejected: number;
  duplicates: number;
  failed: number;
  routes: Record<string, number>;
}

type Outcome = 'DRAFT_STORED' | 'REJECTED_STRUCTURE' | 'REJECTED_DUPLICATE' | 'REJECTED_QUALITY' | 'FAILED_VALIDATION' | 'FAILED_GENERATION';

interface AttemptResult {
  outcome: Outcome;
  route: Route | null;
  confidence: number | null;
  repairs: number;
  candidate: unknown;
  evidence: unknown;
  revisionId: string | null;
  note: string | null;
}

/**
 * Runs one batch for one cell: generate, check automatically, have independent validators judge, route, repair
 * at most twice, and store what is usable as a DRAFT for a person. Nothing is approved, published or activated.
 * The operator chose the cell; this never decides demand.
 */
@Injectable()
export class FactoryService {
  constructor(
    private readonly db: DatabaseService,
    private readonly questions: QuestionService,
    private readonly gateway: AiGateway,
    private readonly config: FactoryConfig,
  ) {}

  async runBatch(input: RunInput): Promise<BatchSummary> {
    assertFactoryMayRun(this.config);
    validateRequest(input);
    const db = this.db.client as any;

    const unit = await this.resolveUnit(input);
    const { context, objectivePath } = await this.resolveCell(unit, input);

    const dayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const today = await db.generation_attempt.count({
      where: {
        created_at: { gte: dayStart },
        batch: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId, objective_path: objectivePath, difficulty: input.difficulty, cognitive: input.cognitive },
      },
    });
    const room = dailyCellRoom(today);
    if (input.count > room) throw new FactoryRequestError(`this cell has room for ${room} more candidates today (limit and ${today} already tried); ask for ${room} or fewer, or wait until tomorrow (UTC)`);

    const existingRows: any[] = await db.question_revision.findMany({
      where: { state: { not: 'SUPERSEDED' }, question: { curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId } },
      select: { stem: true, question: { select: { objective_path: true } } },
      take: 5000,
    });
    const unitHashes = new Set<string>(existingRows.map((r) => stemHash(r.stem)));
    const cellStems: string[] = existingRows.filter((r) => r.question.objective_path === objectivePath).map((r) => r.stem as string);

    const batch = await db.generation_batch.create({
      data: {
        curriculum_version_id: unit.curriculumVersionId, grade_id: unit.gradeId, subject_id: unit.subjectId, objective_path: objectivePath,
        difficulty: input.difficulty, cognitive: input.cognitive, requested_count: input.count, requested_by: input.operator,
        provider: this.gateway.providerName, model: this.gateway.modelName, config_version: CONFIG_VERSION,
      },
      select: { id: true },
    });
    const batchId = batch.id as string;
    const aiSource = `factory batch ${batchId}; ${this.gateway.providerName}/${this.gateway.modelName}`.slice(0, 255);

    const tally = { attempted: 0, stored: 0, duplicates: 0, rejected: 0, failed: 0 };
    const routes: Record<string, number> = {};
    let stopReason: string | null = null;

    try {
      for (let seq = 1; seq <= input.count; seq++) {
        const status = (await db.generation_batch.findUnique({ where: { id: batchId }, select: { status: true } }))?.status;
        if (status === 'STOP_REQUESTED') {
          stopReason = 'stopped by an operator';
          break;
        }
        const breaker = breakerReason({ attempted: tally.attempted, stored: tally.stored, duplicates: tally.duplicates });
        if (breaker) {
          stopReason = breaker;
          break;
        }

        const r = await this.attempt({ batchId, seq, unit, context, input, objectivePath, aiSource, unitHashes, cellStems });
        tally.attempted++;
        if (r.outcome === 'DRAFT_STORED') tally.stored++;
        else if (r.outcome === 'REJECTED_DUPLICATE') tally.duplicates++;
        else if (r.outcome === 'FAILED_GENERATION' || r.outcome === 'FAILED_VALIDATION') tally.failed++;
        else tally.rejected++;
        if (r.route) routes[r.route] = (routes[r.route] ?? 0) + 1;

        await db.generation_attempt.create({
          data: {
            batch_id: batchId, sequence: seq, outcome: r.outcome, route: r.route, confidence: r.confidence, repairs: r.repairs,
            candidate: r.candidate ?? undefined, evidence: r.evidence ?? undefined, question_revision_id: r.revisionId, note: r.note?.slice(0, 500) ?? null,
          },
        });
        await db.generation_batch.update({
          where: { id: batchId },
          data: { drafts_stored: tally.stored, rejected: tally.rejected, duplicates: tally.duplicates, failed: tally.failed },
        });
      }
    } catch (e) {
      if (e instanceof BudgetExceededError) stopReason = e.message;
      else {
        await db.generation_batch.update({ where: { id: batchId }, data: { status: 'STOPPED', stop_reason: `unexpected error: ${(e as Error).message}`.slice(0, 255), finished_at: new Date() } });
        throw e;
      }
    }

    const status = stopReason ? 'STOPPED' : 'COMPLETED';
    await db.generation_batch.update({ where: { id: batchId }, data: { status, stop_reason: stopReason?.slice(0, 255) ?? null, finished_at: new Date() } });
    return {
      batchId, status, stopReason, requested: input.count, attempted: tally.attempted, draftsStored: tally.stored,
      rejected: tally.rejected, duplicates: tally.duplicates, failed: tally.failed, routes,
    };
  }

  // ------------------------------------------------------------ one candidate

  private async attempt(a: {
    batchId: string; seq: number; unit: UnitIdentity; context: CellContext; input: RunInput; objectivePath: string;
    aiSource: string; unitHashes: Set<string>; cellStems: string[];
  }): Promise<AttemptResult> {
    const fail = (outcome: Outcome, note: string, extra: Partial<AttemptResult> = {}): AttemptResult => ({
      outcome, route: null, confidence: null, repairs: 0, candidate: null, evidence: null, revisionId: null, note, ...extra,
    });
    const ctx = { batchId: a.batchId, attemptSeq: a.seq };

    const gen = await this.gateway.call('QUESTION_GENERATOR', generatorPrompt(a.context, a.cellStems.slice(-30)), parseCandidate, ctx);
    if (!gen.ok) return fail('FAILED_GENERATION', `generator: ${gen.detail}`);
    let cand: Candidate = gen.value;
    let repairs = 0;

    for (;;) {
      const draft = this.draftOf(a, cand);
      const check = runDeterministicChecks(draft);
      if (!check.passed) return fail('REJECTED_STRUCTURE', check.findings.filter((f) => f.severity === 'CRITICAL').map((f) => f.message).join('; '), { candidate: draft, repairs, evidence: { deterministic: check } });
      if (a.unitHashes.has(stemHash(cand.stem))) return fail('REJECTED_DUPLICATE', 'the same wording already exists in this unit', { candidate: draft, repairs });

      const raw = await this.validate(a, cand);
      if (!raw.ok) return fail('FAILED_VALIDATION', raw.note, { candidate: draft, repairs });
      const built = buildEvidence(raw.raw, ROUTE_THRESHOLDS.green);
      const assessed = assessConfidence(built.evidence);
      const step = nextStep(assessed.route, repairs);
      const evidence = { scores: built.evidence.scores, gates: built.evidence.criticalGates, conflict: built.evidence.unresolvedConflict, repairable: built.evidence.repairable, issues: built.issues, reason: assessed.reason };

      if (step === 'FAIL') return fail('FAILED_VALIDATION', assessed.reason, { candidate: draft, repairs, evidence });
      if (step === 'REJECT') return { outcome: 'REJECTED_QUALITY', route: assessed.route, confidence: assessed.score, repairs, candidate: draft, evidence, revisionId: null, note: assessed.reason };
      if (step === 'REPAIR') {
        const rep = await this.gateway.call('QUESTION_GENERATOR', generatorPrompt(a.context, a.cellStems.slice(-30), { previous: cand, issues: built.issues.map((i) => i.message) }), parseCandidate, ctx);
        if (!rep.ok) return fail('FAILED_GENERATION', `repair: ${rep.detail}`, { candidate: draft, repairs, evidence });
        cand = rep.value;
        repairs++;
        continue;
      }

      const stored = await this.store(a, draft);
      if (!stored.ok) return { outcome: 'REJECTED_STRUCTURE', route: assessed.route, confidence: assessed.score, repairs, candidate: draft, evidence, revisionId: null, note: stored.note };
      a.unitHashes.add(stemHash(cand.stem));
      a.cellStems.push(cand.stem);
      return {
        outcome: 'DRAFT_STORED', route: assessed.route, confidence: assessed.score, repairs, candidate: draft,
        evidence: { ...evidence, needsAttention: step === 'STORE_FLAGGED' }, revisionId: stored.revisionId, note: step === 'STORE_FLAGGED' ? 'needs a closer look from a person' : null,
      };
    }
  }

  private draftOf(a: { input: RunInput; batchId: string; seq: number }, c: Candidate): QuestionDraft {
    return {
      code: `AI-${a.batchId.slice(0, 8)}-${a.seq}`.toUpperCase(),
      objectiveCode: a.input.objectiveCode,
      stem: c.stem,
      options: c.options,
      correctIndex: c.correctIndex,
      difficulty: a.input.difficulty,
      cognitive: a.input.cognitive,
      explanation: c.explanation,
    };
  }

  /** The blind solver and every reviewer run on their own; the solver is never shown the key. */
  private async validate(
    a: { batchId: string; seq: number; context: CellContext; cellStems: string[] },
    c: Candidate,
  ): Promise<{ ok: true; raw: RawEvidence } | { ok: false; note: string }> {
    const ctx = { batchId: a.batchId, attemptSeq: a.seq };
    const passes = Array.from({ length: this.config.solverPasses }, () => this.gateway.call('ANSWER_SOLVER', solverPrompt(c), parseSolverAnswer, ctx));
    const roles = [...JUDGES.map((j) => j.role), 'ADVERSARIAL_REVIEWER' as const];
    const judged = roles.map((role) => this.gateway.call(role, judgePrompt(role as any, a.context, c), parseVerdict, ctx));
    const [solved, verdicts] = await Promise.all([Promise.all(passes), Promise.all(judged)]);

    for (const s of solved) if (!s.ok) return { ok: false, note: `ANSWER_SOLVER: ${s.detail}` };
    const byRole: Partial<Record<(typeof AI_ROLES)[number], Verdict>> = {};
    for (let i = 0; i < roles.length; i++) {
      const v = verdicts[i];
      if (!v.ok) return { ok: false, note: `${roles[i]}: ${v.detail}` };
      byRole[roles[i]] = v.value;
    }
    return {
      ok: true,
      raw: {
        solverAnswers: solved.map((s) => (s as { ok: true; value: number | null }).value),
        keyIndex: c.correctIndex,
        verdicts: byRole,
        novelty: noveltyScore(`${c.stem} ${c.options.join(' ')}`, a.cellStems),
      },
    };
  }

  /** Goes through the normal question path as an AI draft: a person must submit it and a different person approve it. */
  private async store(
    a: { unit: UnitIdentity; aiSource: string },
    draft: QuestionDraft,
  ): Promise<{ ok: true; revisionId: string } | { ok: false; note: string }> {
    const plan = await this.questions.plan(a.unit, { questions: [{ where: 'factory', draft }], issues: [], header: null });
    if (plan.issues.length) return { ok: false, note: plan.issues.map((i) => i.message).join('; ') };
    await this.questions.apply(a.unit, plan, { actor: AI_QUESTION_ACTOR, origin: 'AI_DRAFT', aiSource: a.aiSource });
    const revisionId = await this.questions.revisionIdByCode(a.unit, draft.code);
    return revisionId ? { ok: true, revisionId } : { ok: false, note: 'the draft was written but could not be found again' };
  }

  // -------------------------------------------------------------- resolving

  private async resolveUnit(i: RunInput): Promise<UnitIdentity> {
    const row = await (this.db.client as any).curriculum_subject_version.findFirst({
      where: { grade: { code: i.gradeCode }, subject: { code: i.subjectCode }, curriculum_version: { curriculum: { code: i.curriculumCode } } },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    if (!row) throw new FactoryRequestError('No curriculum found for that curriculum, grade and subject');
    return this.questions.unitIdentity(row.id);
  }

  private async resolveCell(unit: UnitIdentity, i: RunInput): Promise<{ context: CellContext; objectivePath: string }> {
    const db = this.db.client as any;
    const [sv, chapters] = await Promise.all([
      db.curriculum_subject_version.findUnique({ where: { id: unit.latestRevisionId }, include: { subject: true, grade: true } }),
      db.chapter.findMany({
        where: { subject_version_id: unit.latestRevisionId },
        include: { topics: { include: { micro_concepts: { include: { learning_objectives: true } } } } },
      }),
    ]);
    const hits: Array<{ path: string; ctx: Pick<CellContext, 'chapter' | 'topic' | 'concept' | 'objective'> }> = [];
    for (const c of chapters) for (const t of c.topics) for (const m of t.micro_concepts) for (const o of m.learning_objectives) {
      if (o.code === i.objectiveCode) hits.push({ path: `${c.code}/${t.code}/${m.code}/${o.code}`, ctx: { chapter: c.title, topic: t.title, concept: m.title, objective: o.statement } });
    }
    if (hits.length === 0) throw new FactoryRequestError(`objective ${i.objectiveCode} does not exist in this unit's curriculum`);
    if (hits.length > 1) throw new FactoryRequestError(`objective code ${i.objectiveCode} is used more than once in this unit, so it is ambiguous`);
    return {
      objectivePath: hits[0].path,
      context: { curriculum: i.curriculumCode, grade: sv.grade.code, subject: sv.subject.name, difficulty: i.difficulty, cognitive: i.cognitive, ...hits[0].ctx },
    };
  }

  // --------------------------------------------------------------- reporting

  async requestStop(batchId: string): Promise<boolean> {
    const r = await (this.db.client as any).generation_batch.updateMany({ where: { id: batchId, status: 'RUNNING' }, data: { status: 'STOP_REQUESTED' } });
    return r.count > 0;
  }

  async listBatches(limit = 20): Promise<Array<{ id: string; startedAt: Date; status: string; objectivePath: string; difficulty: string; cognitive: string; requested: number; stored: number; rejected: number; duplicates: number; failed: number; provider: string }>> {
    const rows: any[] = await (this.db.client as any).generation_batch.findMany({ orderBy: { started_at: 'desc' }, take: limit });
    return rows.map((b) => ({
      id: b.id, startedAt: b.started_at, status: b.status, objectivePath: b.objective_path, difficulty: b.difficulty, cognitive: b.cognitive,
      requested: b.requested_count, stored: b.drafts_stored, rejected: b.rejected, duplicates: b.duplicates, failed: b.failed, provider: `${b.provider}/${b.model}`,
    }));
  }

  async showBatch(batchId: string) {
    const db = this.db.client as any;
    const b = await db.generation_batch.findUnique({ where: { id: batchId }, include: { attempts: { orderBy: { sequence: 'asc' } } } });
    if (!b) throw new FactoryRequestError('No such batch');
    const tokens: any[] = await db.ai_call_log.groupBy({ by: ['status'], where: { batch_id: batchId }, _count: { _all: true }, _sum: { tokens_in: true, tokens_out: true } });
    return { batch: b, calls: tokens };
  }
}
