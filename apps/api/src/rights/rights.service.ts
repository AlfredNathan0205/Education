import { Injectable, Logger } from '@nestjs/common';
import { AnalyticsService } from '../analytics/analytics.service';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError } from '../exam/exam.errors';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';
import {
  BLOCK_MESSAGE,
  DAY_MS,
  ERASURE_MAX_ATTEMPTS,
  ERASURE_WAIT_DAYS,
  EXPORTS_PER_DAY,
  STUDENT_EXPORT_TABLES,
  erasureBlock,
  erasureDueAt,
  exportRow,
  switchOn,
  type ErasureBlock,
  type SubjectType,
} from './rights-domain';

type Db = any;

export interface PendingErasure {
  requestId: string;
  dueAt: string;
  requestedAt: string;
  canCancel: boolean;
}

export interface RightsOverview {
  waitDays: number;
  me: {
    /** STUDENT: the account has its own student profile; ACCOUNT: a parent or guardian account. */
    subjectType: SubjectType;
    erasure: PendingErasure | null;
    /** Why this account cannot ask for deletion now, if it cannot. */
    block: ErasureBlock | null;
    blockMessage: string | null;
  };
  /** Children this account approves as their guardian. */
  children: Array<{ studentId: string; label: string; erasure: PendingErasure | null }>;
}

interface Subject {
  type: SubjectType;
  id: string;
  capacity: 'SELF' | 'GUARDIAN';
}

/**
 * Step 20: the right to a copy of one's data, and to have it erased.
 *
 * Export: immediate, as JSON, audited, at most 3 a day per person and subject.
 * Erasure: asked for by an adult for themselves, or by an approving guardian for a minor; waits 14 days (cancellable),
 * then the hourly saga erases. Erasing DELETES personal data (sign-in identities, sessions, date of birth, name,
 * school, invitations, public handle, friend codes, parent summaries, analytics) and UNLINKS the rest: tests,
 * answers, mastery, points and consent records stay under the student id, which then leads to no person. A tombstone
 * of ids lets the erasure be applied again after a backup restore.
 */
@Injectable()
export class RightsService {
  private readonly logger = new Logger(RightsService.name);

  constructor(
    private readonly db: DatabaseService,
    private readonly privacy: PrivacyService,
    private readonly analytics: AnalyticsService,
    private readonly outbox: OutboxService,
  ) {}

  // ── what the person can do ─────────────────────────────────────────────────

  async overview(accountId: string, now = new Date()): Promise<RightsOverview> {
    const db = this.db.client as Db;
    const own = await this.ownStudent(db, accountId);
    const me: Subject = own ? { type: 'STUDENT', id: own, capacity: 'SELF' } : { type: 'ACCOUNT', id: accountId, capacity: 'SELF' };
    const approvals = await this.privacy.listGuardianApprovals(accountId, now);
    const pending = await this.pendingFor(db, me);
    const block = erasureBlock({
      capacity: 'SELF',
      subjectIsMinor: own ? await this.isMinor(db, own) : false,
      requesterApprovesChildren: approvals.length > 0,
      requesterHasRole: await this.hasRole(db, accountId),
      pending: pending !== null,
    });
    const children = [];
    for (const a of approvals) {
      const p = await this.pendingFor(db, { type: 'STUDENT', id: a.studentId, capacity: 'GUARDIAN' });
      children.push({ studentId: a.studentId, label: a.label, erasure: p ? this.pendingView(p, true) : null });
    }
    return {
      waitDays: ERASURE_WAIT_DAYS,
      me: {
        subjectType: me.type,
        erasure: pending ? this.pendingView(pending, true) : null,
        block: block === 'ALREADY_PENDING' ? null : block,
        blockMessage: block && block !== 'ALREADY_PENDING' ? BLOCK_MESSAGE[block] : null,
      },
      children,
    };
  }

  // ── export ─────────────────────────────────────────────────────────────────

