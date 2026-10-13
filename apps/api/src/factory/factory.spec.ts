import { AiGateway, BudgetExceededError } from './ai-gateway';
import type { AiProvider } from './ai-provider';
import { createAiProvider } from './ai-provider';
import {
  BREAKER_MIN_ATTEMPTS, FactoryDisabledError, FactoryRequestError, assertFactoryMayRun, breakerReason, buildEvidence, dailyCellRoom,
  extractJsonObject, loadFactoryConfig, nextStep, noveltyScore, parseCandidate, parseSolverAnswer, parseVerdict, validateRequest, type FactoryConfig,
} from './factory-domain';
import { FactoryService, type RunInput } from './factory.service';
import { MockAiProvider, parseMockFaults } from './mock-provider';
import { runFactoryCli, FactoryUsageError } from './cli/factory-cli';

const cfg = (p: Partial<FactoryConfig> = {}): FactoryConfig => ({ enabled: true, dailyTokenBudget: 1_000_000, solverPasses: 1, callTimeoutMs: 5000, ...p });

describe('configuration and kill switch', () => {
  it('is off unless enabled and needs an explicit budget', () => {
    expect(loadFactoryConfig({}).enabled).toBe(false);
    expect(() => assertFactoryMayRun(loadFactoryConfig({}))).toThrow(FactoryDisabledError);
    expect(() => assertFactoryMayRun(loadFactoryConfig({ FACTORY_ENABLED: 'true' }))).toThrow(/FACTORY_DAILY_TOKEN_BUDGET/);
    expect(assertFactoryMayRun(loadFactoryConfig({ FACTORY_ENABLED: 'true', FACTORY_DAILY_TOKEN_BUDGET: '5000' }))).toBe(5000);
  });
  it('rejects bad values', () => {
    expect(() => loadFactoryConfig({ FACTORY_ENABLED: 'yes' })).toThrow();
    expect(() => loadFactoryConfig({ FACTORY_SOLVER_PASSES: '4' })).toThrow();
    expect(loadFactoryConfig({ FACTORY_SOLVER_PASSES: '3' }).solverPasses).toBe(3);
  });
  it('limits a request to 20 and a cell to 50 a day', () => {
    expect(() => validateRequest({ difficulty: 'EASY', cognitive: 'C1', count: 21 })).toThrow(FactoryRequestError);
    expect(() => validateRequest({ difficulty: 'EASY', cognitive: 'C1', count: 0 })).toThrow(FactoryRequestError);
    expect(dailyCellRoom(45)).toBe(5);
    expect(dailyCellRoom(80)).toBe(0);
  });
});

describe('provider selection', () => {
  it('only the mock exists, and never in production', () => {
    expect(createAiProvider({ AI_PROVIDER: 'mock' }).name).toBe('mock');
    expect(() => createAiProvider({ AI_PROVIDER: 'mock', NODE_ENV: 'production' })).toThrow(/production/);
    expect(() => createAiProvider({ AI_PROVIDER: 'anthropic' })).toThrow(/not built yet/);
    expect(() => createAiProvider({})).toThrow(/not set/);
  });
  it('parses fault settings strictly', () => {
    expect(parseMockFaults('wrong-answer=4, garbage=9')).toEqual({ wrongAnswer: 4, garbage: 9 });
    expect(() => parseMockFaults('nonsense=2')).toThrow();
    expect(() => parseMockFaults('garbage=0')).toThrow();
  });
});

describe('reading model output', () => {
  it('parses a candidate and rejects malformed ones', () => {
    const ok = parseCandidate('```json\n{"stem":"S","options":["a","b","c","d"],"correct":"C","explanation":"E"}\n```');
    expect(ok).toMatchObject({ stem: 'S', correctIndex: 2, explanation: 'E' });
    expect(() => parseCandidate('no json here')).toThrow();
    expect(() => parseCandidate('{"stem":"S","options":["a","b"],"correct":"A"}')).toThrow();
    expect(() => parseCandidate('{"stem":"S","options":["a","b","c","d"],"correct":"E"}')).toThrow();
    expect(extractJsonObject('prefix {"a":1} suffix')).toEqual({ a: 1 });
  });
  it('parses solver answers and verdicts', () => {
    expect(parseSolverAnswer('{"answer":"B"}')).toBe(1);
    expect(parseSolverAnswer('{"answer":null}')).toBeNull();
    expect(parseVerdict('{"score":0.9,"critical":false,"issues":["x"]}')).toEqual({ score: 0.9, critical: false, issues: ['x'] });
    expect(() => parseVerdict('{"score":2,"critical":false,"issues":[]}')).toThrow();
  });
  it('scores novelty against the cell', () => {
    expect(noveltyScore('alpha beta gamma', ['alpha beta gamma'])).toBeLessThan(0.2);
    expect(noveltyScore('alpha beta gamma', ['delta epsilon'])).toBe(1);
    expect(noveltyScore('anything', [])).toBe(1);
  });
});

