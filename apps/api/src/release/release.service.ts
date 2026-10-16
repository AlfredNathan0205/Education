import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { AuthzService } from '../authz/authz.service';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { normalizeIdentifier } from '../identity/identifier';
import { canSee, gatingEnabled, isAudience, isTier, type Audience, type Tier } from './release-domain';

type Tx = Prisma.TransactionClient;
type Db = any;

export interface SubjectKey {
  curriculum_version_id: string;
  grade_id: string;
  subject_id: string;
}

export interface AccessRow {
  id: string;
  accountId: string;
  email: string | null;
  tier: Audience;
  reason: string;
  grantedAt: string;
}

/**
 * Step 21: who may see which released subject. The exam service asks `visible` before listing a subject or starting a
 * test on it; the readiness service changes tiers. A student's audience is their own account's live grant (a parent or
 * guardian sees the child's subjects as the child does).
 */
@Injectable()
export class ReleaseService {
  readonly enabled = gatingEnabled(process.env);

  constructor(private readonly db: DatabaseService, private readonly authz: AuthzService) {}

  async tierOf(db: Tx | Db, s: SubjectKey): Promise<Tier> {
    const row = await (db as Db).subject_release.findUnique({
      where: { curriculum_version_id_grade_id_subject_id: { curriculum_version_id: s.curriculum_version_id, grade_id: s.grade_id, subject_id: s.subject_id } },
      select: { tier: true },
    });
    return row && isTier(row.tier) ? row.tier : 'FOUNDATION_ONLY';
  }

  async audienceOfStudent(db: Tx | Db, studentId: string): Promise<Audience | null> {
    const self = await (db as Db).account_student_access.findFirst({ where: { student_id: studentId, access_kind: 'SELF', revoked_at: null }, select: { account_id: true } });
    if (!self) return null;
    const g = await (db as Db).release_access.findFirst({ where: { account_id: self.account_id, revoked_at: null }, select: { tier: true } });
    return g && isAudience(g.tier) ? g.tier : null;
  }

  /** May this student see (and be tested on) this subject? Always yes while gating is switched off. */
  async visible(db: Tx | Db, studentId: string, s: SubjectKey): Promise<boolean> {
    if (!this.enabled) return true;
    return canSee(await this.tierOf(db, s), await this.audienceOfStudent(db, studentId));
  }

  // ── audiences (SUPER_ADMIN) ────────────────────────────────────────────────

  async listAccess(adminId: string): Promise<AccessRow[]> {
    await this.requireSuperAdmin(adminId);
    const db = this.db.client as Db;
    const rows: any[] = await db.release_access.findMany({ where: { revoked_at: null }, orderBy: { granted_at: 'desc' } });
    const ids: any[] = rows.length ? await db.authentication_identity.findMany({ where: { account_id: { in: rows.map((r) => r.account_id) }, kind: 'EMAIL' }, select: { account_id: true, identifier_normalized: true } }) : [];
    return rows.map((r) => ({ id: r.id, accountId: r.account_id, email: ids.find((i) => i.account_id === r.account_id)?.identifier_normalized ?? null, tier: r.tier, reason: r.reason, grantedAt: r.granted_at.toISOString() }));
  }

  /** Gives an existing account an audience (replacing any earlier one). The person must have signed in once. */
  async grantAccess(adminId: string | null, input: { email: unknown; tier: unknown; reason: unknown }, now = new Date(), operator?: string): Promise<{ id: string; replaced: boolean }> {
    if (adminId) await this.requireSuperAdmin(adminId);
    else if (!operator?.trim()) throw new ExamInputError('An operator name is required');
    if (!isAudience(input.tier)) throw new ExamInputError('Choose INTERNAL or CONTROLLED');
    const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
    if (reason.length < 5 || reason.length > 300) throw new ExamInputError('Give a reason of 5 to 300 characters');
    if (typeof input.email !== 'string' || !input.email.includes('@')) throw new ExamInputError('Enter the email address they sign in with');
    const db = this.db.client as Db;
    let email: string;
    try {
      email = normalizeIdentifier('EMAIL', input.email);
    } catch {
      throw new ExamInputError('That email address is not valid');
    }
    const ident = await db.authentication_identity.findUnique({ where: { kind_identifier_normalized: { kind: 'EMAIL', identifier_normalized: email } }, select: { account_id: true } });
    if (!ident) throw new ExamNotFoundError('No account signs in with that email. Ask them to sign in once first.');
    return db.$transaction(async (tx: Db) => {
      const live: any[] = await tx.release_access.findMany({ where: { account_id: ident.account_id, revoked_at: null } });
      if (live.some((l) => l.tier === input.tier)) throw new ExamConflictError(`They already have ${input.tier} access`);
      for (const l of live) await tx.release_access.update({ where: { id: l.id }, data: { revoked_at: now, revoked_by_account_id: adminId } });
      const row = await tx.release_access.create({ data: { account_id: ident.account_id, tier: input.tier, reason, granted_by_account_id: adminId, granted_at: now } });
      await tx.audit_event.create({ data: { actor_account_id: adminId, action: 'release.access_granted', subject_type: 'account', subject_id: ident.account_id, metadata: { tier: input.tier, accessId: row.id, ...(operator ? { operator } : {}) }, occurred_at: now } });
      return { id: row.id, replaced: live.length > 0 };
    });
  }

  async revokeAccess(adminId: string, accessId: string, now = new Date()): Promise<{ revoked: true }> {
    await this.requireSuperAdmin(adminId);
    const db = this.db.client as Db;
    const row = await db.release_access.findUnique({ where: { id: accessId } });
    if (!row) throw new ExamNotFoundError('Not found');
    if (row.revoked_at) throw new ExamConflictError('Already revoked');
    await db.$transaction(async (tx: Db) => {
      await tx.release_access.update({ where: { id: accessId }, data: { revoked_at: now, revoked_by_account_id: adminId } });
      await tx.audit_event.create({ data: { actor_account_id: adminId, action: 'release.access_revoked', subject_type: 'account', subject_id: row.account_id, metadata: { tier: row.tier, accessId }, occurred_at: now } });
    });
    return { revoked: true };
  }

  private async requireSuperAdmin(accountId: string): Promise<void> {
    if (!(await this.authz.curriculumRolesFor(accountId)).includes('SUPER_ADMIN')) throw new ExamNotPermittedError('Only a super administrator may give release access');
  }
}
