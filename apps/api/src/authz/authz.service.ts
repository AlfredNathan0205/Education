import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { normalizeIdentifier, type IdentityKind } from '../identity/identifier';
import { ASSIGNABLE_ROLES, isAssignableRole, toCurriculumRoles } from './roles';
import type { CurriculumRole } from '../curriculum/curriculum-state';

export class AuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthzError';
  }
}

/**
 * Domain 01c — who holds which role. Roles are resolved from role_assignment on every
 * check, never from a request. Granting is itself authorized: a SUPER_ADMIN account may
 * grant; the operator CLI (database access) is the bootstrap path, recorded as such.
 */
@Injectable()
export class AuthzService {
  constructor(private readonly db: DatabaseService) {}

  /** Curriculum roles currently held by an ACTIVE account (global scope). */
  async curriculumRolesFor(accountId: string): Promise<CurriculumRole[]> {
    const rows = await this.db.client.role_assignment.findMany({
      where: { account_id: accountId, revoked_at: null, account: { status: 'ACTIVE' } },
      select: { role: { select: { code: true } } },
    });
    return toCurriculumRoles(rows.map((r: { role: { code: string } }) => r.role.code));
  }

  /** Resolve a login identifier to an existing account. Never creates one. */
  async findAccountId(kind: IdentityKind, identifier: string): Promise<string | null> {
    const row = await this.db.client.authentication_identity.findUnique({
      where: { kind_identifier_normalized: { kind, identifier_normalized: normalizeIdentifier(kind, identifier) } },
      select: { account_id: true },
    });
    return (row?.account_id as string | undefined) ?? null;
  }

  /**
   * Grant a role. `actorAccountId` must hold SUPER_ADMIN, or be null for the operator
   * bootstrap path (then `operator` is required and recorded). Idempotent.
   */
  async grantRole(input: {
    targetAccountId: string;
    roleCode: string;
    actorAccountId: string | null;
    operator?: string;
  }): Promise<{ granted: boolean }> {
    if (!isAssignableRole(input.roleCode)) throw new AuthzError(`unknown role ${input.roleCode}`);
    await this.assertMayManage(input.actorAccountId, input.operator);
    const roleCode = input.roleCode;

    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const target = await tx.account.findUnique({ where: { id: input.targetAccountId }, select: { status: true } });
      if (!target || target.status !== 'ACTIVE') throw new AuthzError('target account not found or not active');

      const role = await tx.role.upsert({
        where: { code: roleCode },
        update: {},
        create: { code: roleCode, description: ASSIGNABLE_ROLES[roleCode].description },
      });
      const existing = await tx.role_assignment.findFirst({
        where: { account_id: input.targetAccountId, role_id: role.id, revoked_at: null },
      });
      if (existing) return { granted: false };

      await tx.role_assignment.create({
        data: { account_id: input.targetAccountId, role_id: role.id, granted_by_account_id: input.actorAccountId },
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: input.actorAccountId,
          action: 'authz.role.granted',
          subject_type: 'account',
          subject_id: input.targetAccountId,
          metadata: { roleCode, operator: input.operator ?? null },
        },
      });
      return { granted: true };
    });
  }

  async revokeRole(input: {
    targetAccountId: string;
    roleCode: string;
    actorAccountId: string | null;
    operator?: string;
  }): Promise<{ revoked: boolean }> {
    if (!isAssignableRole(input.roleCode)) throw new AuthzError(`unknown role ${input.roleCode}`);
    await this.assertMayManage(input.actorAccountId, input.operator);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const res = await tx.role_assignment.updateMany({
        where: { account_id: input.targetAccountId, role: { code: input.roleCode }, revoked_at: null },
        data: { revoked_at: new Date() },
      });
      if (res.count === 0) return { revoked: false };
      await tx.audit_event.create({
        data: {
          actor_account_id: input.actorAccountId,
          action: 'authz.role.revoked',
          subject_type: 'account',
          subject_id: input.targetAccountId,
          metadata: { roleCode: input.roleCode, operator: input.operator ?? null },
        },
      });
      return { revoked: true };
    });
  }

  private async assertMayManage(actorAccountId: string | null, operator?: string): Promise<void> {
    if (actorAccountId === null) {
      if (!operator || operator.trim() === '') throw new AuthzError('operator is required for the bootstrap path');
      return;
    }
    const roles = await this.curriculumRolesFor(actorAccountId);
    if (!roles.includes('SUPER_ADMIN')) throw new AuthzError('only a SUPER_ADMIN may manage roles');
  }
}
