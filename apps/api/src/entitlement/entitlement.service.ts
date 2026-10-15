import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { AuthzService } from '../authz/authz.service';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { InvalidIdentifierError, maskIdentifier, normalizeIdentifier } from '../identity/identifier';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';
import {
  ENTITLEMENT_KEYS,
  FREE_VALUES,
  REFUSAL_TEXT,
  activeAt,
  dayOf,
  mostGenerous,
  parseGrantValue,
  parseValues,
  startRefusal,
  withGrants,
  type EntitlementKey,
  type EntitlementValues,
} from './entitlement-domain';

type Tx = Prisma.TransactionClient;

/** A student's plan as the student sees it: names, dates and limits; never prices (there are none yet). */
export interface MyPlanView {
  planName: string;
  sources: Array<{ planName: string; source: string; endsAt: string | null }>;
  values: EntitlementValues;
  startedToday: number;
  /** null = no daily limit. */
  leftToday: number | null;
}

export interface StaffEntitlementView {
  studentId: string;
  label: string;
  effective: EntitlementValues;
  subscriptions: Array<{ id: string; planCode: string; source: string; status: string; startsAt: string; endsAt: string | null; holder: string | null; events: Array<{ type: string; at: string; reason: string | null }> }>;
  grants: Array<{ id: string; key: string; value: unknown; endsAt: string; reason: string; revoked: boolean }>;
  plans: Array<{ code: string; name: string; isDefault: boolean }>;
}

/**
 * Step 18: plans, subscriptions and entitlements (spec DOMAIN_MAP 17; CANONICAL_DATA_MODEL: plan, subscription,
 * subscription_event, entitlement, entitlement_grant). No payment provider yet (PM decision, 15 October): plans are
 * granted by an administrator, and during the private beta every student gets a time-limited BETA plan.
 *
 * What a student may do is the most generous of the default FREE plan, every active subscription, and every live
 * single-entitlement grant. Entitlements limit only what a student may START themselves: a long test, or more than the
 * day's number of self-chosen tests or practice sets. Recommended practice, retests and challenges are never limited,
 * so the free plan keeps the complete core loop (spec D09). Nothing here is read by mastery, claims or competition.
 */
