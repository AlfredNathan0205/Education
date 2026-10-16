import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { AuthzService } from '../authz/authz.service';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { findConsentWording } from '../guardian/consent-texts';
import { PrivacyService } from '../privacy/privacy.service';
import {
  ANALYTICS_PURPOSE,
  MAX_CLIENT_EVENTS_PER_DAY,
  analyticsEnabled,
  analyticsSecret,
  assignVariant,
  cleanProps,
  improvedCount,
  isClientEvent,
  project,
  returnRates,
  sourceRefKey,
  subjectKey,
  suppress,
  validateVariants,
  weekly,
  type AnalyticsEventName,
  type Ev,
} from './analytics-domain';

type Tx = Prisma.TransactionClient;
const CURSOR = 'outbox';
const DAY = 86_400_000;
/** Outbox rows younger than this are left for the next run, so a transaction still committing is not skipped. */
const SETTLE_MS = 10_000;

export interface ConsentWordingView {
  version: number;
  title: string;
  paragraphs: string[];
  draft: boolean;
}

export interface MyAnalyticsConsent {
  /** Adults decide for themselves; for a minor, their guardian decides. */
  decidedBy: 'SELF' | 'GUARDIAN';
  granted: boolean;
  consent: ConsentWordingView | null;
}

type Metric = number | '<5' | null;

/**
 * Step 19: pseudonymous product analytics and an experiments foundation (spec ANALYTICS_QA_RELEASE; DOMAIN_MAP 19).
 *
 * - Only for students whose PRODUCT_ANALYTICS consent is valid at the moment an event is recorded (adults decide for
 *   themselves; a minor's approving guardian decides). Withdrawing deletes that student's analytics rows.
 * - Rows hold a pseudonym (an HMAC of the student id), never an id, name or text.
 * - Server events are projected from the outbox; a few client events come from the web app; parent views are recorded
 *   by the parent service. No page views, durations or screen time.
 * - Metrics are aggregates for administrators only; counts below 5 are hidden.
 * - ANALYTICS_ENABLED=false stops all recording (a kill switch).
 */
