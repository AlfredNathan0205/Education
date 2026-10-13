/* Executable wrapper: `ADMIN_OPERATOR=you node dist/factory/cli/factory.js run ICSE GRADE_8 PHYSICS <objective> EASY C1 5`. Logic and tests: factory-cli.ts. */
import { PrismaClient } from '@exam-app/database';
import { CoverageService } from '../../bank-coverage/coverage.service';
import { QuestionService } from '../../question/question.service';
import { AiGateway, BudgetExceededError } from '../ai-gateway';
import { createAiProvider } from '../ai-provider';
import { FactoryDisabledError, FactoryRequestError, assertFactoryMayRun, loadFactoryConfig } from '../factory-domain';
import { FactoryService } from '../factory.service';
import { FactoryUsageError, runFactoryCli } from './factory-cli';

async function main(): Promise<void> {
  const operator = process.env.ADMIN_OPERATOR?.trim();
  if (!operator) throw new FactoryUsageError('ADMIN_OPERATOR must be set (who is running this?)');
  const client = new PrismaClient();
  try {
    const db = { client } as never;
    const argv = process.argv.slice(2);
    // Read-only commands need no AI configuration.
    const readOnly = ['batches', 'show', 'stop', 'suggest'].includes(argv[0] ?? '');
    let factory: FactoryService;
    if (readOnly) {
      factory = new FactoryService(db, new QuestionService(db), undefined as never, undefined as never);
    } else {
      const config = loadFactoryConfig(process.env);
      const dailyTokenBudget = assertFactoryMayRun(config);
      const gateway = new AiGateway(createAiProvider(process.env), client as never, { dailyTokenBudget, timeoutMs: config.callTimeoutMs });
      factory = new FactoryService(db, new QuestionService(db), gateway, config);
    }
    console.log(await runFactoryCli(argv, { factory, coverage: new CoverageService(db), operator }));
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  const known = e instanceof FactoryUsageError || e instanceof FactoryDisabledError || e instanceof FactoryRequestError || e instanceof BudgetExceededError || e instanceof RangeError;
  console.error(known ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
