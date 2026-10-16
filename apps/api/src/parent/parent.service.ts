import { Inject, Injectable, Optional } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { ExamService } from '../exam/exam.service';
import { findConsentWording } from '../guardian/consent-texts';
import { decideInviteRate, generateInviteToken, hashInviteToken, invitationUse } from '../guardian/guardian-domain';
import { GuardianRateLimitedError, GuardianUnavailableError } from '../guardian/guardian.errors';
import { InvalidIdentifierError, maskIdentifier, normalizeIdentifier } from '../identity/identifier';
import { MASTERY_V1, objectiveState, parsePolicy, rollup, type EvidenceRow, type Label, type MasteryPolicy, type ObjectiveState } from '../mastery/mastery-domain';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';
import {
  CLAIM_V1,
  activityOf,
  claimText,
  evaluateClaims,
  labelCounts,
  parseClaimPolicy,
  weekOf,
  type Activity,
  type ApprovedClaim,
  type ClaimKind,
  type ClaimPolicy,
  type ObjectiveInput,
  type Suppressed,
  type ViewBasis,
} from './parent-domain';
import { PARENT_SHARE_MAILER, shareLink, type ParentShareMailer } from './parent-mailer';
import { REFUSAL_TEXT, SHARE_TTL_MS, SHARING_PURPOSE, shareRefusal } from './parent-sharing-domain';

type Tx = Prisma.TransactionClient;
export const PARENT_WEB_BASE = Symbol('PARENT_WEB_BASE');
const DAY_MS = 86_400_000;

// ── views ────────────────────────────────────────────────────────────────────

export interface ChildRef {
  studentId: string;
  /** The child's display name, else their own sign-in address, masked. Only ever shown to this viewer. */
  label: string;
  basis: ViewBasis;
}

export interface ClaimView {
  kind: ClaimKind;
  subjectName: string;
  chapterTitle: string;
  statement: string;
  label: Label;
  fromLabel: Label | null;
  /** The fixed-template sentence. */
  text: string;
}

export interface SubjectPicture {
  subjectName: string;
  objectives: number;
  /** Objectives with enough evidence to say anything about. */
  reportable: number;
  counts: Record<Label, number>;
  chapters: Array<{ title: string; label: Label }>;
}

/** What a parent sees (and what the student sees in "See what they see"). Labels, counts and fixed sentences only. */
export interface SummaryContent {
  period: { start: string; end: string };
  activity: Activity;
  subjects: SubjectPicture[];
  strengths: ClaimView[];
  focus: ClaimView[];
  improvements: ClaimView[];
  claimPolicy: string;
}

export interface DashboardView extends SummaryContent {
  child: { studentId: string; label: string };
  basis: ViewBasis | 'SELF_PREVIEW';
  /** A test finished in the last moments is still being counted. */
  pending: boolean;
  lastActiveAt: string | null;
  reports: Array<{ id: string; weekStart: string; weekEnd: string; version: number }>;
}

export interface ReportView extends SummaryContent {
  id: string;
  version: number;
  reason: string;
  generatedAt: string;
}

export interface SharingView {
  /** Adults may invite a parent; minors' guardians already see the summary. */
  canShare: boolean;
  refusal: string | null;
  isMinor: boolean;
  /** How many guardians can see this student's summary through their approval (minors only). */
  guardianViewers: number;
  viewers: Array<{ grantId: string; maskedEmail: string; since: string }>;
  pending: { maskedEmail: string; expiresAt: string } | null;
  consent: { version: number; title: string; paragraphs: string[]; draft: boolean } | null;
}

interface Built {
  content: SummaryContent;
  claims: ApprovedClaim[];
  suppressed: Suppressed[];
  masteryPolicyId: string;
  claimPolicyId: string;
}

/**
 * Step 17: the parent claim gate and the parent's view (spec CLAIM_GATING_PARENT; INVARIANTS 19).
 *
 * Who may see a student's summary (PM decision, 15 October):
 * - a guardian with a live, verified approval for a minor (the approval IS the access; withdrawing it ends it);
 * - a parent an ADULT student invited, under the student's own consent (purpose PARENT_REPORT_SHARING), which the
 *   student can withdraw at any time.
 *
 * What is shown is computed from the mastery evidence through the mastery gate (labels) and the claim gate (which
 * claims may be made, how many, fixed wording). Weekly reports are frozen; a later correction of that week's evidence
 * adds a new version. Every parent view is audited.
 */