  /** A copy of the data, for the person themselves (no studentId) or for a child they approve. */
  async exportFor(accountId: string, studentId: string | null, now = new Date()): Promise<Record<string, unknown>> {
    const db = this.db.client as Db;
    const subject = await this.resolveSubject(db, accountId, studentId, now);
    const recent = await db.privacy_request.count({
      where: { kind: 'EXPORT', requested_by_account_id: accountId, subject_id: subject.id, requested_at: { gte: new Date(now.getTime() - DAY_MS) } },
    });
    if (recent >= EXPORTS_PER_DAY) throw new ExamConflictError(`You can download a copy ${EXPORTS_PER_DAY} times a day. Please try again tomorrow.`);
    const bundle = subject.type === 'STUDENT' ? await this.studentBundle(db, subject.id, now) : await this.accountBundle(db, subject.id, now);
    await db.$transaction(async (tx: Db) => {
      const r = await tx.privacy_request.create({
        data: { kind: 'EXPORT', subject_type: subject.type, subject_id: subject.id, requested_by_account_id: accountId, capacity: subject.capacity, status: 'COMPLETED', requested_at: now, due_at: now, completed_at: now },
      });
      await tx.audit_event.create({
        data: { actor_account_id: accountId, action: 'privacy.export.downloaded', subject_type: subject.type.toLowerCase(), subject_id: subject.id, metadata: { requestId: r.id, capacity: subject.capacity } },
      });
    });
    return bundle;
  }

  private async studentBundle(db: Db, studentId: string, now: Date): Promise<Record<string, unknown>> {
    const student = await db.student.findUnique({ where: { id: studentId } });
    if (!student) throw new ExamNotFoundError('Not found');
    const tables: Record<string, unknown[]> = {};
    const sessions: any[] = await db.assessment_session.findMany({ where: { student_id: studentId }, select: { id: true } });
    for (const t of STUDENT_EXPORT_TABLES) {
      const where = 'column' in t.by ? { [t.by.column]: studentId } : { [t.by.sessions]: { in: sessions.map((s) => s.id) } };
      const rows: any[] = await db[t.table].findMany({ where });
      tables[t.table] = rows.map(exportRow);
    }
    const consentIds = (tables.consent_record as any[]).map((r) => r.id);
    tables.consent_withdrawal = consentIds.length ? ((await db.consent_withdrawal.findMany({ where: { consent_record_id: { in: consentIds } } })) as any[]).map(exportRow) : [];
    const access: any[] = await db.account_student_access.findMany({ where: { student_id: studentId, access_kind: 'SELF' } });
    const accounts = [];
    for (const a of access) accounts.push(await this.accountPart(db, a.account_id));
    const [friendships, challenges] = await Promise.all([
      db.friendship.count({ where: { OR: [{ student_low: studentId }, { student_high: studentId }] } }),
      db.challenge_participant.count({ where: { student_id: studentId } }),
    ]);
    return {
      format: 'exam-app-export/v1',
      generatedAt: now.toISOString(),
      about: 'STUDENT',
      notes: [
        'This is the data Exam App holds about this student, as stored. Secret codes and internal keys are left out.',
        'Friends and challenges are counted, not listed, because those records also name another student.',
        'Anonymous usage statistics carry a code instead of the student id, so they are counted here.',
        'Reports made about this student by others are not included.',
      ],
      student: exportRow(student),
      accounts,
      tables,
      counts: { friendships, challenges, analyticsEvents: await this.analytics.heldFor(studentId) },
    };
  }

  private async accountBundle(db: Db, accountId: string, now: Date): Promise<Record<string, unknown>> {
    const approvals = await this.privacy.listGuardianApprovals(accountId, now);
    const [granted, viewing, relationships] = await Promise.all([
      db.consent_record.findMany({ where: { granted_by_account_id: accountId } }),
      db.parent_view_grant.findMany({ where: { viewer_account_id: accountId } }),
      db.guardian_relationship.findMany({ where: { guardian_account_id: accountId } }),
    ]);
    return {
      format: 'exam-app-export/v1',
      generatedAt: now.toISOString(),
      about: 'ACCOUNT',
      notes: ['This is the data Exam App holds about this account, as stored. Secret codes and internal keys are left out.', "A child's own data is downloaded separately, from their row on your guardian page."],
      accounts: [await this.accountPart(db, accountId)],
      guardianOf: approvals.map((a) => ({ studentId: a.studentId, label: a.label, approvedAt: a.grantedAt.toISOString() })),
      tables: {
        guardian_relationship: (relationships as any[]).map(exportRow),
        consent_record_granted: (granted as any[]).map(exportRow),
        parent_view_grant: (viewing as any[]).map(exportRow),
      },
    };
  }

