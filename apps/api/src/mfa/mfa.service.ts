import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotPermittedError } from '../exam/exam.errors';
import {
  MFA_FAILURE_WINDOW_MS,
  MFA_MAX_FAILURES,
  decryptSecret,
  encryptSecret,
  hashRecoveryCode,
  isMfaFresh,
  mfaKey,
  mfaSessionHours,
  newRecoveryCodes,
  newTotpSecret,
  otpauthUri,
  verifyTotp,
} from './totp';

export interface MfaStatus {
  /** The account holds a role, so admin pages need the check. */
  required: boolean;
  enrolled: boolean;
  /** Set-up was started but no code confirmed yet. */
  pending: boolean;
  /** This session has passed the check and it has not expired. */
  verified: boolean;
  recoveryCodesLeft: number;
}

export type MfaCheck = 'OK' | 'NOT_PRIVILEGED' | 'MFA_REQUIRED';

/**
 * Step 20: an authenticator app (TOTP) for privileged accounts. Anyone holding a role (curriculum, content or
 * SUPER_ADMIN) must pass the check once per session (MFA_SESSION_HOURS) before any /admin route answers.
 */
@Injectable()
export class MfaService {
  private readonly key: Buffer;
  private readonly hours: number;

  constructor(private readonly db: DatabaseService) {
    this.key = mfaKey(process.env);
    this.hours = mfaSessionHours(process.env);
  }

  async isPrivileged(accountId: string): Promise<boolean> {
    const n = await (this.db.client as any).role_assignment.count({ where: { account_id: accountId, revoked_at: null } });
    return n > 0;
  }

  /** What the admin guard asks. */
  async check(accountId: string, sessionId: string, now = new Date()): Promise<MfaCheck> {
    if (!(await this.isPrivileged(accountId))) return 'NOT_PRIVILEGED';
    return (await this.sessionVerified(sessionId, now)) ? 'OK' : 'MFA_REQUIRED';
  }

  async status(accountId: string, sessionId: string, now = new Date()): Promise<MfaStatus> {
    const db = this.db.client as any;
    const factor = await db.admin_mfa_factor.findUnique({ where: { account_id: accountId } });
    const left = factor?.status === 'ACTIVE' ? await db.admin_mfa_recovery_code.count({ where: { factor_id: factor.id, used_at: null } }) : 0;
    return {
      required: await this.isPrivileged(accountId),
      enrolled: factor?.status === 'ACTIVE',
      pending: factor?.status === 'PENDING',
      verified: factor?.status === 'ACTIVE' && (await this.sessionVerified(sessionId, now)),
      recoveryCodesLeft: left,
    };
  }

  /** Begin set-up: a new secret, shown once. Starting again replaces an unconfirmed one. */
  async startEnrolment(accountId: string, now = new Date()): Promise<{ secret: string; otpauthUri: string }> {
    if (!(await this.isPrivileged(accountId))) throw new ExamNotPermittedError('Only accounts with an administrator role use an authenticator here');
    const db = this.db.client as any;
    const existing = await db.admin_mfa_factor.findUnique({ where: { account_id: accountId } });
    if (existing?.status === 'ACTIVE') throw new ExamConflictError('An authenticator is already set up. To replace it, ask an operator to reset it.');
    const secret = newTotpSecret();
    const secret_ciphertext = encryptSecret(secret, this.key);
    if (existing) await db.admin_mfa_factor.update({ where: { id: existing.id }, data: { secret_ciphertext, created_at: now, last_used_step: null } });
    else await db.admin_mfa_factor.create({ data: { account_id: accountId, status: 'PENDING', secret_ciphertext, created_at: now } });
    await this.audit(db, accountId, 'mfa.enrolment_started', {}, now);
    return { secret, otpauthUri: otpauthUri(secret) };
  }

  /** Confirm set-up with a first code. Returns the recovery codes, the only time they are shown. */
  async confirmEnrolment(accountId: string, sessionId: string, code: unknown, now = new Date()): Promise<{ recoveryCodes: string[] }> {
    if (typeof code !== 'string') throw new ExamInputError('Enter the 6-digit code from your app');
    const db = this.db.client as any;
    await this.assertNotLocked(db, accountId, now);
    const factor = await db.admin_mfa_factor.findUnique({ where: { account_id: accountId } });
    if (!factor || factor.status !== 'PENDING') throw new ExamConflictError('Start set-up first');
    const step = verifyTotp(decryptSecret(factor.secret_ciphertext, this.key), code.trim(), now, null);
    if (step === null) return this.fail(db, accountId, 'enrol', now);
    const codes = newRecoveryCodes();
    await db.$transaction(async (tx: any) => {
      const ok = await tx.admin_mfa_factor.updateMany({ where: { id: factor.id, status: 'PENDING' }, data: { status: 'ACTIVE', activated_at: now, last_used_step: BigInt(step) } });
      if (ok.count !== 1) throw new ExamConflictError('Set-up was already confirmed');
      for (const c of codes) await tx.admin_mfa_recovery_code.create({ data: { factor_id: factor.id, code_hash: hashRecoveryCode(c), created_at: now } });
      await tx.auth_session.update({ where: { id: sessionId }, data: { mfa_verified_at: now } });
      await this.audit(tx, accountId, 'mfa.enrolled', {}, now);
    });
    return { recoveryCodes: codes };
  }