@Injectable()
export class ParentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly privacy: PrivacyService,
    private readonly exam: ExamService,
    private readonly outbox: OutboxService,
    @Inject(PARENT_SHARE_MAILER) private readonly mailer: ParentShareMailer,
    @Inject(PARENT_WEB_BASE) private readonly webBase: string,
    // Step 18: how many weeks of reports the student's plan opens (absent = all).
    @Optional() private readonly entitlements?: EntitlementService,
    // Step 19: a parent's view is recorded (pseudonymously, with the student's analytics consent only).
    @Optional() private readonly analytics?: AnalyticsService,
  ) {}

  // ── viewer side ────────────────────────────────────────────────────────────

  /** The students this account may see a summary of. */
  async children(accountId: string, now = new Date()): Promise<ChildRef[]> {
    const db = this.db.client as any;
    const guardianOf = await this.privacy.listGuardianApprovals(accountId, now);
    const grants: any[] = await db.parent_view_grant.findMany({ where: { viewer_account_id: accountId, ended_at: null }, orderBy: { granted_at: 'asc' } });
    const live = await this.liveGrants(db, grants);
    const ids = [...new Set([...guardianOf.map((g) => g.studentId), ...live.map((g) => g.student_id as string)])];
    const labels = await this.privacy.studentLabels(ids);
    return ids.map((id) => ({
      studentId: id,
      label: labels.get(id) ?? 'Student',
      basis: guardianOf.some((g) => g.studentId === id) ? 'GUARDIAN' : 'STUDENT_SHARE',
    }));
  }

  async dashboard(accountId: string, studentId: string, now = new Date()): Promise<DashboardView> {
    const access = await this.access(accountId, studentId, now);
    const view = await this.liveSummary(studentId, now);
    await this.audit(accountId, 'parent.summary_viewed', studentId, { basis: access.basis });
    if (this.analytics) await this.analytics.record(studentId, 'PARENT_VIEWED', { basis: access.basis }, now).catch(() => false);
    const labels = await this.privacy.studentLabels([studentId]);
    return { ...view, child: { studentId, label: labels.get(studentId) ?? 'Student' }, basis: access.basis };
  }

  async report(accountId: string, studentId: string, reportId: string, now = new Date()): Promise<ReportView> {
    const access = await this.access(accountId, studentId, now);
    const view = await this.readReport(studentId, reportId);
    await this.audit(accountId, 'parent.report_viewed', studentId, { basis: access.basis, reportId });
    return view;
  }

  /** A parent invited by an adult student stops seeing their summary. Guardians withdraw their approval instead. */
  async leave(accountId: string, studentId: string, now = new Date()): Promise<{ left: true }> {
    const access = await this.access(accountId, studentId, now);
    if (access.basis === 'GUARDIAN') throw new ExamConflictError('You see this summary through your approval. To stop, withdraw your approval on your approvals page.');
    await this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const n = await db.parent_view_grant.updateMany({ where: { id: access.grantId, ended_at: null }, data: { ended_at: now, ended_by_account_id: accountId, ended_reason: 'VIEWER_LEFT' } });
      if (n.count === 0) return;
      await this.ended(tx, studentId, access.grantId!, accountId, 'VIEWER_LEFT');
    });
    return { left: true };
  }

  // ── a parent answering an adult student's invitation ─────────────────────

  async previewInvitation(accountId: string, token: string, now = new Date()): Promise<{ expiresAt: string }> {
    const inv = await this.usableInvitation(this.db.client as any, accountId, token, now);
    return { expiresAt: inv.expires_at.toISOString() };
  }

  async acceptInvitation(accountId: string, token: string, now = new Date()): Promise<{ studentId: string }> {
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const inv = await this.usableInvitation(db, accountId, token, now);
      await db.$queryRaw`SELECT id FROM parent_share_invitation WHERE id = ${inv.id}::uuid FOR UPDATE`;
      const fresh = await db.parent_share_invitation.findUnique({ where: { id: inv.id } });
      if (fresh.status !== 'PENDING') throw new ExamConflictError('This invitation has already been answered or was cancelled');
      const consent = await db.consent_record.findUnique({ where: { id: inv.consent_record_id }, include: { withdrawal: true } });
      if (!consent || consent.withdrawal) throw new ExamConflictError('The student has stopped sharing');
      const own = await db.account_student_access.findFirst({ where: { account_id: accountId, student_id: inv.student_id, revoked_at: null } });
      if (own) throw new ExamNotPermittedError('You cannot accept your own invitation');
      const already = await db.parent_view_grant.findFirst({ where: { viewer_account_id: accountId, student_id: inv.student_id, ended_at: null } });
      if (already) throw new ExamConflictError('You already see this summary');
      const grant = await db.parent_view_grant.create({
        data: { student_id: inv.student_id, viewer_account_id: accountId, invitation_id: inv.id, consent_record_id: inv.consent_record_id, granted_at: now },
      });
      await db.parent_share_invitation.update({ where: { id: inv.id }, data: { status: 'ACCEPTED', resolved_at: now, accepted_by_account_id: accountId } });
      await db.audit_event.create({ data: { actor_account_id: accountId, action: 'parent.sharing_accepted', subject_type: 'student', subject_id: inv.student_id, metadata: { grantId: grant.id } } });
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: inv.student_id,
        eventType: 'parent.sharing_started.v1',
        payload: { studentId: inv.student_id, grantId: grant.id },
        idempotencyKey: `parent-sharing-started:${grant.id}`,
      });
      return { studentId: inv.student_id as string };
    });
  }

  async declineInvitation(accountId: string, token: string, now = new Date()): Promise<{ declined: true }> {
    await this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const inv = await this.usableInvitation(db, accountId, token, now);
      const n = await db.parent_share_invitation.updateMany({ where: { id: inv.id, status: 'PENDING' }, data: { status: 'DECLINED', resolved_at: now } });
      if (n.count === 0) return;
      // Nothing will be shared under this consent: close it.
      await this.privacy.withdrawConsent({ consentRecordId: inv.consent_record_id, actorAccountId: await this.selfAccount(db, inv.student_id), reasonCode: 'PARENT_DECLINED' }, now, tx);
      await db.audit_event.create({ data: { actor_account_id: accountId, action: 'parent.sharing_declined', subject_type: 'student', subject_id: inv.student_id, metadata: {} } });
    });
    return { declined: true };
  }

  // ── student side ───────────────────────────────────────────────────────────

  async sharing(accountId: string, now = new Date()): Promise<SharingView> {
    const studentId = await this.ownStudent(accountId);
    const db = this.db.client as any;
    const summary = await this.privacy.getClassificationSummary(studentId);
    const grants = await this.liveGrants(db, await db.parent_view_grant.findMany({ where: { student_id: studentId, ended_at: null }, orderBy: { granted_at: 'asc' } }));
    const invitations: any[] = grants.length
      ? await db.parent_share_invitation.findMany({ where: { id: { in: grants.map((g: any) => g.invitation_id) } } })
      : [];
    const pending = await this.pendingInvitation(db, studentId, now);
    const guardianViewers = summary.requiresGuardianConsent ? await this.guardianViewerCount(db, studentId, now) : 0;
    const refusal = shareRefusal({
      classified: summary.classified,
      requiresGuardianConsent: summary.requiresGuardianConsent,
      activeViewers: grants.length,
      pendingInvitations: pending ? 1 : 0,
      ownAddress: false,
      alreadySharedWithAddress: false,
    });
    return {
      canShare: refusal === null,
      refusal: refusal ? REFUSAL_TEXT[refusal] : null,
      isMinor: summary.requiresGuardianConsent,
      guardianViewers,
      viewers: grants.map((g: any) => ({
        grantId: g.id,
        maskedEmail: maskIdentifier('EMAIL', invitations.find((i) => i.id === g.invitation_id)?.email_normalized ?? 'unknown@unknown'),
        since: g.granted_at.toISOString(),
      })),
      pending: pending ? { maskedEmail: maskIdentifier('EMAIL', pending.email_normalized), expiresAt: pending.expires_at.toISOString() } : null,
      consent: summary.requiresGuardianConsent ? null : await this.wording(db, now),
    };
  }

  async invite(accountId: string, input: { email: unknown; consentVersion: unknown; agreed: unknown }, now = new Date()): Promise<{ maskedEmail: string; expiresAt: string }> {
    const studentId = await this.ownStudent(accountId);
    let email: string;
    try {
      email = normalizeIdentifier('EMAIL', String(input.email ?? ''));
    } catch (e) {
      if (e instanceof InvalidIdentifierError) throw new ExamInputError('Enter a valid email address');
      throw e;
    }
    if (input.agreed !== true) throw new ExamInputError('Tick the box to agree before sending');
    const summary = await this.privacy.getClassificationSummary(studentId);
    const token = generateInviteToken();
    const expiresAt = new Date(now.getTime() + SHARE_TTL_MS);

    const created = await this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      await db.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
      const wording = await this.wording(db, now);
      if (!wording) throw new GuardianUnavailableError('Sharing is not available yet. Please try again later.');
      if (input.consentVersion !== wording.version) throw new ExamConflictError('The wording has changed. Please read it again before agreeing.');

      const own = await db.authentication_identity.findFirst({ where: { account_id: accountId, kind: 'EMAIL', identifier_normalized: email }, select: { id: true } });
      const grants = await this.liveGrants(db, await db.parent_view_grant.findMany({ where: { student_id: studentId, ended_at: null } }));
      const grantInvites: any[] = grants.length ? await db.parent_share_invitation.findMany({ where: { id: { in: grants.map((g: any) => g.invitation_id) } } }) : [];
      const pending = await this.pendingInvitation(db, studentId, now);
      const refusal = shareRefusal({
        classified: summary.classified,
        requiresGuardianConsent: summary.requiresGuardianConsent,
        activeViewers: grants.length,
        // A new invitation replaces the pending one, so it does not count against the limit.
        pendingInvitations: 0,
        ownAddress: !!own,
        alreadySharedWithAddress: grantInvites.some((i) => i.email_normalized === email) || pending?.email_normalized === email,
      });
      if (refusal === 'MINOR' || refusal === 'NOT_CLASSIFIED') throw new ExamConflictError(REFUSAL_TEXT[refusal]);
      if (refusal) throw new ExamInputError(REFUSAL_TEXT[refusal]);

      const since = new Date(now.getTime() - DAY_MS);
      const [sent, received] = await Promise.all([
        db.parent_share_invitation.findMany({ where: { student_id: studentId, created_at: { gt: since } }, select: { created_at: true } }),
        db.parent_share_invitation.findMany({ where: { email_normalized: email, created_at: { gt: since } }, select: { created_at: true } }),
      ]);
      const rate = decideInviteRate({ studentSent: sent.map((r: any) => r.created_at), emailReceived: received.map((r: any) => r.created_at), now });
      if (!rate.allowed) {
        throw new GuardianRateLimitedError(
          rate.reason === 'COOLDOWN'
            ? 'Please wait a minute before sending another invitation.'
            : rate.reason === 'STUDENT_DAILY_LIMIT'
              ? "You've reached today's limit for invitations. Try again tomorrow."
              : "That address can't receive another invitation today. Try again tomorrow.",
        );
      }

      if (pending) await this.cancelPendingIn(tx, studentId, accountId, now);
      const { consentRecordId } = await this.privacy.grantConsent({ studentId, purposeCode: SHARING_PURPOSE, capacity: 'SELF', actorAccountId: accountId }, now, tx);
      const row = await db.parent_share_invitation.create({
        data: { student_id: studentId, email_normalized: email, token_hash: hashInviteToken(token), consent_record_id: consentRecordId, status: 'PENDING', expires_at: expiresAt, created_at: now },
      });
      await db.audit_event.create({ data: { actor_account_id: accountId, action: 'parent.sharing_invited', subject_type: 'student', subject_id: studentId, metadata: { invitationId: row.id } } });
      return row;
    });

    try {
      await this.mailer.sendShareInvitation(email, shareLink(this.webBase, token));
    } catch {
      // Not delivered: nothing should stay open under a consent the parent never received.
      await this.db.client.$transaction(async (tx: Tx) => this.cancelPendingIn(tx, studentId, accountId, now, 'NOT_DELIVERED'));
      throw new GuardianUnavailableError('We could not send the email. Please try again later.');
    }
    return { maskedEmail: maskIdentifier('EMAIL', email), expiresAt: created.expires_at.toISOString() };
  }

  async cancelInvitation(accountId: string, now = new Date()): Promise<{ cancelled: true }> {
    const studentId = await this.ownStudent(accountId);
    await this.db.client.$transaction(async (tx: Tx) => this.cancelPendingIn(tx, studentId, accountId, now));
    return { cancelled: true };
  }

  /** The student stops sharing with one parent: access ends at once and the consent is withdrawn. */
  async stopSharing(accountId: string, grantId: string, now = new Date()): Promise<{ stopped: true }> {
    const studentId = await this.ownStudent(accountId);
    await this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const grant = await db.parent_view_grant.findUnique({ where: { id: grantId } });
      if (!grant || grant.student_id !== studentId) throw new ExamNotFoundError('Not found');
      const n = await db.parent_view_grant.updateMany({ where: { id: grantId, ended_at: null }, data: { ended_at: now, ended_by_account_id: accountId, ended_reason: 'STUDENT_STOPPED' } });
      await this.privacy.withdrawConsent({ consentRecordId: grant.consent_record_id, actorAccountId: accountId, reasonCode: 'STUDENT_STOPPED_SHARING' }, now, tx);
      if (n.count > 0) await this.ended(tx, studentId, grantId, accountId, 'STUDENT_STOPPED');
    });
    return { stopped: true };
  }

  /** "See what they see": the student's own summary, exactly as a parent would see it. Not audited (it is their own). */
  async preview(accountId: string, now = new Date()): Promise<DashboardView> {
    const studentId = await this.ownStudent(accountId);
    const view = await this.liveSummary(studentId, now);
    const labels = await this.privacy.studentLabels([studentId]);
    return { ...view, child: { studentId, label: labels.get(studentId) ?? 'Student' }, basis: 'SELF_PREVIEW' };
  }

  async previewReport(accountId: string, reportId: string): Promise<ReportView> {
    const studentId = await this.ownStudent(accountId);
    return this.readReport(studentId, reportId);
  }

  // ── weekly reports ─────────────────────────────────────────────────────────

  /**
   * Freezes last week's report for every student who was active in it (once every test of theirs before the week's
   * end has been counted by mastery), and adds a new version to any recent report whose evidence was corrected after
   * it was generated. Safe to run on several instances: one report per student and week, versions are unique.
   */
  async reconcile(now = new Date(), limit = 50): Promise<Array<{ studentId: string; reportId: string; version: number; reason: string }>> {
    const db = this.db.client as any;
    const { policy: claimPolicy } = await this.claimPolicy(db);
    const current = weekOf(now, claimPolicy.week.utcOffsetMinutes);
    const last = { start: new Date(current.start.getTime() - 7 * DAY_MS), end: current.start };
    const done: Array<{ studentId: string; reportId: string; version: number; reason: string }> = [];

    const due: Array<{ student_id: string }> = await db.$queryRaw`
      SELECT DISTINCT s.student_id
      FROM assessment_session s
      WHERE s.status = 'SUBMITTED' AND s.submitted_at >= ${last.start} AND s.submitted_at < ${last.end}
        AND NOT EXISTS (SELECT 1 FROM student_report r WHERE r.student_id = s.student_id AND r.week_start = ${last.start})
        -- Step 20: an erased student's summaries are deleted and never made again.
        AND NOT EXISTS (SELECT 1 FROM student e WHERE e.id = s.student_id AND e.erased_at IS NOT NULL)
        AND NOT EXISTS (
          SELECT 1 FROM assessment_session p JOIN assessment_result pr ON pr.session_id = p.id
          WHERE p.student_id = s.student_id AND p.status IN ('SUBMITTED', 'INVALIDATED') AND p.submitted_at < ${last.end}
            AND NOT EXISTS (SELECT 1 FROM mastery_update_run m WHERE m.session_id = p.id
              AND m.result_revision = CASE WHEN p.status = 'INVALIDATED' THEN -1 ELSE pr.correction_count END))
      LIMIT ${limit}`;
    for (const d of due) {
      const r = await this.writeVersion(d.student_id, last, 'WEEK_ENDED', now);
      if (r) done.push(r);
    }

    // Corrections (a rescore or an invalidated test) counted after a report was generated, for a test before its week ended.
    const stale: Array<{ id: string; student_id: string; week_start: Date; week_end: Date }> = await db.$queryRaw`
      SELECT r.id, r.student_id, r.week_start, r.week_end
      FROM student_report r
      JOIN LATERAL (SELECT MAX(v.generated_at) AS at FROM student_report_version v WHERE v.report_id = r.id) lv ON TRUE
      WHERE r.week_end > ${new Date(now.getTime() - 12 * 7 * DAY_MS)}
        AND EXISTS (
          SELECT 1 FROM mastery_update_run m JOIN assessment_session s ON s.id = m.session_id
          WHERE m.student_id = r.student_id AND m.result_revision <> 0 AND m.created_at > lv.at AND s.submitted_at < r.week_end)
      ORDER BY r.week_start
      LIMIT ${limit}`;
    for (const s of stale) {
      const r = await this.writeVersion(s.student_id, { start: s.week_start, end: s.week_end }, 'EVIDENCE_CHANGED', now);
      if (r) done.push(r);
    }
    return done;
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async writeVersion(studentId: string, week: { start: Date; end: Date }, reason: 'WEEK_ENDED' | 'EVIDENCE_CHANGED', now: Date) {
    try {
      return await this.db.client.$transaction(async (tx: Tx) => {
        const db = tx as any;
        await db.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;
        let report = await db.student_report.findUnique({ where: { student_id_week_start: { student_id: studentId, week_start: week.start } } });
        if (report && reason === 'WEEK_ENDED') return null;
        if (!report) report = await db.student_report.create({ data: { student_id: studentId, week_start: week.start, week_end: week.end } });
        const latest = await db.student_report_version.findFirst({ where: { report_id: report.id }, orderBy: { version: 'desc' } });
        const built = await this.build(db, studentId, week.start, week.end);
        if (!built.claimPolicyId || !built.masteryPolicyId) throw new Error('no ACTIVE claim or mastery policy: weekly reports wait');
        const version = (latest?.version ?? 0) + 1;
        const row = await db.student_report_version.create({
          data: {
            report_id: report.id,
            version,
            claim_policy_version_id: built.claimPolicyId,
            mastery_policy_version_id: built.masteryPolicyId,
            reason,
            content: built.content as any,
            // Wall-clock time, not the reconciler's `now`: corrections are detected by comparing with it.
            generated_at: new Date(),
          },
        });
        for (const c of built.claims) {
          await db.report_claim.create({ data: { report_version_id: row.id, kind: c.kind, subject_id: c.subjectId, objective_path: c.path, label: c.label, from_label: c.fromLabel, template_code: c.template } });
        }
        for (const s of built.suppressed) {
          await db.suppressed_claim.create({ data: { report_version_id: row.id, kind: s.kind, subject_id: s.subjectId, objective_path: s.path, reason: s.reason } });
        }
        await this.outbox.publish(tx, {
          aggregateType: 'student',
          aggregateId: studentId,
          eventType: 'parent.report_generated.v1',
          payload: { studentId, reportId: report.id, version, weekStart: week.start.toISOString(), reason, claims: built.claims.length, suppressed: built.suppressed.length },
          idempotencyKey: `parent-report:${report.id}:${version}`,
        });
        return { studentId, reportId: report.id as string, version, reason };
      });
    } catch (e) {
      // Another instance wrote it first.
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  private async liveSummary(studentId: string, now: Date): Promise<Omit<DashboardView, 'child' | 'basis'>> {
    const db = this.db.client as any;
    const { policy } = await this.claimPolicy(db);
    const week = weekOf(now, policy.week.utcOffsetMinutes);
    const built = await this.build(db, studentId, week.start, now);
    const waiting: Array<{ n: bigint | number }> = await db.$queryRaw`
      SELECT COUNT(*) AS n FROM assessment_session s JOIN assessment_result r ON r.session_id = s.id
      WHERE s.student_id = ${studentId}::uuid AND s.status IN ('SUBMITTED', 'INVALIDATED')
        AND NOT EXISTS (SELECT 1 FROM mastery_update_run m WHERE m.session_id = s.id
          AND m.result_revision = CASE WHEN s.status = 'INVALIDATED' THEN -1 ELSE r.correction_count END)`;
    const lastSession = await db.assessment_session.findFirst({ where: { student_id: studentId, status: 'SUBMITTED' }, orderBy: { submitted_at: 'desc' }, select: { submitted_at: true } });
    const weeks = this.entitlements ? await this.entitlements.reportWeeks(studentId, now) : null;
    const reports: any[] = await db.student_report.findMany({
      where: { student_id: studentId },
      orderBy: { week_start: 'desc' },
      take: weeks === null ? 12 : Math.min(12, weeks),
      include: { versions: { orderBy: { version: 'desc' }, take: 1, select: { version: true } } },
    });
    return {
      ...built.content,
      pending: Number(waiting[0]?.n ?? 0) > 0,
      lastActiveAt: lastSession?.submitted_at?.toISOString() ?? null,
      reports: reports
        .filter((r) => r.versions.length)
        .map((r) => ({ id: r.id, weekStart: r.week_start.toISOString(), weekEnd: r.week_end.toISOString(), version: r.versions[0].version })),
    };
  }

  private async readReport(studentId: string, reportId: string): Promise<ReportView> {
    const db = this.db.client as any;
    const report = await db.student_report.findUnique({ where: { id: reportId }, include: { versions: { orderBy: { version: 'desc' }, take: 1 } } });
    if (!report || report.student_id !== studentId || !report.versions.length) throw new ExamNotFoundError('Report not found');
    const weeks = this.entitlements ? await this.entitlements.reportWeeks(studentId) : null;
    if (weeks !== null) {
      const newer = await db.student_report.count({ where: { student_id: studentId, week_start: { gt: report.week_start } } });
      if (newer >= weeks) throw new ExamNotPermittedError(`Weekly reports older than ${weeks} weeks are not included in this plan`);
    }
    const v = report.versions[0];
    return { ...(v.content as SummaryContent), id: report.id, version: v.version, reason: v.reason, generatedAt: v.generated_at.toISOString() };
  }

  /**
   * The summary for [start, end): states are REPLAYED from valid evidence answered before each moment, so a report is
   * the same whenever it is built, and a later invalidation changes it only through a new version.
   */
  private async build(db: any, studentId: string, start: Date, end: Date): Promise<Built> {
    const { row: mRow, policy: mPolicy } = await this.masteryPolicy(db);
    const { row: cRow, policy: cPolicy } = await this.claimPolicy(db);
    const subjects = await this.exam.subjectsFor(studentId);
    const evidence: any[] = await db.mastery_evidence_event.findMany({
      where: { student_id: studentId, invalidated_at: null, answered_at: { lt: end } },
      select: { curriculum_version_id: true, grade_id: true, subject_id: true, objective_path: true, score: true, weight: true, w_quality: true, mode: true, question_id: true, session_id: true, answered_at: true },
    });

    const pictures: SubjectPicture[] = [];
    const inputs: ObjectiveInput[] = [];
    const meta = new Map<string, { subjectName: string; chapterTitle: string; statement: string }>();
    for (const u of subjects) {
      const sv = await db.curriculum_subject_version.findUnique({
        where: { id: u.subjectVersionId },
        select: {
          curriculum_version_id: true,
          grade_id: true,
          subject_id: true,
          chapters: {
            orderBy: { position: 'asc' },
            select: {
              code: true,
              title: true,
              topics: { orderBy: { position: 'asc' }, select: { code: true, micro_concepts: { orderBy: { position: 'asc' }, select: { code: true, learning_objectives: { orderBy: { position: 'asc' }, select: { code: true, statement: true } } } } } },
            },
          },
        },
      });
      if (!sv) continue;
      const mine = evidence.filter((e) => e.curriculum_version_id === sv.curriculum_version_id && e.grade_id === sv.grade_id && e.subject_id === sv.subject_id);
      const labels: Label[] = [];
      let reportable = 0;
      const chapters: Array<{ title: string; label: Label }> = [];
      for (const c of sv.chapters) {
        const roll: Array<{ label: Label; reportable: boolean; mastery: number; effectiveEvidence: number }> = [];
        for (const t of c.topics)
          for (const m of t.micro_concepts)
            for (const o of m.learning_objectives) {
              const path = `${c.code}/${t.code}/${m.code}/${o.code}`;
              const rows = mine.filter((e) => e.objective_path === path);
              const endState = objectiveState(rows.map(toRow), mPolicy, end);
              const before = rows.filter((e) => e.answered_at < start);
              const startState: ObjectiveState | null = before.length ? objectiveState(before.map(toRow), mPolicy, start) : null;
              const periodSessions = new Set(rows.filter((e) => e.answered_at >= start && e.weight > 0).map((e) => e.session_id)).size;
              labels.push(endState.label);
              if (endState.reportable) reportable++;
              roll.push({ label: endState.label, reportable: endState.reportable, mastery: endState.mastery, effectiveEvidence: endState.effectiveEvidence });
              inputs.push({
                subjectId: sv.subject_id,
                path,
                start: startState && { label: startState.label, reportable: startState.reportable, mastery: startState.mastery, evidenceCount: startState.evidenceCount },
                end: { label: endState.label, reportable: endState.reportable, mastery: endState.mastery, evidenceCount: endState.evidenceCount },
                periodSessions,
              });
              meta.set(`${sv.subject_id}/${path}`, { subjectName: u.subjectName, chapterTitle: c.title, statement: o.statement });
            }
        chapters.push({ title: c.title, label: rollup(roll, mPolicy).label });
      }
      pictures.push({ subjectName: u.subjectName, objectives: labels.length, reportable, counts: labelCounts(labels), chapters });
    }

    const result = evaluateClaims(inputs, cPolicy, { strong: mPolicy.bands.strong, developing: mPolicy.bands.developing });
    const view = (c: ApprovedClaim): ClaimView => {
      const m = meta.get(`${c.subjectId}/${c.path}`)!;
      return { kind: c.kind, subjectName: m.subjectName, chapterTitle: m.chapterTitle, statement: m.statement, label: c.label, fromLabel: c.fromLabel, text: claimText(c, m.statement) };
    };

    const sessions: any[] = await db.assessment_session.findMany({
      where: { student_id: studentId, status: 'SUBMITTED', submitted_at: { gte: start, lt: end } },
      select: { mode: true, submitted_at: true, result: { select: { total: true, unanswered: true } } },
    });
    const activity = activityOf(
      sessions.map((s) => ({ mode: s.mode, submittedAt: s.submitted_at, answered: s.result ? s.result.total - s.result.unanswered : 0 })),
      cPolicy.week.utcOffsetMinutes,
    );

    return {
      content: {
        period: { start: start.toISOString(), end: end.toISOString() },
        activity,
        subjects: pictures,
        strengths: result.strengths.map(view),
        focus: result.focus.map(view),
        improvements: result.improvements.map(view),
        claimPolicy: cRow?.code ?? 'CLAIM_V1',
      },
      claims: [...result.strengths, ...result.focus, ...result.improvements],
      suppressed: result.suppressed,
      masteryPolicyId: mRow?.id,
      claimPolicyId: cRow?.id,
    };
  }

  /** Who this account is to the student, or 404 (no hint that the student exists). */
  private async access(accountId: string, studentId: string, now: Date): Promise<{ basis: ViewBasis; grantId: string | null }> {
    const guardianOf = await this.privacy.listGuardianApprovals(accountId, now);
    if (guardianOf.some((g) => g.studentId === studentId)) return { basis: 'GUARDIAN', grantId: null };
    const db = this.db.client as any;
    const grants = await this.liveGrants(db, await db.parent_view_grant.findMany({ where: { viewer_account_id: accountId, student_id: studentId, ended_at: null } }));
    if (grants.length) {
      // Sharing is for adults; if the student is now classified as needing a guardian, it stops.
      const summary = await this.privacy.getClassificationSummary(studentId);
      if (!summary.requiresGuardianConsent) return { basis: 'STUDENT_SHARE', grantId: grants[0].id };
    }
    throw new ExamNotFoundError('Not found');
  }

  /** Grants whose consent has not been withdrawn. */
  private async liveGrants(db: any, grants: any[]): Promise<any[]> {
    if (!grants.length) return [];
    const withdrawn: any[] = await db.consent_withdrawal.findMany({ where: { consent_record_id: { in: grants.map((g) => g.consent_record_id) } }, select: { consent_record_id: true } });
    const off = new Set(withdrawn.map((w) => w.consent_record_id));
    return grants.filter((g) => !off.has(g.consent_record_id));
  }

  private async guardianViewerCount(db: any, studentId: string, now: Date): Promise<number> {
    const records: any[] = await db.consent_record.findMany({ where: { student_id: studentId, capacity: 'GUARDIAN', withdrawal: null }, select: { granted_by_account_id: true } });
    let n = 0;
    for (const acct of new Set(records.map((r) => r.granted_by_account_id as string))) {
      if ((await this.privacy.listGuardianApprovals(acct, now)).some((g) => g.studentId === studentId)) n++;
    }
    return n;
  }

  private async pendingInvitation(db: any, studentId: string, now: Date): Promise<any | null> {
    const row = await db.parent_share_invitation.findFirst({ where: { student_id: studentId, status: 'PENDING' }, orderBy: { created_at: 'desc' } });
    return row && row.expires_at > now ? row : null;
  }

  private async cancelPendingIn(tx: Tx, studentId: string, accountId: string, now: Date, reason = 'STUDENT_CANCELLED'): Promise<void> {
    const db = tx as any;
    const open: any[] = await db.parent_share_invitation.findMany({ where: { student_id: studentId, status: 'PENDING' } });
    for (const inv of open) {
      await db.parent_share_invitation.update({ where: { id: inv.id }, data: { status: 'CANCELLED', resolved_at: now } });
      await this.privacy.withdrawConsent({ consentRecordId: inv.consent_record_id, actorAccountId: accountId, reasonCode: reason }, now, tx);
    }
  }

  private async usableInvitation(db: any, accountId: string, token: string, now: Date): Promise<any> {
    const inv = await db.parent_share_invitation.findUnique({ where: { token_hash: hashInviteToken(token) } });
    if (!inv) throw new ExamNotFoundError('This link is not valid');
    const use = invitationUse({ status: inv.status, expiresAt: inv.expires_at }, now);
    if (use === 'RESOLVED') throw new ExamConflictError('This invitation has already been answered or was cancelled');
    if (use === 'EXPIRED') throw new ExamConflictError('This link has expired. Ask the student to send a new invitation.');
    const identity = await db.authentication_identity.findFirst({
      where: { account_id: accountId, kind: 'EMAIL', identifier_normalized: inv.email_normalized, verified_at: { not: null } },
      select: { id: true },
    });
    if (!identity) throw new ExamNotPermittedError('Sign in with the email address this invitation was sent to');
    return inv;
  }

  private async ended(tx: Tx, studentId: string, grantId: string, actor: string, reason: string): Promise<void> {
    const db = tx as any;
    await db.audit_event.create({ data: { actor_account_id: actor, action: 'parent.sharing_ended', subject_type: 'student', subject_id: studentId, reason_code: reason, metadata: { grantId } } });
    await this.outbox.publish(tx, {
      aggregateType: 'student',
      aggregateId: studentId,
      eventType: 'parent.sharing_ended.v1',
      payload: { studentId, grantId, reason },
      idempotencyKey: `parent-sharing-ended:${grantId}`,
    });
  }

  private async wording(db: any, now: Date): Promise<{ version: number; title: string; paragraphs: string[]; draft: boolean } | null> {
    const purpose = await db.consent_purpose.findUnique({ where: { code: SHARING_PURPOSE } });
    const version = purpose
      ? await db.consent_policy_version.findFirst({ where: { consent_purpose_id: purpose.id, retired_at: null, effective_from: { lte: now } }, orderBy: { version: 'desc' } })
      : null;
    const w = version ? findConsentWording(version.text_reference) : null;
    if (!version || !w) return null;
    return { version: version.version, title: w.title, paragraphs: w.paragraphs, draft: !w.counselReviewed };
  }

  private async ownStudent(accountId: string): Promise<string> {
    const access = await (this.db.client as any).account_student_access.findFirst({ where: { account_id: accountId, access_kind: 'SELF', revoked_at: null } });
    if (!access) throw new ExamNotPermittedError('Create your profile first');
    return access.student_id;
  }

  private async selfAccount(db: any, studentId: string): Promise<string> {
    const access = await db.account_student_access.findFirst({ where: { student_id: studentId, access_kind: 'SELF', revoked_at: null } });
    if (!access) throw new ExamNotFoundError('Not found');
    return access.account_id;
  }

  private async audit(accountId: string, action: string, studentId: string, metadata: Record<string, unknown>): Promise<void> {
    await (this.db.client as any).audit_event.create({ data: { actor_account_id: accountId, action, subject_type: 'student', subject_id: studentId, metadata } });
  }

  private async masteryPolicy(db: any): Promise<{ row: any; policy: MasteryPolicy }> {
    const row = await db.mastery_policy_version.findFirst({ where: { status: 'ACTIVE' } });
    return { row, policy: row ? parsePolicy(row.params) : MASTERY_V1 };
  }

  private async claimPolicy(db: any): Promise<{ row: any; policy: ClaimPolicy }> {
    const row = await db.claim_policy_version.findFirst({ where: { status: 'ACTIVE' } });
    return { row, policy: row ? parseClaimPolicy(row.params) : CLAIM_V1 };
  }
}

function toRow(e: any): EvidenceRow {
  return { score: e.score, weight: e.weight, wQuality: e.w_quality, mode: e.mode, questionId: e.question_id, sessionId: e.session_id, at: e.answered_at };
}