  private async accountPart(db: Db, accountId: string): Promise<Record<string, unknown>> {
    const [account, identities, sessions, roles, audiences] = await Promise.all([
      db.account.findUnique({ where: { id: accountId } }),
      db.authentication_identity.findMany({ where: { account_id: accountId } }),
      db.auth_session.findMany({ where: { account_id: accountId }, select: { id: true, created_at: true, expires_at: true, revoked_at: true, last_seen_at: true } }),
      db.role_assignment.findMany({ where: { account_id: accountId }, select: { role_id: true, granted_at: true, revoked_at: true } }),
      // Step 21: early-access audiences (internal testing, private beta).
      db.release_access.findMany({ where: { account_id: accountId }, select: { tier: true, granted_at: true, revoked_at: true } }),
    ]);
    return {
      account: account ? exportRow(account) : null,
      identities: (identities as any[]).map(exportRow),
      sessions: (sessions as any[]).map(exportRow),
      roles: (roles as any[]).map(exportRow),
      earlyAccess: (audiences as any[]).map(exportRow),
    };
  }

  // ── erasure requests ───────────────────────────────────────────────────────

  async requestErasure(accountId: string, studentId: string | null, now = new Date()): Promise<{ requestId: string; dueAt: string }> {
    const db = this.db.client as Db;
    const subject = await this.resolveSubject(db, accountId, studentId, now);
    const pending = await this.pendingFor(db, subject);
    const block = erasureBlock({
      capacity: subject.capacity,
      subjectIsMinor: subject.type === 'STUDENT' && subject.capacity === 'SELF' ? await this.isMinor(db, subject.id) : false,
      requesterApprovesChildren: subject.capacity === 'SELF' ? (await this.privacy.listGuardianApprovals(accountId, now)).length > 0 : false,
      requesterHasRole: subject.capacity === 'SELF' ? await this.hasRole(db, accountId) : false,
      pending: pending !== null,
    });
    if (block === 'ALREADY_PENDING') return { requestId: pending.id, dueAt: pending.due_at.toISOString() };
    if (block) throw new ExamConflictError(BLOCK_MESSAGE[block]);
    const dueAt = erasureDueAt(now);
    const row = await db.$transaction(async (tx: Db) => {
      const r = await tx.privacy_request.create({
        data: { kind: 'ERASURE', subject_type: subject.type, subject_id: subject.id, requested_by_account_id: accountId, capacity: subject.capacity, status: 'PENDING', requested_at: now, due_at: dueAt },
      });
      await tx.audit_event.create({
        data: { actor_account_id: accountId, action: 'privacy.erasure.requested', subject_type: subject.type.toLowerCase(), subject_id: subject.id, metadata: { requestId: r.id, capacity: subject.capacity, dueAt: dueAt.toISOString() } },
      });
      await this.outbox.publish(tx, {
        aggregateType: subject.type.toLowerCase(),
        aggregateId: subject.id,
        eventType: 'privacy.erasure.requested.v1',
        payload: { requestId: r.id, subjectType: subject.type, subjectId: subject.id, dueAt: dueAt.toISOString() },
        idempotencyKey: `erasure-requested:${r.id}`,
      });
      return r;
    });
    return { requestId: row.id, dueAt: dueAt.toISOString() };
  }

  /** Whoever asked, an approving guardian of the student, or the adult student themselves can cancel while it waits. */
  async cancelErasure(accountId: string, requestId: string, now = new Date()): Promise<{ cancelled: true }> {
    const db = this.db.client as Db;
    const r = await db.privacy_request.findUnique({ where: { id: requestId } });
    if (!r || r.kind !== 'ERASURE') throw new ExamNotFoundError('Not found');
    if (!(await this.mayCancel(db, accountId, r, now))) throw new ExamNotFoundError('Not found');
    if (r.status !== 'PENDING') throw new ExamConflictError(r.status === 'CANCELLED' ? 'This was already cancelled' : 'Deletion has already started or finished');
    await db.$transaction(async (tx: Db) => {
      const n = await tx.privacy_request.updateMany({ where: { id: r.id, status: 'PENDING' }, data: { status: 'CANCELLED', cancelled_at: now, cancelled_by_account_id: accountId } });
      if (n.count !== 1) throw new ExamConflictError('Deletion has already started or finished');
      await tx.audit_event.create({ data: { actor_account_id: accountId, action: 'privacy.erasure.cancelled', subject_type: String(r.subject_type).toLowerCase(), subject_id: r.subject_id, metadata: { requestId: r.id } } });
    });
    return { cancelled: true };
  }

