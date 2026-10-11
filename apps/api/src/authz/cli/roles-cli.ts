/**
 * Operator tooling for role assignment (bootstrap path). Needs database access, so it is
 * trusted like the policy CLI. It never creates accounts: the person must sign in once
 * first, which proves they control the email or number.
 *
 *   roles grant  <email|phone> <identifier> <ROLE>
 *   roles revoke <email|phone> <identifier> <ROLE>
 *   roles list   <email|phone> <identifier>
 */
import type { AuthzService } from '../authz.service';
import { ASSIGNABLE_ROLES } from '../roles';
import type { IdentityKind } from '../../identity/identifier';

export class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

export const USAGE = `Usage:
  roles grant  <email|phone> <identifier> <ROLE>
  roles revoke <email|phone> <identifier> <ROLE>
  roles list   <email|phone> <identifier>
Roles: ${Object.keys(ASSIGNABLE_ROLES).join(', ')}
Set ADMIN_OPERATOR to your name or email for the audit trail.`;

export async function runRolesCli(
  argv: string[],
  deps: { authz: Pick<AuthzService, 'findAccountId' | 'grantRole' | 'revokeRole' | 'curriculumRolesFor'>; operator?: string },
): Promise<string> {
  const [command, kindArg, identifier, role] = argv;
  const operator = deps.operator?.trim();
  if (!operator) throw new CliUsageError('ADMIN_OPERATOR must be set (who is running this?)');
  const kinds: Record<string, IdentityKind> = { email: 'EMAIL', phone: 'PHONE' };
  const kind = kindArg ? kinds[kindArg.toLowerCase()] : undefined;
  if (!kind || !identifier) throw new CliUsageError(USAGE);

  const accountId = await deps.authz.findAccountId(kind, identifier);
  if (!accountId) {
    throw new CliUsageError('No account for that identifier. Ask them to sign in once first, then retry.');
  }

  switch (command) {
    case 'grant': {
      if (!role || argv.length !== 4) throw new CliUsageError(USAGE);
      const r = await deps.authz.grantRole({ targetAccountId: accountId, roleCode: role, actorAccountId: null, operator });
      return r.granted ? `Granted ${role}.` : `${role} was already held.`;
    }
    case 'revoke': {
      if (!role || argv.length !== 4) throw new CliUsageError(USAGE);
      const r = await deps.authz.revokeRole({ targetAccountId: accountId, roleCode: role, actorAccountId: null, operator });
      return r.revoked ? `Revoked ${role}.` : `${role} was not held.`;
    }
    case 'list': {
      if (argv.length !== 3) throw new CliUsageError(USAGE);
      const roles = await deps.authz.curriculumRolesFor(accountId);
      return roles.length ? `Curriculum roles: ${roles.join(', ')}` : 'No curriculum roles.';
    }
    default:
      throw new CliUsageError(USAGE);
  }
}