@Injectable()
export class EntitlementService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly privacy: PrivacyService,
    private readonly outbox: OutboxService,
  ) {}

  // ── reading ─────────────────────────────────────────────────────────────────

  async effective(studentId: string, now = new Date(), client?: any): Promise<{ values: EntitlementValues; sources: MyPlanView['sources']; defaultName: string }> {
    const db = client ?? (this.db.client as any);
    const def = await db.plan.findFirst({ where: { is_default: true, status: 'ACTIVE' } });
    const base = def ? parseValues(def.values) : FREE_VALUES;
    const subs: any[] = await db.subscription.findMany({ where: { student_id: studentId, status: 'ACTIVE' }, include: { plan: true } });
    const live = subs.filter((s) => activeAt({ status: s.status, startsAt: s.starts_at, endsAt: s.ends_at }, now));
    const grants: any[] = await db.entitlement_grant.findMany({ where: { student_id: studentId, revoked_at: null } });
    const liveGrants = grants.filter((g) => g.starts_at <= now && g.ends_at > now);
    const values = withGrants(
      mostGenerous([base, ...live.map((s) => parseValues(s.plan.values))]),
      liveGrants.map((g) => ({ key: g.entitlement_key as EntitlementKey, value: parseGrantValue(g.entitlement_key as EntitlementKey, g.value) })),
    );
    return {
      values,
      sources: live.map((s) => ({ planName: s.plan.name, source: s.source, endsAt: s.ends_at ? s.ends_at.toISOString() : null })),
      defaultName: def?.name ?? 'Free',
    };
  }

  /** Tests and practice sets the student started themselves today (not from a recommendation, not a challenge). */
  async startedToday(studentId: string, now = new Date(), client?: any): Promise<number> {
    const db = client ?? (this.db.client as any);
    const day = dayOf(now);
    return db.assessment_instance.count({
      where: { student_id: studentId, assembled_at: { gte: day.start, lt: day.end }, recommendation_id: null, NOT: { blueprint_code: 'CHALLENGE10' } },
    });
  }

  /** Called by the exam service, inside its transaction, before a self-chosen test or practice set is built. */
  async assertCanStart(tx: Tx, studentId: string, totalQuestions: number, now = new Date()): Promise<void> {
    const { values } = await this.effective(studentId, now, tx);
    const refusal = startRefusal(values, { totalQuestions, startedToday: await this.startedToday(studentId, now, tx) });
    if (refusal) throw new ExamNotPermittedError(REFUSAL_TEXT[refusal]);
  }

  /** How many weeks of weekly reports may be opened for this student (null = all). */
  async reportWeeks(studentId: string, now = new Date()): Promise<number | null> {
    return (await this.effective(studentId, now)).values.PARENT_REPORT_WEEKS;
  }

  async mine(accountId: string, now = new Date()): Promise<MyPlanView> {
    const studentId = await this.ownStudent(accountId);
    const { values, sources, defaultName } = await this.effective(studentId, now);
    const started = await this.startedToday(studentId, now);
    return {
      planName: sources.length ? sources.map((s) => s.planName).join(' + ') : defaultName,
      sources,
      values,
      startedToday: started,
      leftToday: values.SELF_TESTS_PER_DAY === null ? null : Math.max(0, values.SELF_TESTS_PER_DAY - started),
    };
  }

  // ── administration (SUPER_ADMIN only; every action audited) ────────────────

  async lookup(adminId: string, email: unknown): Promise<{ studentId: string }> {
    await this.requireAdmin(adminId);
    let normalized: string;
    try {
      normalized = normalizeIdentifier('EMAIL', String(email ?? ''));
    } catch (e) {
      if (e instanceof InvalidIdentifierError) throw new ExamInputError('Enter a valid email address');
      throw e;
    }
    const db = this.db.client as any;
    const identity = await db.authentication_identity.findFirst({ where: { kind: 'EMAIL', identifier_normalized: normalized } });
    const access = identity ? await db.account_student_access.findFirst({ where: { account_id: identity.account_id, access_kind: 'SELF', revoked_at: null } }) : null;
    if (!access) throw new ExamNotFoundError('No student signs in with that address');
    return { studentId: access.student_id };
  }

  async forStaff(adminId: string, studentId: string, now = new Date()): Promise<StaffEntitlementView> {
    await this.requireAdmin(adminId);
    const db = this.db.client as any;
    const student = await db.student.findUnique({ where: { id: studentId }, select: { id: true } });
    if (!student) throw new ExamNotFoundError('Student not found');
    const { values } = await this.effective(studentId, now);
    const subs: any[] = await db.subscription.findMany({ where: { student_id: studentId }, include: { plan: true, events: { orderBy: { at: 'asc' } } }, orderBy: { created_at: 'desc' } });
    const grants: any[] = await db.entitlement_grant.findMany({ where: { student_id: studentId }, orderBy: { created_at: 'desc' } });
    const plans: any[] = await db.plan.findMany({ where: { status: 'ACTIVE' }, orderBy: { code: 'asc' } });
    const holders = await this.maskedAccounts(db, subs.map((s) => s.holder_account_id).filter(Boolean));
    await this.audit(adminId, 'entitlement.viewed_by_staff', studentId, {});
    return {
      studentId,
      label: (await this.privacy.studentLabels([studentId])).get(studentId) ?? 'Student',
      effective: values,
      subscriptions: subs.map((s) => ({
        id: s.id,
        planCode: s.plan.code,
        source: s.source,
        status: s.status,
        startsAt: s.starts_at.toISOString(),
        endsAt: s.ends_at ? s.ends_at.toISOString() : null,
        holder: s.holder_account_id ? holders.get(s.holder_account_id) ?? 'account' : null,
        events: s.events.map((e: any) => ({ type: e.type, at: e.at.toISOString(), reason: e.reason })),
      })),
      grants: grants.map((g) => ({ id: g.id, key: g.entitlement_key, value: g.value, endsAt: g.ends_at.toISOString(), reason: g.reason, revoked: !!g.revoked_at })),
      plans: plans.map((p) => ({ code: p.code, name: p.name, isDefault: p.is_default })),
    };
  }

  /**
   * Grants a plan to a student. The holder (optional) is the adult the plan is for: the student themselves if adult, a
   * guardian with a live approval, or a parent the adult student shares with. Holding it gives no access to anything.
   */
  async grantPlan(
    adminId: string,
    input: { studentId: string; planCode: unknown; holderEmail?: unknown; endsAt?: unknown; reason: unknown },
    now = new Date(),
  ): Promise<{ subscriptionId: string }> {
    await this.requireAdmin(adminId);
    const reason = this.reasonOf(input.reason);
    const endsAt = this.endOf(input.endsAt, now, true);
    const db = this.db.client as any;
    const plan = typeof input.planCode === 'string' ? await db.plan.findUnique({ where: { code: input.planCode } }) : null;
    if (!plan || plan.status !== 'ACTIVE') throw new ExamInputError('Choose an active plan');
    if (plan.is_default) throw new ExamInputError('Everyone has the default plan already');
    if (plan.code === 'BETA') throw new ExamInputError('The beta plan is granted automatically while the beta runs');
    const holder = input.holderEmail ? await this.holderFor(db, input.studentId, input.holderEmail, now) : null;
    return this.db.client.$transaction(async (tx: Tx) => {
      const t = tx as any;
      await t.$queryRaw`SELECT id FROM student WHERE id = ${input.studentId}::uuid FOR UPDATE`;
      const sub = await t.subscription.create({
        data: { student_id: input.studentId, plan_id: plan.id, holder_account_id: holder, source: 'ADMIN_GRANT', status: 'ACTIVE', starts_at: now, ends_at: endsAt, created_by_account_id: adminId },
      });
      await t.subscription_event.create({ data: { subscription_id: sub.id, type: 'CREATED', actor_account_id: adminId, reason, at: now, details: { planCode: plan.code } } });
      await this.audited(tx, adminId, 'entitlement.plan_granted', input.studentId, { subscriptionId: sub.id, planCode: plan.code });
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: input.studentId,
        eventType: 'entitlement.subscription_created.v1',
        payload: { studentId: input.studentId, subscriptionId: sub.id, planCode: plan.code, source: 'ADMIN_GRANT', endsAt: endsAt?.toISOString() ?? null },
        idempotencyKey: `subscription-created:${sub.id}`,
      });
      return { subscriptionId: sub.id as string };
    });
  }

  async endSubscription(adminId: string, subscriptionId: string, reasonRaw: unknown, now = new Date()): Promise<{ ended: true }> {
    await this.requireAdmin(adminId);
    const reason = this.reasonOf(reasonRaw);
    await this.db.client.$transaction(async (tx: Tx) => {
      const t = tx as any;
      const sub = await t.subscription.findUnique({ where: { id: subscriptionId } });
      if (!sub) throw new ExamNotFoundError('Subscription not found');
      if (sub.status !== 'ACTIVE') throw new ExamConflictError('This subscription has already ended');
      await t.subscription.update({ where: { id: sub.id }, data: { status: 'ENDED', ended_at: now, ended_reason: 'ADMIN_ENDED' } });
      await t.subscription_event.create({ data: { subscription_id: sub.id, type: 'ENDED', actor_account_id: adminId, reason, at: now } });
      await this.audited(tx, adminId, 'entitlement.plan_ended', sub.student_id, { subscriptionId: sub.id });
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: sub.student_id,
        eventType: 'entitlement.subscription_ended.v1',
        payload: { studentId: sub.student_id, subscriptionId: sub.id, reason: 'ADMIN_ENDED' },
        idempotencyKey: `subscription-ended:${sub.id}`,
      });
    });
    return { ended: true };
  }

  async grantEntitlement(
    adminId: string,
    input: { studentId: string; key: unknown; value: unknown; endsAt: unknown; reason: unknown },
    now = new Date(),
  ): Promise<{ grantId: string }> {
    await this.requireAdmin(adminId);
    if (typeof input.key !== 'string' || !(ENTITLEMENT_KEYS as string[]).includes(input.key)) throw new ExamInputError('Choose an entitlement');
    const key = input.key as EntitlementKey;
    let value: number | null | boolean;
    try {
      value = parseGrantValue(key, input.value);
    } catch (e) {
      throw new ExamInputError((e as Error).message);
    }
    const reason = this.reasonOf(input.reason);
    const endsAt = this.endOf(input.endsAt, now, false)!;
    const db = this.db.client as any;
    if (!(await db.student.findUnique({ where: { id: input.studentId }, select: { id: true } }))) throw new ExamNotFoundError('Student not found');
    return this.db.client.$transaction(async (tx: Tx) => {
      const g = await (tx as any).entitlement_grant.create({
        data: { student_id: input.studentId, entitlement_key: key, value: value as any, starts_at: now, ends_at: endsAt, reason, granted_by_account_id: adminId },
      });
      await this.audited(tx, adminId, 'entitlement.granted', input.studentId, { grantId: g.id, key });
      return { grantId: g.id as string };
    });
  }

  async revokeGrant(adminId: string, grantId: string, now = new Date()): Promise<{ revoked: true }> {
    await this.requireAdmin(adminId);
    await this.db.client.$transaction(async (tx: Tx) => {
      const t = tx as any;
      const g = await t.entitlement_grant.findUnique({ where: { id: grantId } });
      if (!g) throw new ExamNotFoundError('Grant not found');
      const n = await t.entitlement_grant.updateMany({ where: { id: grantId, revoked_at: null }, data: { revoked_at: now, revoked_by_account_id: adminId } });
      if (n.count) await this.audited(tx, adminId, 'entitlement.grant_revoked', g.student_id, { grantId });
    });
    return { revoked: true };
  }

  // ── beta grants and expiry (run by the sweeper) ─────────────────────────────

  /**
   * Ends subscriptions whose period is over; and while the beta runs (`until` set), gives every student a BETA plan
   * to `until`, or extends theirs if the date moved later. Recorded per student, so the beta can end cleanly.
   */
  async reconcile(until: Date | null, now = new Date(), limit = 200): Promise<{ expired: number; granted: number; extended: number }> {
    const db = this.db.client as any;
    let expired = 0;
    let granted = 0;
    let extended = 0;
    const due: any[] = await db.subscription.findMany({ where: { status: 'ACTIVE', ends_at: { lte: now } }, take: limit });
    for (const s of due) {
      await this.db.client.$transaction(async (tx: Tx) => {
        const t = tx as any;
        const n = await t.subscription.updateMany({ where: { id: s.id, status: 'ACTIVE' }, data: { status: 'ENDED', ended_at: now, ended_reason: 'EXPIRED' } });
        if (!n.count) return;
        await t.subscription_event.create({ data: { subscription_id: s.id, type: 'EXPIRED', at: now } });
        await this.outbox.publish(tx, {
          aggregateType: 'student',
          aggregateId: s.student_id,
          eventType: 'entitlement.subscription_ended.v1',
          payload: { studentId: s.student_id, subscriptionId: s.id, reason: 'EXPIRED' },
          idempotencyKey: `subscription-ended:${s.id}`,
        });
        expired++;
      });
    }
    if (!until) return { expired, granted, extended };
    const beta = await db.plan.findUnique({ where: { code: 'BETA' } });
    if (!beta || beta.status !== 'ACTIVE') return { expired, granted, extended };

    const missing: Array<{ id: string }> = await db.$queryRaw`
      SELECT s.id FROM student s
      WHERE EXISTS (SELECT 1 FROM account_student_access a WHERE a.student_id = s.id AND a.access_kind = 'SELF' AND a.revoked_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM subscription b WHERE b.student_id = s.id AND b.plan_id = ${beta.id}::uuid AND b.status = 'ACTIVE')
      LIMIT ${limit}`;
    for (const m of missing) {
      try {
        await this.db.client.$transaction(async (tx: Tx) => {
          const t = tx as any;
          const sub = await t.subscription.create({ data: { student_id: m.id, plan_id: beta.id, holder_account_id: null, source: 'BETA', status: 'ACTIVE', starts_at: now, ends_at: until } });
          await t.subscription_event.create({ data: { subscription_id: sub.id, type: 'CREATED', at: now, reason: 'Private beta', details: { until: until.toISOString() } } });
          await this.outbox.publish(tx, {
            aggregateType: 'student',
            aggregateId: m.id,
            eventType: 'entitlement.subscription_created.v1',
            payload: { studentId: m.id, subscriptionId: sub.id, planCode: 'BETA', source: 'BETA', endsAt: until.toISOString() },
            idempotencyKey: `subscription-created:${sub.id}`,
          });
        });
        granted++;
      } catch (e) {
        // Another instance granted it first (one ACTIVE beta per student, enforced by the database).
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
    }
    const shorter: any[] = await db.subscription.findMany({ where: { plan_id: beta.id, status: 'ACTIVE', ends_at: { lt: until } }, take: limit });
    for (const s of shorter) {
      await this.db.client.$transaction(async (tx: Tx) => {
        const t = tx as any;
        await t.subscription.update({ where: { id: s.id }, data: { ends_at: until } });
        await t.subscription_event.create({ data: { subscription_id: s.id, type: 'EXTENDED', at: now, details: { from: s.ends_at?.toISOString() ?? null, to: until.toISOString() } } });
      });
      extended++;
    }
    return { expired, granted, extended };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The adult a plan is for. Never a minor; and only someone already connected to the student. */
  private async holderFor(db: any, studentId: string, email: unknown, now: Date): Promise<string> {
    let normalized: string;
    try {
      normalized = normalizeIdentifier('EMAIL', String(email ?? ''));
    } catch {
      throw new ExamInputError("Enter the holder's email address");
    }
    const identity = await db.authentication_identity.findFirst({ where: { kind: 'EMAIL', identifier_normalized: normalized } });
    if (!identity) throw new ExamNotFoundError('No account signs in with that address');
    const acct = identity.account_id as string;
    const own = await db.account_student_access.findFirst({ where: { account_id: acct, access_kind: 'SELF', revoked_at: null } });
    if (own) {
      const summary = await this.privacy.getClassificationSummary(own.student_id);
      if (summary.requiresGuardianConsent) throw new ExamInputError('A minor cannot hold a plan');
    }
    if (own?.student_id === studentId) return acct;
    if ((await this.privacy.listGuardianApprovals(acct, now)).some((g) => g.studentId === studentId)) return acct;
    const grants: any[] = await db.parent_view_grant.findMany({ where: { viewer_account_id: acct, student_id: studentId, ended_at: null } });
    if (grants.length) {
      const withdrawn = await db.consent_withdrawal.count({ where: { consent_record_id: { in: grants.map((g) => g.consent_record_id) } } });
      if (withdrawn < grants.length) return acct;
    }
    throw new ExamInputError("The holder must be the student (if an adult), their approving guardian, or a parent they share their summary with");
  }

  private reasonOf(raw: unknown): string {
    const r = typeof raw === 'string' ? raw.trim() : '';
    if (r.length < 5 || r.length > 300) throw new ExamInputError('Give a reason (5 to 300 characters)');
    return r;
  }

  private endOf(raw: unknown, now: Date, optional: boolean): Date | null {
    if ((raw === undefined || raw === null || raw === '') && optional) return null;
    const d = typeof raw === 'string' ? new Date(raw) : null;
    if (!d || Number.isNaN(d.getTime())) throw new ExamInputError('Give an end date');
    if (d <= now) throw new ExamInputError('The end date must be in the future');
    return d;
  }

  private async requireAdmin(accountId: string): Promise<void> {
    if (!(await this.authz.curriculumRolesFor(accountId)).includes('SUPER_ADMIN')) throw new ExamNotPermittedError('Only an administrator may manage plans');
  }

  private async ownStudent(accountId: string): Promise<string> {
    const access = await (this.db.client as any).account_student_access.findFirst({ where: { account_id: accountId, access_kind: 'SELF', revoked_at: null } });
    if (!access) throw new ExamNotPermittedError('Create your profile first');
    return access.student_id;
  }

  private async maskedAccounts(db: any, ids: string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!ids.length) return out;
    const rows: any[] = await db.authentication_identity.findMany({ where: { account_id: { in: ids } } });
    for (const r of rows) if (!out.has(r.account_id)) out.set(r.account_id, maskIdentifier(r.kind, r.identifier_normalized));
    return out;
  }

  private async audit(actor: string, action: string, studentId: string, metadata: Record<string, unknown>): Promise<void> {
    await (this.db.client as any).audit_event.create({ data: { actor_account_id: actor, action, subject_type: 'student', subject_id: studentId, metadata } });
  }
  private async audited(tx: Tx, actor: string, action: string, studentId: string, metadata: Record<string, unknown>): Promise<void> {
    await (tx as any).audit_event.create({ data: { actor_account_id: actor, action, subject_type: 'student', subject_id: studentId, metadata } });
  }
}
