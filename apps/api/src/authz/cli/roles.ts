/* Executable wrapper: `node dist/authz/cli/roles.js <command> ...`. Logic and tests are in roles-cli.ts. */
import { PrismaClient } from '@exam-app/database';
import { AuthzError, AuthzService } from '../authz.service';
import { CliUsageError, runRolesCli } from './roles-cli';

async function main(): Promise<void> {
  const client = new PrismaClient();
  const authz = new AuthzService({ client } as never);
  try {
    console.log(await runRolesCli(process.argv.slice(2), { authz, operator: process.env.ADMIN_OPERATOR }));
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e instanceof CliUsageError || e instanceof AuthzError ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