describe('evidence and routing', () => {
  const allGood = { solverAnswers: [1], keyIndex: 1, novelty: 1, verdicts: {} as any };
  const good = { score: 1, critical: false, issues: [] };
  const verdicts = () => ({
    CURRICULUM_VALIDATOR: good, AMBIGUITY_REVIEWER: good, EXPLANATION_VALIDATOR: good, DISTRACTOR_VALIDATOR: good,
    DIFFICULTY_COGNITIVE_VALIDATOR: good, READABILITY_REVIEWER: good, ADVERSARIAL_REVIEWER: good,
  });
  it('a solver miss is a critical gate on the answer', () => {
    const b = buildEvidence({ ...allGood, solverAnswers: [2], verdicts: verdicts() }, 0.985);
    expect(b.evidence.criticalGates).toContain('answer');
    expect(b.evidence.repairable).toBe(false);
  });
  it('a weak explanation alone is repairable', () => {
    const v: any = verdicts();
    v.EXPLANATION_VALIDATOR = { score: 0.6, critical: false, issues: ['weak'] };
    const b = buildEvidence({ ...allGood, verdicts: v }, 0.985);
    expect(b.evidence.repairable).toBe(true);
    expect(b.issues.map((i) => i.message)).toContain('weak');
  });
  it('a small novelty dip does not block a repair', () => {
    const v: any = verdicts();
    v.EXPLANATION_VALIDATOR = { score: 0.6, critical: false, issues: [] };
    expect(buildEvidence({ ...allGood, novelty: 0.9, verdicts: v }, 0.985).evidence.repairable).toBe(true);
  });
  it('a weak curriculum fit is not repairable', () => {
    const v: any = verdicts();
    v.CURRICULUM_VALIDATOR = { score: 0.5, critical: false, issues: [] };
    expect(buildEvidence({ ...allGood, verdicts: v }, 0.985).evidence.repairable).toBe(false);
  });
  it('maps routes to next steps, never auto-approving', () => {
    expect(nextStep('GREEN', 0)).toBe('STORE');
    expect(nextStep('YELLOW', 0)).toBe('REPAIR');
    expect(nextStep('YELLOW', 2)).toBe('STORE_FLAGGED');
    expect(nextStep('AMBER', 0)).toBe('STORE_FLAGGED');
    expect(nextStep('RED', 0)).toBe('REJECT');
    expect(nextStep(null, 0)).toBe('FAIL');
  });
  it('circuit breakers', () => {
    expect(breakerReason({ attempted: BREAKER_MIN_ATTEMPTS - 1, stored: 0, duplicates: 0 })).toBeNull();
    expect(breakerReason({ attempted: 10, stored: 2, duplicates: 0 })).toMatch(/yield/);
    expect(breakerReason({ attempted: 10, stored: 5, duplicates: 5 })).toMatch(/duplicate/);
    expect(breakerReason({ attempted: 10, stored: 8, duplicates: 1 })).toBeNull();
  });
});

// ---------------------------------------------------------------- fakes