  // ── the saga ───────────────────────────────────────────────────────────────

  /**
   * Runs erasures that are due. Each is claimed with a one-hour lease (so a crashed run is picked up again), checked
   * again (the person may have become a guardian or an administrator since asking), and erased in one transaction.
   */
  async runDue(now = new Date(), limit = 20): Promise<{ completed: number; failed: number }> {
    if (!switchOn('ERASURE_ENABLED')) return { completed: 0, failed: 0 };
    const db = this.db.client as Db;
    const due: any[] = await db.privacy_request.findMany({
      where: { kind: 'ERASURE', status: { in: ['PENDING', 'RUNNING'] }, due_at: { lte: now } },
      orderBy: { due_at: 'asc' },
      take: limit,
    });
    let completed = 0;
    let failed = 0;
    for (const r of due) {
      const claimed = await db.privacy_request.updateMany({
        where: { id: r.id, status: r.status, due_at: { lte: now } },
        data: { status: 'RUNNING', due_at: new Date(now.getTime() + 3_600_000), attempts: { increment: 1 } },
      });
      if (claimed.count !== 1) continue;
      try {
        const block = await this.blockAtRun(db, r, now);
        if (block) {
          await this.finish(db, r.id, 'FAILED', block, now);
          failed++;
          continue;
        }
        await db.$transaction(async (tx: Db) => {
          const accounts = r.subject_type === 'STUDENT' ? await this.eraseStudent(tx, r.subject_id, r.requested_by_account_id, now) : await this.eraseAccount(tx, r.subject_id, r.requested_by_account_id, now);
          await this.tombstone(tx, r.subject_type, r.subject_id, accounts, r.id, now);
          await tx.privacy_request.update({ where: { id: r.id }, data: { status: 'COMPLETED', completed_at: now, failure_code: null } });
          await tx.audit_event.create({ data: { actor_account_id: r.requested_by_account_id, action: 'privacy.erasure.completed', subject_type: String(r.subject_type).toLowerCase(), subject_id: r.subject_id, metadata: { requestId: r.id } } });
          await this.outbox.publish(tx, {
            aggregateType: String(r.subject_type).toLowerCase(),
            aggregateId: r.subject_id,
            eventType: 'privacy.erased.v1',
            payload: { requestId: r.id, subjectType: r.subject_type, subjectId: r.subject_id },
            idempotencyKey: `erased:${r.id}`,
          });
        });
        completed++;
      } catch (e) {
        const attempts = (r.attempts ?? 0) + 1;
        this.logger.error(`erasure ${r.id} failed (attempt ${attempts}): ${(e as Error).message}`);
        await this.finish(db, r.id, attempts >= ERASURE_MAX_ATTEMPTS ? 'FAILED' : 'PENDING', (e as Error).name.slice(0, 64), now);
        failed++;
      }
    }
    return { completed, failed };
  }

  private async finish(db: Db, id: string, status: 'FAILED' | 'PENDING', code: string, now: Date): Promise<void> {
    await db.privacy_request.update({ where: { id }, data: { status, failure_code: code, due_at: now } });
  }

  private async blockAtRun(db: Db, r: any, now: Date): Promise<string | null> {
    if (r.capacity === 'GUARDIAN') {
      const still = (await this.privacy.listGuardianApprovals(r.requested_by_account_id, now)).some((a) => a.studentId === r.subject_id);
      return still ? null : 'GUARDIAN_NO_LONGER_APPROVES';
    }
    if (await this.hasRole(db, r.requested_by_account_id)) return 'ADMIN_ROLE';
    if ((await this.privacy.listGuardianApprovals(r.requested_by_account_id, now)).length > 0) return 'GUARDIAN_OF_CHILDREN';
    return null;
  }