@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);
  private readonly secret = analyticsSecret();
  private readonly enabled = analyticsEnabled();

  constructor(
    private readonly db: DatabaseService,
    private readonly privacy: PrivacyService,
    private readonly authz: AuthzService,
  ) {}

  keyOf(studentId: string): string {
    return subjectKey(studentId, this.secret);
  }

  async consents(studentId: string, now = new Date()): Promise<boolean> {
    return (await this.privacy.evaluateProcessingForStudent(studentId, ANALYTICS_PURPOSE, now)).allowed;
  }

  /** Records one server event if analytics is on and the student consents now. Returns whether it was recorded. */
  /** `sourceRef` is the raw de-duplication reference; only its keyed hash is stored. */
  async record(studentId: string, name: AnalyticsEventName, props: Record<string, unknown> | null, at = new Date(), sourceRef: string | null = null, client?: any): Promise<boolean> {
    if (!this.enabled || !(await this.consents(studentId, at))) return false;
    const db = client ?? (this.db.client as any);
    try {
      await db.analytics_event.create({
        // No props: leave the column out so it is SQL NULL. Prisma writes a plain `null` to a Json column as JSON null,
        // which the CHECK (props IS NULL OR an object) rightly refuses.
        data: { subject_key: this.keyOf(studentId), name, source: 'SERVER', occurred_at: at, cohort: await this.cohortOf(db, studentId), ...(props ? { props: props as any } : {}), source_ref: sourceRef ? sourceRefKey(sourceRef, this.secret) : null },
      });
      return true;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return false; // already projected
      throw e;
    }
  }

  /** A UI event from the student's own web app. Always "accepted": nothing tells the client whether it was kept. */
  async recordClient(accountId: string, name: unknown, now = new Date()): Promise<void> {
    if (!isClientEvent(name)) throw new ExamInputError('Unknown event');
    if (!this.enabled) return;
    const studentId = await this.ownStudent(accountId).catch(() => null);
    if (!studentId || !(await this.consents(studentId, now))) return;
    const db = this.db.client as any;
    const key = this.keyOf(studentId);
    const today = await db.analytics_event.count({ where: { subject_key: key, source: 'CLIENT', occurred_at: { gte: new Date(now.getTime() - DAY) } } });
    if (today >= MAX_CLIENT_EVENTS_PER_DAY) return;
    await db.analytics_event.create({ data: { subject_key: key, name, source: 'CLIENT', occurred_at: now, cohort: await this.cohortOf(db, studentId) } });
  }

  /** Step 20: how many analytics rows are held for a student (the export reports the count; rows carry no id). */
  async heldFor(studentId: string): Promise<number> {
    return (this.db.client as any).analytics_event.count({ where: { subject_key: this.keyOf(studentId) } });
  }

  /** Deletes everything analytics holds about a student (their consent was withdrawn). */
  async forget(studentId: string, client?: any): Promise<number> {
    const db = client ?? (this.db.client as any);
    const key = this.keyOf(studentId);
    const n = await db.analytics_event.deleteMany({ where: { subject_key: key } });
    await db.experiment_assignment.deleteMany({ where: { subject_key: key } });
    return n.count;
  }

  // ── projection from the outbox ─────────────────────────────────────────────

  /**
   * Reads outbox events after the cursor (older than a few seconds, in created order) and records the ones analytics
   * uses, for consenting students only. Idempotent: each outbox event can be recorded once (`source_ref` is unique).
   */
  async projectOutbox(now = new Date(), limit = 200): Promise<{ read: number; recorded: number; forgotten: number }> {
    const db = this.db.client as any;
    const cursor = await db.analytics_cursor.findUnique({ where: { id: CURSOR } });
    const after = cursor?.last_created_at ?? new Date(0);
    const afterId = cursor?.last_event_id ?? '00000000-0000-0000-0000-000000000000';
    const before = new Date(now.getTime() - SETTLE_MS);
    const rows: Array<{ id: string; event_type: string; payload: any; created_at: Date }> = await db.$queryRaw`
      SELECT id, event_type, payload, created_at FROM outbox_event
      WHERE (created_at, id) > (${after}, ${afterId}::uuid) AND created_at < ${before}
      ORDER BY created_at, id
      LIMIT ${limit}`;
    let recorded = 0;
    let forgotten = 0;
    for (const r of rows) {
      try {
        ({ recorded, forgotten } = await this.projectOne(db, r, recorded, forgotten));
      } catch (e) {
        // Analytics must never hold anything up: one bad event is logged and skipped, the cursor moves on.
        this.logger.warn(`analytics skipped outbox event ${r.id} (${r.event_type}): ${(e as Error).message}`);
      }
    }
    if (rows.length) {
      const last = rows[rows.length - 1];
      await db.analytics_cursor.upsert({
        where: { id: CURSOR },
        create: { id: CURSOR, last_created_at: last.created_at, last_event_id: last.id },
        update: { last_created_at: last.created_at, last_event_id: last.id },
      });
    }
    return { read: rows.length, recorded, forgotten };
  }

  private async projectOne(db: any, r: { id: string; event_type: string; payload: any; created_at: Date }, recorded: number, forgotten: number): Promise<{ recorded: number; forgotten: number }> {
    {
      const m = this.enabled ? project(r.event_type, r.payload) : null;
      if (m === 'FORGET') {
        if (r.payload?.studentId) forgotten += await this.forget(r.payload.studentId);
      } else if (m === 'CONSENTED') {
        const student = r.payload?.studentId ? await db.student.findUnique({ where: { id: r.payload.studentId }, select: { created_at: true } }) : null;
        if (student && (await this.record(r.payload.studentId, 'SIGNED_UP', null, student.created_at, `signup:${r.payload.studentId}`))) recorded++;
      } else if (m && m.studentId) {
        let props = m.props;
        if (m.name === 'MASTERY_UPDATED' && r.payload?.runId) {
          const changes: any[] = await db.mastery_state_change.findMany({ where: { run_id: r.payload.runId }, select: { before_label: true, after_label: true } });
          props = cleanProps('MASTERY_UPDATED', { improvedObjectives: improvedCount(changes.map((c) => ({ before: c.before_label, after: c.after_label }))) });
        }
        if (await this.record(m.studentId, m.name, props, r.created_at, r.id)) recorded++;
      }
    }
    return { recorded, forgotten };
  }

  // ── consent ────────────────────────────────────────────────────────────────

  async myConsent(accountId: string, now = new Date()): Promise<MyAnalyticsConsent> {
    const studentId = await this.ownStudent(accountId);
    const summary = await this.privacy.getClassificationSummary(studentId);
    return {
      decidedBy: summary.requiresGuardianConsent ? 'GUARDIAN' : 'SELF',
      granted: await this.consents(studentId, now),
      consent: summary.requiresGuardianConsent ? null : await this.wording(now),
    };
  }

  async setMyConsent(accountId: string, input: { granted: unknown; consentVersion: unknown }, now = new Date()): Promise<{ granted: boolean }> {
    const studentId = await this.ownStudent(accountId);
    const summary = await this.privacy.getClassificationSummary(studentId);
    if (summary.requiresGuardianConsent) throw new ExamConflictError('Your parent or guardian decides this');
    return this.setConsent(studentId, accountId, 'SELF', null, input, now);
  }

  async guardianConsents(guardianId: string, now = new Date()): Promise<{ children: Array<{ studentId: string; label: string; granted: boolean }>; consent: ConsentWordingView | null }> {
    const approvals = await this.privacy.listGuardianApprovals(guardianId, now);
    const children = [];
    for (const a of approvals) children.push({ studentId: a.studentId, label: a.label, granted: await this.consents(a.studentId, now) });
    return { children, consent: approvals.length ? await this.wording(now) : null };
  }

  async setGuardianConsent(guardianId: string, studentId: string, input: { granted: unknown; consentVersion: unknown }, now = new Date()): Promise<{ granted: boolean }> {
    const approval = (await this.privacy.listGuardianApprovals(guardianId, now)).find((a) => a.studentId === studentId);
    if (!approval) throw new ExamNotFoundError('Not found');
    const record = await (this.db.client as any).consent_record.findUnique({ where: { id: approval.consentRecordId }, select: { guardian_authority_id: true } });
    if (!record?.guardian_authority_id) throw new ExamNotFoundError('Not found');
    return this.setConsent(studentId, guardianId, 'GUARDIAN', record.guardian_authority_id, input, now);
  }

  private async setConsent(
    studentId: string,
    actor: string,
    capacity: 'SELF' | 'GUARDIAN',
    authorityId: string | null,
    input: { granted: unknown; consentVersion: unknown },
    now: Date,
  ): Promise<{ granted: boolean }> {
    if (typeof input.granted !== 'boolean') throw new ExamInputError('granted must be true or false');
    const db = this.db.client as any;
    if (input.granted) {
      const w = await this.wording(now);
      if (!w) throw new ExamConflictError('This choice is not available yet');
      if (input.consentVersion !== w.version) throw new ExamConflictError('The wording has changed. Please read it again.');
      if (await this.consents(studentId, now)) return { granted: true };
      await this.privacy.grantConsent({ studentId, purposeCode: ANALYTICS_PURPOSE, capacity, actorAccountId: actor, guardianAuthorityId: authorityId ?? undefined }, now);
      return { granted: true };
    }
    // Withdraw every live grant this actor made for the purpose, then delete what analytics holds at once.
    const grants: any[] = await db.consent_record.findMany({ where: { student_id: studentId, purpose: { code: ANALYTICS_PURPOSE }, granted_by_account_id: actor, withdrawal: null } });
    for (const g of grants) await this.privacy.withdrawConsent({ consentRecordId: g.id, actorAccountId: actor, reasonCode: 'ANALYTICS_OFF' }, now);
    await this.forget(studentId);
    return { granted: await this.consents(studentId, now) };
  }

  // ── metrics (SUPER_ADMIN) ──────────────────────────────────────────────────

  async metrics(adminId: string, now = new Date(), weeks = 8) {
    await this.requireAdmin(adminId);
    const db = this.db.client as any;
    const since = new Date(now.getTime() - (weeks * 7 + 40) * DAY);
    const rows: any[] = await db.analytics_event.findMany({
      where: { occurred_at: { gte: since, lt: now } },
      select: { subject_key: true, name: true, occurred_at: true, props: true },
      take: 500_000,
    });
    const events: Ev[] = rows.map((r) => ({ subject: r.subject_key, name: r.name, at: r.occurred_at, props: r.props }));
    const w = weekly(events, now, weeks);
    const ret = returnRates(events, now);
    const consenting: Array<{ n: bigint | number }> = await db.$queryRaw`
      SELECT COUNT(DISTINCT r.student_id) AS n FROM consent_record r JOIN consent_purpose p ON p.id = r.consent_purpose_id
      WHERE p.code = ${ANALYTICS_PURPOSE} AND NOT EXISTS (SELECT 1 FROM consent_withdrawal w WHERE w.consent_record_id = r.id)`;
    const students: Array<{ n: bigint | number }> = await db.$queryRaw`SELECT COUNT(DISTINCT student_id) AS n FROM account_student_access WHERE access_kind = 'SELF' AND revoked_at IS NULL`;
    await db.audit_event.create({ data: { actor_account_id: adminId, action: 'analytics.metrics_viewed', subject_type: 'analytics', subject_id: 'metrics', metadata: { weeks } } });
    const s = (n: number): Metric => suppress(n);
    return {
      generatedAt: now.toISOString(),
      coverage: { consenting: s(Number(consenting[0]?.n ?? 0)), students: s(Number(students[0]?.n ?? 0)) },
      weeks: w.map((x) => ({
        weekStart: x.weekStart,
        northStar: s(x.activeQualified),
        intensity: x.activeQualified >= 5 ? x.intensity : null,
        activeLearners: s(x.activeLearners),
        started: s(x.started),
        completed: s(x.completed),
        completionRate: x.started >= 5 ? x.completionRate : null,
        signups: s(x.signups),
        activated: s(x.activated),
        loop: { resultsOpened: s(x.loop.resultsOpened), practiseMissed: s(x.loop.practiseMissed), practiceFromRecommendation: s(x.loop.practiceFromRecommendation), retestsCompleted: s(x.loop.retestsCompleted) },
        improvedObjectives: s(x.improvedObjectives),
        parentViews: s(x.parentViews),
        studentsWithParentViews: s(x.studentsWithParentViews),
      })),
      returns: {
        d7: { eligible: s(ret.d7.eligible), returned: s(ret.d7.returned), rate: ret.d7.eligible >= 5 ? Math.round((ret.d7.returned / ret.d7.eligible) * 100) / 100 : null },
        d30: { eligible: s(ret.d30.eligible), returned: s(ret.d30.returned), rate: ret.d30.eligible >= 5 ? Math.round((ret.d30.returned / ret.d30.eligible) * 100) / 100 : null },
      },
    };
  }

  // ── experiments (foundation) ───────────────────────────────────────────────

  async experiments(adminId: string) {
    await this.requireAdmin(adminId);
    const rows: any[] = await (this.db.client as any).experiment.findMany({ include: { variants: true }, orderBy: { created_at: 'desc' } });
    const out = [];
    for (const e of rows) {
      const counts: any[] = await (this.db.client as any).experiment_assignment.groupBy({ by: ['variant_key'], where: { experiment_id: e.id }, _count: { _all: true } });
      out.push({
        id: e.id,
        key: e.key,
        description: e.description,
        status: e.status,
        variants: e.variants.map((v: any) => ({ key: v.key, weight: v.weight, isControl: v.is_control, assigned: suppress(counts.find((c) => c.variant_key === v.key)?._count?._all ?? 0) })),
      });
    }
    return out;
  }

  async createExperiment(adminId: string, input: { key: unknown; description: unknown; variants: unknown }): Promise<{ id: string }> {
    await this.requireAdmin(adminId);
    if (typeof input.key !== 'string' || !/^[a-z][a-z0-9_]{2,63}$/.test(input.key)) throw new ExamInputError('key must be lower_snake_case, 3 to 64 characters');
    const description = typeof input.description === 'string' ? input.description.trim() : '';
    if (description.length < 10 || description.length > 500) throw new ExamInputError('describe the experiment (10 to 500 characters)');
    let variants;
    try {
      variants = validateVariants(input.variants);
    } catch (e) {
      throw new ExamInputError((e as Error).message);
    }
    return this.db.client.$transaction(async (tx: Tx) => {
      const t = tx as any;
      const e = await t.experiment.create({ data: { key: input.key, description, status: 'DRAFT', created_by_account_id: adminId } });
      for (const v of variants) await t.experiment_variant.create({ data: { experiment_id: e.id, key: v.key, weight: v.weight, is_control: v.isControl } });
      await t.audit_event.create({ data: { actor_account_id: adminId, action: 'analytics.experiment_created', subject_type: 'experiment', subject_id: e.id, metadata: { key: input.key } } });
      return { id: e.id as string };
    });
  }

  async setExperimentStatus(adminId: string, id: string, to: 'RUNNING' | 'STOPPED', now = new Date()): Promise<{ status: string }> {
    await this.requireAdmin(adminId);
    const db = this.db.client as any;
    const e = await db.experiment.findUnique({ where: { id } });
    if (!e) throw new ExamNotFoundError('Experiment not found');
    const allowed = (e.status === 'DRAFT' && to === 'RUNNING') || (e.status === 'RUNNING' && to === 'STOPPED');
    if (!allowed) throw new ExamConflictError(`An experiment that is ${e.status} cannot become ${to}`);
    await db.experiment.update({ where: { id }, data: to === 'RUNNING' ? { status: to, started_at: now } : { status: to, stopped_at: now } });
    await db.audit_event.create({ data: { actor_account_id: adminId, action: `analytics.experiment_${to.toLowerCase()}`, subject_type: 'experiment', subject_id: id, metadata: {} } });
    return { status: to };
  }

  /**
   * The variant for a student. Not RUNNING, unknown, or no analytics consent: the control variant, and nothing is
   * recorded. Otherwise a stable weighted assignment, recorded once. (Nothing calls this yet: foundation only.)
   */
  async variantFor(studentId: string, experimentKey: string, now = new Date()): Promise<string | null> {
    const db = this.db.client as any;
    const e = await db.experiment.findUnique({ where: { key: experimentKey }, include: { variants: true } });
    if (!e) return null;
    const control = e.variants.find((v: any) => v.is_control)?.key ?? null;
    if (e.status !== 'RUNNING' || !this.enabled || !(await this.consents(studentId, now))) return control;
    const key = this.keyOf(studentId);
    const existing = await db.experiment_assignment.findUnique({ where: { experiment_id_subject_key: { experiment_id: e.id, subject_key: key } } });
    if (existing) return existing.variant_key;
    const variant = assignVariant(key, e.key, e.variants.map((v: any) => ({ key: v.key, weight: v.weight, isControl: v.is_control })));
    try {
      await db.experiment_assignment.create({ data: { experiment_id: e.id, subject_key: key, variant_key: variant, assigned_at: now } });
    } catch (err) {
      if ((err as { code?: string }).code !== 'P2002') throw err;
    }
    return variant;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async wording(now: Date): Promise<ConsentWordingView | null> {
    const db = this.db.client as any;
    const purpose = await db.consent_purpose.findUnique({ where: { code: ANALYTICS_PURPOSE } });
    const version = purpose
      ? await db.consent_policy_version.findFirst({ where: { consent_purpose_id: purpose.id, retired_at: null, effective_from: { lte: now } }, orderBy: { version: 'desc' } })
      : null;
    const w = version ? findConsentWording(version.text_reference) : null;
    return version && w ? { version: version.version, title: w.title, paragraphs: w.paragraphs, draft: !w.counselReviewed } : null;
  }

  private async cohortOf(db: any, studentId: string): Promise<string | null> {
    const ctx = await db.student_academic_context.findUnique({ where: { student_id: studentId } });
    const c = ctx ? `${ctx.curriculum_code}/${ctx.grade_code}` : null;
    // Codes only (the database refuses anything else); a code outside that shape is simply left out.
    return c && /^[A-Z0-9_]+\/[A-Z0-9_]+$/.test(c) ? c : null;
  }

  private async ownStudent(accountId: string): Promise<string> {
    const access = await (this.db.client as any).account_student_access.findFirst({ where: { account_id: accountId, access_kind: 'SELF', revoked_at: null } });
    if (!access) throw new ExamNotPermittedError('Create your profile first');
    return access.student_id;
  }

  private async requireAdmin(accountId: string): Promise<void> {
    if (!(await this.authz.curriculumRolesFor(accountId)).includes('SUPER_ADMIN')) throw new ExamNotPermittedError('Only an administrator may see analytics');
  }
}