function fakes(opts: { provider?: AiProvider; faults?: string; budget?: number; priorToday?: number; tokensUsed?: number; existingStems?: string[]; solverPasses?: number } = {}) {
  const calls: any[] = [];
  const batches: any[] = [];
  const attempts: any[] = [];
  const stored: any[] = [];
  const stems = new Set<string>();
  const db: any = {
    curriculum_subject_version: {
      findFirst: jest.fn(async () => ({ id: 'sv1' })),
      findUnique: jest.fn(async () => ({ id: 'sv1', subject: { name: 'Physics' }, grade: { code: 'GRADE_8' } })),
    },
    chapter: {
      findMany: jest.fn(async () => [
        { code: 'C1', title: 'Motion', topics: [{ code: 'T1', title: 'Speed', micro_concepts: [{ code: 'M1', title: 'Average speed', learning_objectives: [{ code: 'LO1', statement: 'Calculate average speed' }] }] }] },
      ]),
    },
    question_revision: { findMany: jest.fn(async () => (opts.existingStems ?? []).map((s) => ({ stem: s, question: { objective_path: 'C1/T1/M1/LO1' } }))) },
    generation_attempt: {
      count: jest.fn(async () => opts.priorToday ?? 0),
      create: jest.fn(async ({ data }: any) => attempts.push(data)),
    },
    generation_batch: {
      create: jest.fn(async ({ data }: any) => { const b = { id: 'abcdef12-0000', status: 'RUNNING', ...data }; batches.push(b); return { id: b.id }; }),
      findUnique: jest.fn(async ({ where }: any) => batches.find((b) => b.id === where.id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(batches.find((b) => b.id === where.id), data)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = batches.filter((b) => b.id === where.id && b.status === where.status);
        hit.forEach((b) => Object.assign(b, data));
        return { count: hit.length };
      }),
    },
    ai_call_log: { create: jest.fn(async ({ data }: any) => calls.push(data)) },
    $queryRaw: jest.fn(async () => [{ used: (opts.tokensUsed ?? 0) + calls.reduce((n, c) => n + (c.tokens_in ?? 0) + (c.tokens_out ?? 0), 0) }]),
  };
  const questions: any = {
    unitIdentity: jest.fn(async () => ({ curriculumVersionId: 'cv', gradeId: 'g', subjectId: 's', latestRevisionId: 'sv1', latestRevisionState: 'ACTIVE' })),
    plan: jest.fn(async (_u: any, parsed: any) => {
      const d = parsed.questions[0].draft;
      return stems.has(d.stem) ? { items: [], issues: [{ where: 'factory', message: 'the same question wording already exists' }] } : { items: [{ draft: d }], issues: [] };
    }),
    apply: jest.fn(async (_u: any, plan: any, ctx: any) => { for (const i of plan.items) { stems.add(i.draft.stem); stored.push({ draft: i.draft, ctx }); } }),
    revisionIdByCode: jest.fn(async (_u: any, code: string) => `rev-${code}`),
  };
  const provider = opts.provider ?? new MockAiProvider(parseMockFaults(opts.faults));
  const gateway = new AiGateway(provider, db, { dailyTokenBudget: opts.budget ?? 10_000_000, timeoutMs: 2000 });
  const service = new FactoryService({ client: db } as any, questions, gateway, cfg({ solverPasses: opts.solverPasses ?? 1 }));
  return { service, db, calls, batches, attempts, stored, questions };
}
const input = (p: Partial<RunInput> = {}): RunInput => ({ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS', objectiveCode: 'LO1', difficulty: 'EASY', cognitive: 'C1', count: 3, operator: 'op', ...p });

describe('gateway', () => {
  it('logs hashes and tokens, never the text', async () => {
    const f = fakes();
    await f.service.runBatch(input({ count: 1 }));
    expect(f.calls.length).toBeGreaterThan(8);
    for (const c of f.calls) {
      expect(c.input_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify(c)).not.toContain('[MOCK]');
      expect(c).toMatchObject({ provider: 'mock', model: 'mock-1', prompt_version: 'p1', schema_version: 's1' });
    }
    expect(f.calls.map((c) => c.role)).toEqual(expect.arrayContaining(['QUESTION_GENERATOR', 'ANSWER_SOLVER', 'CURRICULUM_VALIDATOR', 'ADVERSARIAL_REVIEWER']));
  });
  it('records a provider error and a timeout without throwing', async () => {
    const f = fakes({ provider: { name: 'x', model: 'm', complete: async () => { throw new Error('boom'); } } });
    const s = await f.service.runBatch(input({ count: 1 }));
    expect(s.failed).toBe(1);
    expect(f.calls[0]).toMatchObject({ status: 'ERROR' });
    const slow = fakes({ provider: { name: 'x', model: 'm', complete: () => new Promise(() => undefined) } });
    const g = new AiGateway({ name: 'x', model: 'm', complete: () => new Promise(() => undefined) }, slow.db, { dailyTokenBudget: 1e9, timeoutMs: 20 });
    const r = await g.call('QUESTION_GENERATOR', { system: 's', user: '{}' }, (t) => t, { batchId: 'b', attemptSeq: 1 });
    expect(r).toMatchObject({ ok: false, kind: 'ERROR' });
    expect((r as any).detail).toMatch(/no reply/);
  });
  it('refuses to call once the daily budget is used', async () => {
    const f = fakes({ budget: 100, tokensUsed: 100 });
    const s = await f.service.runBatch(input({ count: 2 }));
    expect(s.status).toBe('STOPPED');
    expect(s.stopReason).toMatch(/budget/);
    expect(f.calls).toHaveLength(0);
    expect(new BudgetExceededError(1, 2).message).toMatch(/1 of 2/);
  });
});

describe('the pipeline with the mock provider', () => {
  it('stores clean candidates as AI drafts for a person, never approved', async () => {
    const f = fakes();
    const s = await f.service.runBatch(input({ count: 3 }));
    expect(s).toMatchObject({ status: 'COMPLETED', attempted: 3, draftsStored: 3, rejected: 0, duplicates: 0, failed: 0 });
    expect(s.routes).toEqual({ GREEN: 3 });
    expect(f.stored).toHaveLength(3);
    for (const st of f.stored) {
      expect(st.ctx.origin).toBe('AI_DRAFT');
      expect(st.ctx.actor).toEqual({ kind: 'AI', accountId: null });
      expect(st.ctx.aiSource).toMatch(/^factory batch abcdef12-0000; mock\/mock-1$/);
      expect(st.draft).toMatchObject({ difficulty: 'EASY', cognitive: 'C1', objectiveCode: 'LO1' });
    }
    expect(f.attempts.every((a) => a.question_revision_id?.startsWith('rev-'))).toBe(true);
    expect(f.batches[0]).toMatchObject({ status: 'COMPLETED', drafts_stored: 3 });
  });
  it('rejects a wrong key (the blind solver disagrees)', async () => {
    const f = fakes({ faults: 'wrong-answer=2' });
    const s = await f.service.runBatch(input({ count: 4 }));
    expect(s.rejected).toBe(2);
    expect(s.draftsStored).toBe(2);
    expect(s.routes.RED).toBe(2);
    expect(f.attempts.filter((a) => a.outcome === 'REJECTED_QUALITY')).toHaveLength(2);
  });
  it('repairs a weak explanation, then stores it', async () => {
    const f = fakes({ faults: 'weak-explanation=2' });
    const s = await f.service.runBatch(input({ count: 3 }));
    expect(s.draftsStored).toBe(3);
    const repaired = f.attempts.filter((a) => a.repairs > 0);
    expect(repaired.length).toBe(1);
    expect(repaired[0].repairs).toBeLessThanOrEqual(2);
  });
  it('drops an exact duplicate of existing wording', async () => {
    const f = fakes({ faults: 'duplicate=2' });
    const s = await f.service.runBatch(input({ count: 3 }));
    expect(s.duplicates).toBe(1);
    expect(s.draftsStored).toBe(2);
  });
  it('counts unusable model output as a failure and stores nothing for it', async () => {
    const f = fakes({ faults: 'garbage=2' });
    const s = await f.service.runBatch(input({ count: 3 }));
    expect(s.failed).toBe(1);
    expect(s.draftsStored).toBe(2);
    expect(f.calls.some((c) => c.status === 'INVALID_OUTPUT')).toBe(true);
  });
  it('a second run continues after the first instead of repeating it', async () => {
    const f = fakes();
    await f.service.runBatch(input({ count: 2 }));
    const second = fakes({ existingStems: f.stored.map((s) => s.draft.stem) });
    const s = await second.service.runBatch(input({ count: 2 }));
    expect(s.duplicates).toBe(0);
    expect(s.draftsStored).toBe(2);
  });
  it('stops on the yield breaker when most candidates are unusable', async () => {
    const f = fakes({ faults: 'garbage=1' });
    const s = await f.service.runBatch(input({ count: 20 }));
    expect(s.status).toBe('STOPPED');
    expect(s.stopReason).toMatch(/yield/);
    expect(s.attempted).toBe(BREAKER_MIN_ATTEMPTS);
  });
  it('honours a stop request', async () => {
    const inner = new MockAiProvider();
    let generated = 0;
    let svc: FactoryService;
    const f = fakes({
      provider: {
        name: 'mock', model: 'mock-1',
        complete: async (r) => {
          if (r.role === 'QUESTION_GENERATOR' && ++generated === 2) await svc.requestStop('abcdef12-0000');
          return inner.complete(r);
        },
      },
    });
    svc = f.service;
    const s = await f.service.runBatch(input({ count: 5 }));
    expect(s.status).toBe('STOPPED');
    expect(s.stopReason).toMatch(/operator/);
    expect(s.attempted).toBeLessThan(5);
  });
  it('refuses when the cell has no room today, and when disabled', async () => {
    await expect(fakes({ priorToday: 48 }).service.runBatch(input({ count: 3 }))).rejects.toThrow(/room for 2 more/);
    const f = fakes();
    const off = new FactoryService({ client: f.db } as any, f.questions, new AiGateway(new MockAiProvider(), f.db, { dailyTokenBudget: 1, timeoutMs: 1 }), cfg({ enabled: false }));
    await expect(off.runBatch(input())).rejects.toThrow(FactoryDisabledError);
  });
  it('refuses an unknown objective', async () => {
    await expect(fakes().service.runBatch(input({ objectiveCode: 'NOPE' }))).rejects.toThrow(/does not exist/);
  });
  it('uses several solver passes when configured', async () => {
    const f = fakes({ solverPasses: 3 });
    await f.service.runBatch(input({ count: 1 }));
    expect(f.calls.filter((c) => c.role === 'ANSWER_SOLVER')).toHaveLength(3);
  });
  it('never shows the key to the blind solver', async () => {
    const seen: string[] = [];
    const inner = new MockAiProvider();
    const f = fakes({ provider: { name: 'mock', model: 'mock-1', complete: async (r) => { if (r.role === 'ANSWER_SOLVER') seen.push(r.user); return inner.complete(r); } } });
    await f.service.runBatch(input({ count: 1 }));
    expect(seen).toHaveLength(1);
    expect(Object.keys(JSON.parse(seen[0])).sort()).toEqual(['options', 'stem']);
  });
});

describe('cli', () => {
  const summary = { batchId: 'b1', status: 'COMPLETED' as const, stopReason: null, requested: 2, attempted: 2, draftsStored: 2, rejected: 0, duplicates: 0, failed: 0, routes: { GREEN: 2 } };
  const deps = (over: any = {}) => ({
    operator: 'op',
    factory: { runBatch: jest.fn(async () => summary), listBatches: jest.fn(async () => []), showBatch: jest.fn(), requestStop: jest.fn(async () => true), ...over },
    coverage: { report: jest.fn(async () => ({ cells: [{ objectivePath: 'C1/T1/M1/LO1', difficulty: 'EASY', need: 0.8, approved: 0, inPipeline: 0, requestable: 30 }, { objectivePath: 'C1/T1/M1/LO2', difficulty: 'HARD', need: 0.1, approved: 5, inPipeline: 0, requestable: 0 }] })) },
  });
  it('runs a batch and says drafts still need a person', async () => {
    const d = deps();
    const out = await runFactoryCli(['run', 'ICSE', 'GRADE_8', 'PHYSICS', 'LO1', 'EASY', 'C1', '2'], d as any);
    expect(out).toMatch(/2 stored as drafts/);
    expect(out).toMatch(/not approved/);
    expect(d.factory.runBatch).toHaveBeenCalledWith(expect.objectContaining({ operator: 'op', count: 2, difficulty: 'EASY', cognitive: 'C1' }));
  });
  it('validates arguments', async () => {
    await expect(runFactoryCli(['run', 'ICSE', 'GRADE_8', 'PHYSICS', 'LO1', 'TRIVIAL', 'C1', '2'], deps() as any)).rejects.toThrow(FactoryUsageError);
    await expect(runFactoryCli(['run', 'ICSE', 'GRADE_8', 'PHYSICS', 'LO1', 'EASY', 'C9', '2'], deps() as any)).rejects.toThrow(/cognitive/);
    await expect(runFactoryCli(['run', 'ICSE'], deps() as any)).rejects.toThrow(/Usage/);
    await expect(runFactoryCli(['nope'], deps() as any)).rejects.toThrow(/Usage/);
  });
  it('suggests only cells that can take more, capped at 20 per run', async () => {
    const out = await runFactoryCli(['suggest', 'ICSE', 'GRADE_8', 'PHYSICS', '10'], deps() as any);
    expect(out).toContain('factory run ICSE GRADE_8 PHYSICS LO1 EASY <C1-C4> 20');
    expect(out).not.toContain('LO2');
  });
  it('stop and batches', async () => {
    expect(await runFactoryCli(['stop', 'b1'], deps() as any)).toMatch(/Stop requested/);
    expect(await runFactoryCli(['stop', 'b1'], deps({ requestStop: async () => false }) as any)).toMatch(/not running/);
    expect(await runFactoryCli(['batches'], deps() as any)).toBe('No batches yet.');
  });
});
