import { memoryDb } from '../testing/memory-db';
import { AdminFactoryService, PAGE_MAX_COUNT } from './admin-factory.service';

const SV = '11111111-1111-4111-8111-111111111111';

function setup(env: Record<string, string>, roles: string[] = ['EDITOR']) {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  const db = memoryDb();
  db.seed('curriculum_subject_version', [{ id: SV, curriculum_version: { curriculum: { code: 'ICSE' } }, grade: { code: 'GRADE_8' }, subject: { code: 'CHEMISTRY' } }]);
  db.seed('authentication_identity', [{ account_id: 'ed', kind: 'EMAIL', identifier_normalized: 'ed@example.com' }]);
  (db as any).ai_call_log.aggregate = jest.fn(async () => ({ _sum: { tokens_in: 120, tokens_out: 30 } }));
  const coverage = {
    report: jest.fn(async () => ({
      cells: [
        { objectivePath: 'C1/T/M/LO1', difficulty: 'HARD', approved: 0, inPipeline: 0, requestable: 8 },
        { objectivePath: 'C1/T/M/LO2', difficulty: 'EASY', approved: 9, inPipeline: 0, requestable: 0 },
      ],
    })),
  };
  const authz = { curriculumRolesFor: jest.fn(async () => roles) };
  const service = new AdminFactoryService({ client: db } as any, authz as any, {} as any, coverage as any);
  for (const k of Object.keys(env)) process.env[k] = saved[k];
  for (const k of Object.keys(env)) if (saved[k] === undefined) delete process.env[k];
  return { service, coverage, db };
}

describe('AdminFactoryService', () => {
  it('switched off, the page says why and nothing runs', async () => {
    const { service } = setup({ FACTORY_ENABLED: 'false' });
    expect(await service.status('ed')).toMatchObject({ available: false, reason: expect.stringMatching(/FACTORY_ENABLED=true/), tokensUsedToday: 150 });
    await expect(service.run('ed', { unitId: SV, objectiveCode: 'LO1', difficulty: 'HARD', cognitive: 'C3', count: 3 })).rejects.toThrow(/switched off/);
  });

  it('with no budget, or no provider, it says so', async () => {
    expect((await setup({ FACTORY_ENABLED: 'true' }).service.status('ed')).reason).toMatch(/FACTORY_DAILY_TOKEN_BUDGET/);
    expect((await setup({ FACTORY_ENABLED: 'true', FACTORY_DAILY_TOKEN_BUDGET: '1000' }).service.status('ed')).reason).toMatch(/not set up here/);
  });

  it('suggestions are the cells still short of the target', async () => {
    const { service, coverage } = setup({});
    const s = await service.suggestions('ed', SV, '8');
    expect(coverage.report).toHaveBeenCalledWith({ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'CHEMISTRY', targetPerCell: 8 });
    expect(s).toEqual({ target: 8, cells: [{ objectivePath: 'C1/T/M/LO1', objectiveCode: 'LO1', difficulty: 'HARD', approved: 0, inPipeline: 0, requestable: 8 }] });
    await expect(service.suggestions('ed', SV, '0')).rejects.toThrow(/1 to 100/);
  });

  it('only editors run it; small batches only; the inputs are checked', async () => {
    await expect(setup({}, ['REVIEWER']).service.run('ed', {})).rejects.toThrow(/Only an editor/);
    await expect(setup({}, []).service.status('ed')).rejects.toThrow(/curriculum staff/);
    const { service } = setup({ FACTORY_ENABLED: 'true', FACTORY_DAILY_TOKEN_BUDGET: '1000', AI_PROVIDER: 'mock' });
    expect((await service.status('ed')).available).toBe(true);
    await expect(service.run('ed', { unitId: SV, objectiveCode: 'LO1', difficulty: 'HARD', cognitive: 'C3', count: PAGE_MAX_COUNT + 1 })).rejects.toThrow(/1 to 10 drafts/);
    await expect(service.run('ed', { unitId: SV, objectiveCode: 'LO1', difficulty: 'VERY_HARD', cognitive: 'C3', count: 2 })).rejects.toThrow(/EASY, MEDIUM or HARD/);
    await expect(service.run('ed', { unitId: SV, objectiveCode: 'LO1', difficulty: 'HARD', cognitive: 'C9', count: 2 })).rejects.toThrow(/C1 to C4/);
  });
});
