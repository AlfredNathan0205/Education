import { Injectable } from '@nestjs/common';
import { AuthzService } from '../authz/authz.service';
import { CoverageService } from '../bank-coverage/coverage.service';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { COGNITIVE_LEVELS, DIFFICULTIES, type QuestionCognitive, type QuestionDifficulty } from '../question/question-domain';
import { AiGateway, BudgetExceededError } from './ai-gateway';
import { createAiProvider } from './ai-provider';
import { FactoryDisabledError, FactoryRequestError, assertFactoryMayRun, loadFactoryConfig, type FactoryConfig } from './factory-domain';
import { FactoryService, type BatchSummary } from './factory.service';
import { QuestionService } from '../question/question.service';

type Db = any;
const EDIT = ['EDITOR', 'SUPER_ADMIN'];
/** From the page, a batch is small: it runs while the person waits. Larger runs stay with the CLI. */
export const PAGE_MAX_COUNT = 10;
export const DEFAULT_TARGET = 8;

export interface FactoryStatus {
  available: boolean;
  /** Why drafting cannot run here, in plain words, when it cannot. */
  reason: string | null;
  provider: string | null;
  dailyTokenBudget: number | null;
  tokensUsedToday: number;
}

/**
 * Step 22: AI question drafting from the admin page. The factory itself is unchanged (Step 8): every draft is an
 * AI_DRAFT question in DRAFT that a person must submit and a different person approve. This adds the page's view:
 * whether drafting is available, which cells are short (the coverage report), small batches, and stopping a batch.
 */
@Injectable()
export class AdminFactoryService {
  private readonly config: FactoryConfig;
  private readonly unavailable: string | null;
  private readonly factory: FactoryService;

  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService, questions: QuestionService, private readonly coverage: CoverageService) {
    this.config = loadFactoryConfig(process.env);
    let gateway: AiGateway | undefined;
    let reason: string | null = null;
    try {
      const budget = assertFactoryMayRun(this.config);
      gateway = new AiGateway(createAiProvider(process.env), (db as any).client, { dailyTokenBudget: budget, timeoutMs: this.config.callTimeoutMs });
    } catch (e) {
      reason = e instanceof FactoryDisabledError ? e.message : `AI drafting is not set up here: ${(e as Error).message}`;
    }
    this.unavailable = reason;
    this.factory = new FactoryService(db, questions, gateway as AiGateway, this.config);
  }

  async status(accountId: string, now = new Date()): Promise<FactoryStatus> {
    await this.roles(accountId);
    const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const used = await (this.db.client as Db).ai_call_log.aggregate({ where: { created_at: { gte: day } }, _sum: { tokens_in: true, tokens_out: true } });
    return {
      available: this.unavailable === null,
      reason: this.unavailable,
      provider: this.unavailable === null ? (process.env.AI_PROVIDER ?? null) : null,
      dailyTokenBudget: this.config.dailyTokenBudget,
      tokensUsedToday: (used?._sum?.tokens_in ?? 0) + (used?._sum?.tokens_out ?? 0),
    };
  }

  /** The objective × difficulty cells furthest below a target, and how many drafts each could take. */
  async suggestions(accountId: string, unitId: string, targetRaw: unknown) {
    await this.roles(accountId);
    const target = targetRaw === undefined || targetRaw === '' ? DEFAULT_TARGET : Number(targetRaw);
    if (!Number.isInteger(target) || target < 1 || target > 100) throw new ExamInputError('The target must be a whole number from 1 to 100');
    const unit = await this.unit(unitId);
    const report = await this.coverage.report({ ...unit, targetPerCell: target });
    return {
      target,
      cells: report.cells
        .filter((c) => c.requestable > 0)
        .slice(0, 40)
        .map((c) => ({ objectivePath: c.objectivePath, objectiveCode: c.objectivePath.split('/').pop() as string, difficulty: c.difficulty, approved: c.approved, inPipeline: c.inPipeline, requestable: c.requestable })),
    };
  }

  async run(accountId: string, raw: unknown): Promise<BatchSummary> {
    const roles = await this.roles(accountId);
    if (!roles.some((r) => EDIT.includes(r))) throw new ExamNotPermittedError('Only an editor can start AI drafting');
    if (this.unavailable) throw new ExamConflictError(this.unavailable);
    const b = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
    if (typeof b.unitId !== 'string') throw new ExamInputError('Choose a subject');
    if (typeof b.objectiveCode !== 'string' || !b.objectiveCode.trim()) throw new ExamInputError('Choose an objective');
    if (!(DIFFICULTIES as readonly string[]).includes(b.difficulty as string)) throw new ExamInputError('Choose EASY, MEDIUM or HARD');
    if (!(COGNITIVE_LEVELS as readonly string[]).includes(b.cognitive as string)) throw new ExamInputError('Choose a cognitive level, C1 to C4');
    const count = Number(b.count);
    if (!Number.isInteger(count) || count < 1 || count > PAGE_MAX_COUNT) throw new ExamInputError(`From this page, ask for 1 to ${PAGE_MAX_COUNT} drafts at a time`);
    const unit = await this.unit(b.unitId);
    const operator = (await (this.db.client as Db).authentication_identity.findFirst({ where: { account_id: accountId, kind: 'EMAIL' }, select: { identifier_normalized: true } }))?.identifier_normalized ?? accountId;
    try {
      const summary = await this.factory.runBatch({ ...unit, objectiveCode: b.objectiveCode.trim(), difficulty: b.difficulty as QuestionDifficulty, cognitive: b.cognitive as QuestionCognitive, count, operator });
      await (this.db.client as Db).audit_event.create({ data: { actor_account_id: accountId, action: 'factory.batch_run', subject_type: 'generation_batch', subject_id: summary.batchId, metadata: { objectiveCode: b.objectiveCode, difficulty: b.difficulty, cognitive: b.cognitive, count, stored: summary.draftsStored } } });
      return summary;
    } catch (e) {
      if (e instanceof FactoryRequestError || e instanceof FactoryDisabledError || e instanceof BudgetExceededError) throw new ExamConflictError(e.message);
      throw e;
    }
  }

  async batches(accountId: string) {
    await this.roles(accountId);
    return this.factory.listBatches(20);
  }

  async stop(accountId: string, batchId: string): Promise<{ stopping: boolean }> {
    const roles = await this.roles(accountId);
    if (!roles.some((r) => EDIT.includes(r))) throw new ExamNotPermittedError('Only an editor can stop AI drafting');
    return { stopping: await this.factory.requestStop(batchId) };
  }

  private async unit(unitId: string): Promise<{ curriculumCode: string; gradeCode: string; subjectCode: string }> {
    const sv = await (this.db.client as Db).curriculum_subject_version.findUnique({ where: { id: unitId }, include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true } });
    if (!sv) throw new ExamNotFoundError('Subject not found');
    return { curriculumCode: sv.curriculum_version.curriculum.code, gradeCode: sv.grade.code, subjectCode: sv.subject.code };
  }

  private async roles(accountId: string): Promise<string[]> {
    const roles = await this.authz.curriculumRolesFor(accountId);
    if (!roles.length) throw new ExamNotPermittedError('Only curriculum staff may use AI drafting');
    return roles;
  }
}