  /**
   * Erases a student and their own account(s). Idempotent: running it again (after a backup restore) changes nothing
   * more. Returns the accounts erased with the student.
   */
  async eraseStudent(tx: Db, studentId: string, actorAccountId: string | null, now: Date): Promise<string[]> {
    const own: any[] = await tx.account_student_access.findMany({ where: { student_id: studentId, access_kind: 'SELF' }, select: { account_id: true } });
    const accounts = [...new Set(own.map((a) => a.account_id as string))];
    const actor = actorAccountId ?? accounts[0] ?? null;

    // Analytics (pseudonymous) and every live consent. Consent records and withdrawals are kept as evidence.
    await this.analytics.forget(studentId, tx);
    if (actor) await this.privacy.withdrawAllForErasure({ studentId, actorAccountId: actor }, tx, now);

    // Parent sharing and summaries, guardian invitations (they hold email addresses).
    await tx.parent_view_grant.deleteMany({ where: { student_id: studentId } });
    await tx.parent_share_invitation.deleteMany({ where: { student_id: studentId } });
    await tx.student_report.deleteMany({ where: { student_id: studentId } });
    await tx.guardian_invitation.deleteMany({ where: { student_id: studentId } });

    // Guardian links end (the rows stay as the evidence behind the consent records).
    const rels: any[] = await tx.guardian_relationship.findMany({ where: { student_id: studentId }, select: { id: true } });
    if (rels.length) {
      await tx.guardian_authority.updateMany({ where: { guardian_relationship_id: { in: rels.map((x) => x.id) }, revoked_at: null }, data: { revoked_at: now } });
      await tx.guardian_relationship.updateMany({ where: { student_id: studentId, status: { not: 'REVOKED' } }, data: { status: 'REVOKED' } });
    }

    // Social: the public handle goes, so leaderboards and friends never show the student again.
    await tx.public_profile.deleteMany({ where: { student_id: studentId } });
    await tx.friend_code.deleteMany({ where: { OR: [{ student_id: studentId }, { used_by_student_id: studentId }] } });
    await tx.friend_code_attempt.deleteMany({ where: { student_id: studentId } });
    await tx.student_block.deleteMany({ where: { OR: [{ blocker_student_id: studentId }, { blocked_student_id: studentId }] } });
    const open: any[] = await tx.friendship.findMany({ where: { OR: [{ student_low: studentId }, { student_high: studentId }], status: { not: 'ENDED' } }, select: { id: true } });
    if (open.length) {
      const ids = open.map((f) => f.id);
      await tx.friendship_guardian_approval.updateMany({ where: { friendship_id: { in: ids }, status: 'PENDING' }, data: { status: 'DECLINED', decided_at: now } });
      await tx.friendship.updateMany({ where: { id: { in: ids } }, data: { status: 'ENDED', ended_at: now, ended_reason: 'ERASED', ended_by_student_id: studentId } });
    }
    await tx.challenge.updateMany({ where: { OR: [{ challenger_student_id: studentId }, { opponent_student_id: studentId }], status: { in: ['PENDING', 'ACTIVE'] } }, data: { status: 'CANCELLED' } });

    // School (a school and year can point at a person), plans and grants.
    await tx.student_school_association.deleteMany({ where: { student_id: studentId } });
    const subs: any[] = await tx.subscription.findMany({ where: { student_id: studentId, status: 'ACTIVE' }, select: { id: true } });
    for (const s of subs) {
      await tx.subscription.update({ where: { id: s.id }, data: { status: 'ENDED', ended_at: now, ended_reason: 'ERASED' } });
      await tx.subscription_event.create({ data: { subscription_id: s.id, type: 'ENDED', actor_account_id: actor, reason: 'Erased', at: now } });
    }
    await tx.entitlement_grant.updateMany({ where: { student_id: studentId }, data: { reason: 'Erased' } });
    if (actor) await tx.entitlement_grant.updateMany({ where: { student_id: studentId, revoked_at: null }, data: { revoked_at: now, revoked_by_account_id: actor } });

    // Identity: date of birth, name, and every link from an account to the student.
    await tx.age_classification.deleteMany({ where: { student_id: studentId } });
    await tx.student.update({ where: { id: studentId }, data: { display_name: null, erased_at: now } });
    await tx.account_student_access.deleteMany({ where: { student_id: studentId } });

    for (const a of accounts) await this.eraseAccountCore(tx, a, now);
    return accounts;
  }

