import { createHash } from 'node:crypto';
import type { AiProvider } from './ai-provider';
import { SCHEMA_VERSION, PROMPT_VERSION, type AiRole } from './factory-domain';
import type { Prompt } from './prompts';

export class BudgetExceededError extends Error {
  constructor(used: number, budget: number) {
    super(`the daily token budget is used up (${used} of ${budget})`);
    this.name = 'BudgetExceededError';
  }
}

export type CallResult<T> = { ok: true; value: T } | { ok: false; kind: 'INVALID_OUTPUT' | 'ERROR'; detail: string };

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

interface Db {
  ai_call_log: { create(a: any): Promise<unknown> };
  $queryRaw: (...a: any[]) => Promise<any>;
}

/**
 * Every model call in the system goes through here. It enforces the daily token budget, applies a timeout,
 * checks the reply against the role's expected shape, and records the call (role, model, versions, hashes,
 * latency, status, tokens). The record holds hashes, not the text of the question or the reply.
 */
export class AiGateway {
  constructor(
    private readonly provider: AiProvider,
    private readonly db: Db,
    private readonly opts: { dailyTokenBudget: number; timeoutMs: number },
  ) {}

  get providerName(): string {
    return this.provider.name;
  }
  get modelName(): string {
    return this.provider.model;
  }

  async tokensUsedToday(): Promise<number> {
    const rows: Array<{ used: bigint | number | null }> = await this.db.$queryRaw`
      SELECT COALESCE(SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)), 0) AS used
      FROM ai_call_log
      WHERE created_at >= date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`;
    return Number(rows[0]?.used ?? 0);
  }

  async call<T>(
    role: AiRole,
    prompt: Prompt,
    parse: (text: string) => T,
    ctx: { batchId: string; attemptSeq: number | null; maxOutputTokens?: number },
  ): Promise<CallResult<T>> {
    const used = await this.tokensUsedToday();
    if (used >= this.opts.dailyTokenBudget) throw new BudgetExceededError(used, this.opts.dailyTokenBudget);

    const started = Date.now();
    const base = {
      batch_id: ctx.batchId,
      attempt_seq: ctx.attemptSeq,
      role,
      provider: this.provider.name,
      model: this.provider.model,
      prompt_version: PROMPT_VERSION,
      schema_version: SCHEMA_VERSION,
      input_hash: sha(`${prompt.system}\n${prompt.user}`),
    };
    let text: string;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    try {
      const res = await this.withTimeout(this.provider.complete({ role, system: prompt.system, user: prompt.user, maxOutputTokens: ctx.maxOutputTokens ?? 1500 }));
      text = res.text;
      tokensIn = res.tokensIn;
      tokensOut = res.tokensOut;
    } catch (e) {
      const detail = `${(e as Error).name}: ${(e as Error).message}`.slice(0, 300);
      await this.db.ai_call_log.create({ data: { ...base, latency_ms: Date.now() - started, status: 'ERROR', detail } });
      return { ok: false, kind: 'ERROR', detail };
    }
    try {
      const value = parse(text);
      await this.db.ai_call_log.create({ data: { ...base, output_hash: sha(text), latency_ms: Date.now() - started, status: 'OK', tokens_in: tokensIn, tokens_out: tokensOut } });
      return { ok: true, value };
    } catch (e) {
      const detail = (e as Error).message.slice(0, 300);
      await this.db.ai_call_log.create({ data: { ...base, output_hash: sha(text), latency_ms: Date.now() - started, status: 'INVALID_OUTPUT', detail, tokens_in: tokensIn, tokens_out: tokensOut } });
      return { ok: false, kind: 'INVALID_OUTPUT', detail };
    }
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout;
    const t = new Promise<never>((_, rej) => {
      timer = setTimeout(() => rej(new Error(`no reply within ${this.opts.timeoutMs} ms`)), this.opts.timeoutMs);
    });
    return Promise.race([p, t]).finally(() => clearTimeout(timer));
  }
}
