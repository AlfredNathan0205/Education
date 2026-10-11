/* Executable wrapper: `node dist/privacy/cli/policy.js <command> ...`. Logic and tests are in policy-cli.ts. */
import { PrismaClient } from '@exam-app/database';
import { OutboxService } from '../../outbox/outbox.service';
import { PrivacyService } from '../privacy.service';
import { CliUsageError, runPolicyCli } from './policy-cli';

async function main(): Promise<void> {
  const client = new PrismaClient();
  const db = { client } as never;
  const service = new PrivacyService(db, new OutboxService(db));
  try {
    console.log(
      await runPolicyCli(process.argv.slice(2), { service, operator: process.env.POLICY_OPERATOR }),
    );
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e instanceof CliUsageError ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