  /** Erases a parent's or guardian's own account (they approve no child and hold no role: checked before). */
  async eraseAccount(tx: Db, accountId: string, _actor: string | null, now: Date): Promise<string[]> {
    const rels: any[] = await tx.guardian_relationship.findMany({ where: { guardian_account_id: accountId }, select: { id: true } });
    if (rels.length) {
      await tx.guardian_authority.updateMany({ where: { guardian_relationship_id: { in: rels.map((x) => x.id) }, revoked_at: null }, data: { revoked_at: now } });
      await tx.guardian_relationship.updateMany({ where: { guardian_account_id: accountId, status: { not: 'REVOKED' } }, data: { status: 'REVOKED' } });
    }
    await this.eraseAccountCore(tx, accountId, now);
    return [accountId];
  }

  /** What every erased account loses: sign-in identities, sessions, codes, its authenticator, invitations and views. */
  private async eraseAccountCore(tx: Db, accountId: string, now: Date): Promise<void> {
    const identities: any[] = await tx.authentication_identity.findMany({ where: { account_id: accountId }, select: { identifier_normalized: true } });
    const ids = identities.map((i) => i.identifier_normalized as string);
    // Viewing someone else's summary: the student's sharing consent for this viewer ends with it.
    const views: any[] = await tx.parent_view_grant.findMany({ where: { viewer_account_id: accountId }, select: { consent_record_id: true } });
    if (views.length) await this.privacy.withdrawAllForErasure({ consentRecordIds: views.map((v) => v.consent_record_id), actorAccountId: accountId }, tx, now);
    await tx.parent_view_grant.deleteMany({ where: { viewer_account_id: accountId } });
    await tx.parent_share_invitation.deleteMany({ where: { OR: [{ accepted_by_account_id: accountId }, ...(ids.length ? [{ email_normalized: { in: ids } }] : [])] } });
    await tx.guardian_invitation.deleteMany({ where: { OR: [{ accepted_by_account_id: accountId }, ...(ids.length ? [{ guardian_email_normalized: { in: ids } }] : [])] } });
    if (ids.length) await tx.otp_challenge.deleteMany({ where: { identifier_normalized: { in: ids } } });
    await tx.authentication_identity.deleteMany({ where: { account_id: accountId } });
    await tx.auth_session.deleteMany({ where: { account_id: accountId } });
    await tx.admin_mfa_factor.deleteMany({ where: { account_id: accountId } });
    // Step 21: a test audience (internal or beta) is a link to the person.
    await tx.release_access.deleteMany({ where: { account_id: accountId } });
    await tx.role_assignment.updateMany({ where: { account_id: accountId, revoked_at: null }, data: { revoked_at: now } });
    await tx.account.update({ where: { id: accountId }, data: { status: 'CLOSED', erased_at: now, last_sign_in_at: null } });
  }

  private async tombstone(tx: Db, type: SubjectType, subjectId: string, accounts: string[], requestId: string | null, now: Date): Promise<void> {
    await tx.deletion_tombstone.upsert({
      where: { subject_type_subject_id: { subject_type: type, subject_id: subjectId } },
      create: { subject_type: type, subject_id: subjectId, account_ids: accounts, request_id: requestId, erased_at: now },
      update: {},
    });
  }

  // ── after a backup restore ─────────────────────────────────────────────────

  async tombstones(): Promise<Array<{ subjectType: SubjectType; subjectId: string; accountIds: string[]; erasedAt: string }>> {
    const rows: any[] = await (this.db.client as Db).deletion_tombstone.findMany({ orderBy: { erased_at: 'asc' } });
    return rows.map((r) => ({ subjectType: r.subject_type, subjectId: r.subject_id, accountIds: r.account_ids ?? [], erasedAt: r.erased_at.toISOString() }));
  }

