/* Executable wrapper: `node dist/school/cli/schools.js <command> ...`. Logic and tests are in schools-cli.ts. */
import { PrismaClient } from '@exam-app/database';
import { InvalidSchoolInputError } from '../school-domain';
import { CandidateNotPendingError, SchoolNotFoundError } from '../school.errors';
import { SchoolRegistryService } from '../school-registry.service';
import { CliUsageError, runSchoolsCli } from './schools-cli';

async function main(): Promise<void> {
  const client = new PrismaClient();
  const registry = new SchoolRegistryService({ client } as never);
  try {
    console.log(await runSchoolsCli(process.argv.slice(2), { registry, operator: process.env.ADMIN_OPERATOR }));
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  const friendly = e instanceof CliUsageError || e instanceof InvalidSchoolInputError || e instanceof SchoolNotFoundError || e instanceof CandidateNotPendingError;
  console.error(friendly ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