  /** The per-session check: a code from the app, or one unused recovery code. */
  async verify(accountId: string, sessionId: string, input: { code?: unknown; recoveryCode?: unknown }, now = new Date()): Promise<{ verified: true; recoveryCodesLeft: number }> {
    const db = this.db.client as any;
    await this.assertNotLocked(db, accountId, now);
    const factor = await db.admin_mfa_factor.findUnique({ where: { account_id: accountId } });
    if (!factor || factor.status !== 'ACTIVE') throw new ExamConflictError('Set up your authenticator app first');
    let method: 'TOTP' | 'RECOVERY_CODE';
    if (typeof input.code === 'string' && input.code.trim()) {
      method = 'TOTP';
      const last = factor.last_used_step === null || factor.last_used_step === undefined ? null : Number(factor.last_used_step);
      const step = verifyTotp(decryptSecret(factor.secret_ciphertext, this.key), input.code.trim(), now, last);
      if (step === null) return this.fail(db, accountId, method, now);
      // Only one request can claim a step: a replayed code loses the race.
      const won = await db.admin_mfa_factor.updateMany({
        where: { id: factor.id, OR: [{ last_used_step: null }, { last_used_step: { lt: BigInt(step) } }] },
        data: { last_used_step: BigInt(step) },
      });
      if (won.count !== 1) return this.fail(db, accountId, method, now);
    } else if (typeof input.recoveryCode === 'string' && input.recoveryCode.trim()) {
      method = 'RECOVERY_CODE';
      const used = await db.admin_mfa_recovery_code.updateMany({ where: { factor_id: factor.id, code_hash: hashRecoveryCode(input.recoveryCode), used_at: null }, data: { used_at: now } });
      if (used.count !== 1) return this.fail(db, accountId, method, now);
    } else {
      throw new ExamInputError('Enter the 6-digit code from your app, or a recovery code');
    }
    await db.auth_session.update({ where: { id: sessionId }, data: { mfa_verified_at: now } });
    await this.audit(db, accountId, 'mfa.verified', { method }, now);
    const left = await db.admin_mfa_recovery_code.count({ where: { factor_id: factor.id, used_at: null } });
    return { verified: true, recoveryCodesLeft: left };
  }

  /** Operator tooling (lost phone): removes the authenticator and ends the check on every session. */
  async reset(accountId: string, operator: string, now = new Date()): Promise<{ removed: boolean }> {
    if (!operator.trim()) throw new ExamInputError('An operator name is required');
    const db = this.db.client as any;
    return db.$transaction(async (tx: any) => {
      const r = await tx.admin_mfa_factor.deleteMany({ where: { account_id: accountId } });
      await tx.auth_session.updateMany({ where: { account_id: accountId, mfa_verified_at: { not: null } }, data: { mfa_verified_at: null } });
      await tx.audit_event.create({ data: { actor_account_id: null, action: 'mfa.reset', subject_type: 'account', subject_id: accountId, metadata: { operator }, occurred_at: now } });
      return { removed: r.count > 0 };
    });
  }

  private async sessionVerified(sessionId: string, now: Date): Promise<boolean> {
    const s = await (this.db.client as any).auth_session.findUnique({ where: { id: sessionId }, select: { mfa_verified_at: true } });
    return isMfaFresh(s?.mfa_verified_at ?? null, now, this.hours);
  }

  private async assertNotLocked(db: any, accountId: string, now: Date): Promise<void> {
    const failures = await db.audit_event.count({
      where: { actor_account_id: accountId, action: 'mfa.verify_failed', occurred_at: { gte: new Date(now.getTime() - MFA_FAILURE_WINDOW_MS) } },
    });
    if (failures >= MFA_MAX_FAILURES) throw new ExamConflictError('Too many wrong codes. Wait 15 minutes and try again.');
  }

  private async fail(db: any, accountId: string, method: string, now: Date): Promise<never> {
    await this.audit(db, accountId, 'mfa.verify_failed', { method }, now);
    throw new ExamInputError('That code did not work. Check the time on your phone and try again.');
  }

  private async audit(db: any, accountId: string, action: string, metadata: Record<string, unknown>, now: Date): Promise<void> {
    await db.audit_event.create({ data: { actor_account_id: accountId, action, subject_type: 'account', subject_id: accountId, metadata, occurred_at: now } });
  }
}