  /**
   * Applies erasures again (a restored backup brings erased data back). Takes the tombstones kept outside the database;
   * re-creates each tombstone too. Rows that no longer exist are skipped.
   */
  async reapply(list: Array<{ subjectType: string; subjectId: string; accountIds?: string[] }>, now = new Date()): Promise<{ applied: number; skipped: number }> {
    const db = this.db.client as Db;
    let applied = 0;
    let skipped = 0;
    for (const t of list) {
      if (!/^[0-9a-f-]{36}$/i.test(t.subjectId) || (t.subjectType !== 'STUDENT' && t.subjectType !== 'ACCOUNT')) throw new ExamInputError(`Not a tombstone: ${JSON.stringify(t)}`);
      const exists = t.subjectType === 'STUDENT' ? await db.student.findUnique({ where: { id: t.subjectId } }) : await db.account.findUnique({ where: { id: t.subjectId } });
      if (!exists) {
        skipped++;
        continue;
      }
      await db.$transaction(async (tx: Db) => {
        let accounts: string[];
        if (t.subjectType === 'STUDENT') {
          accounts = await this.eraseStudent(tx, t.subjectId, null, now);
          // Accounts that lost their link in a partial restore are erased too.
          for (const a of t.accountIds ?? []) if (!accounts.includes(a) && (await tx.account.findUnique({ where: { id: a } }))) await this.eraseAccountCore(tx, a, now);
          accounts = [...new Set([...accounts, ...(t.accountIds ?? [])])];
        } else {
          accounts = await this.eraseAccount(tx, t.subjectId, null, now);
        }
        await this.tombstone(tx, t.subjectType as SubjectType, t.subjectId, accounts, null, now);
        await tx.audit_event.create({ data: { actor_account_id: null, action: 'privacy.erasure.reapplied', subject_type: t.subjectType.toLowerCase(), subject_id: t.subjectId } });
      });
      applied++;
    }
    return { applied, skipped };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async resolveSubject(db: Db, accountId: string, studentId: string | null, now: Date): Promise<Subject> {
    const own = await this.ownStudent(db, accountId);
    if (!studentId || studentId === own) return own ? { type: 'STUDENT', id: own, capacity: 'SELF' } : { type: 'ACCOUNT', id: accountId, capacity: 'SELF' };
    const approves = (await this.privacy.listGuardianApprovals(accountId, now)).some((a) => a.studentId === studentId);
    if (!approves) throw new ExamNotFoundError('Not found');
    return { type: 'STUDENT', id: studentId, capacity: 'GUARDIAN' };
  }

  private async mayCancel(db: Db, accountId: string, r: any, now: Date): Promise<boolean> {
    if (r.requested_by_account_id === accountId) return true;
    if (r.subject_type === 'ACCOUNT') return r.subject_id === accountId;
    if ((await this.ownStudent(db, accountId)) === r.subject_id) return !(await this.isMinor(db, r.subject_id));
    return (await this.privacy.listGuardianApprovals(accountId, now)).some((a) => a.studentId === r.subject_id);
  }

  private async pendingFor(db: Db, s: Subject): Promise<any | null> {
    return db.privacy_request.findFirst({ where: { kind: 'ERASURE', subject_type: s.type, subject_id: s.id, status: { in: ['PENDING', 'RUNNING'] } }, orderBy: { requested_at: 'desc' } });
  }

  private pendingView(r: any, canCancel: boolean): PendingErasure {
    return { requestId: r.id, dueAt: r.due_at.toISOString(), requestedAt: r.requested_at.toISOString(), canCancel: canCancel && r.status === 'PENDING' };
  }

  private async ownStudent(db: Db, accountId: string): Promise<string | null> {
    const a = await db.account_student_access.findFirst({ where: { account_id: accountId, access_kind: 'SELF', revoked_at: null }, select: { student_id: true } });
    return a?.student_id ?? null;
  }

  /** Only a current classification as a minor counts: an unclassified student may delete their own account. */
  private async isMinor(db: Db, studentId: string): Promise<boolean> {
    const c = await db.age_classification.findFirst({ where: { student_id: studentId, superseded_at: null }, select: { is_minor: true } });
    return c?.is_minor === true;
  }

  private async hasRole(db: Db, accountId: string): Promise<boolean> {
    return (await db.role_assignment.count({ where: { account_id: accountId, revoked_at: null } })) > 0;
  }
}
