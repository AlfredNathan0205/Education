/*
 * Executable wrapper: `node dist/mfa/cli/mfa.js reset <email|phone> <identifier>` (lost phone). Needs database access,
 * so it is trusted like the roles CLI. Set ADMIN_OPERATOR for the audit trail. The person sets up their app again at
 * /admin/mfa on their next visit.
 */
import { PrismaClient } from '@exam-app/database';
import { AuthzService } from '../../authz/authz.service';
import { MfaService } from '../mfa.service';
import type { IdentityKind } from '../../identity/identifier';

async function main(): Promise<void> {
  const [command, kindArg, identifier] = process.argv.slice(2);
  const operator = process.env.ADMIN_OPERATOR?.trim();
  const kinds: Record<string, IdentityKind> = { email: 'EMAIL', phone: 'PHONE' };
  const kind = kindArg ? kinds[kindArg.toLowerCase()] : undefined;
  if (command !== 'reset' || !kind || !identifier) throw new Error('Usage: mfa reset <email|phone> <identifier>');
  if (!operator) throw new Error('ADMIN_OPERATOR must be set (who is running this?)');
  const client = new PrismaClient();
  const db = { client } as never;
  try {
    const accountId = await new AuthzService(db).findAccountId(kind, identifier);
    if (!accountId) throw new Error('No account for that identifier.');
    const r = await new MfaService(db).reset(accountId, operator);
    console.log(r.removed ? 'Authenticator removed. They will set it up again on their next admin visit.' : 'No authenticator was set up.');
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
