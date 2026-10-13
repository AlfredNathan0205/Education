/* Executable wrapper: `node dist/bank-coverage/cli/coverage.js report ICSE GRADE_8 PHYSICS 10`. Logic and tests: coverage-cli.ts. */
import { PrismaClient } from '@exam-app/database';
import { CoverageService, CoverageUnitNotFoundError } from '../coverage.service';
import { CoverageUsageError, runCoverageCli } from './coverage-cli';

async function main(): Promise<void> {
  const client = new PrismaClient();
  try {
    console.log(await runCoverageCli(process.argv.slice(2), { coverage: new CoverageService({ client } as never) }));
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e instanceof CoverageUsageError || e instanceof CoverageUnitNotFoundError || e instanceof RangeError ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
