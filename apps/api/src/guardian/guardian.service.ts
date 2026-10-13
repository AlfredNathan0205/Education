import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { InvalidIdentifierError, maskIdentifier, normalizeIdentifier } from '../identity/identifier';
import { OutboxService } from '../outbox/outbox.service';
import { MethodNotAcceptedError, ConsentTextUnavailableError, PrivacyForbiddenError, PrivacyNotFoundError } from '../privacy/privacy.errors';
import { CORE_PURPOSE, PrivacyService } from '../privacy/privacy.service';
import { findConsentWording } from './consent-texts';
import {
  GUARDIAN_METHOD,
  INVITE_TTL_MS,
  decideInviteRate,
  generateInviteToken,
  hashInviteToken,
  invitationUse,
  isRelationship,
} from './guardian-domain';
import {
  GuardianConflictError,
  GuardianInputError,
  GuardianNotFoundError,
  GuardianNotPermittedError,
  GuardianRateLimitedError,
  GuardianUnavailableError,
} from './guardian.errors';
import { GUARDIAN_MAILER, GuardianMailDeliveryError, invitationLink, type GuardianMailer } from './guardian-mailer';

type Tx = Prisma.TransactionClient;
export const GUARDIAN_WEB_BASE = Symbol('GUARDIAN_WEB_BASE');
const DAY_MS = 24 * 60 * 60 * 1000;

export interface GuardianStatusView {
  /** The student needs a guardian and none has validly approved yet. */
  approvalNeeded: boolean;
  approved: boolean;
  pending: { maskedEmail: string; relationshipType: string; expiresAt: string; canResendAt: string } | null;
}

export interface InvitationPreview {
  relationshipType: string;
  expiresAt: string;
  consent: { version: number; title: string; paragraphs: string[]; draft: boolean };
}

/**
 * Domain 01b (guardian approval flow). Owns guardian_invitation. Every privacy fact it creates
 * (relationship, verification, authority, consent) is written by PrivacyService, in the same
 * transaction as the invitation's state change, so an invitation is never ACCEPTED without an approval.
 * Which verification method is acceptable is the active jurisdiction policy's decision.
 */
@Injectable()
export class GuardianService {
  constructor(
    private readonly db: DatabaseService,
    private readonly privacy: PrivacyService,
    private readonly outbox: OutboxService,
    @Inject(GUARDIAN_MAILER) private readonly mailer: GuardianMailer,
    @Inject(GUARDIAN_WEB_BASE) private readonly webBase: string,
  ) {}

  // ── student side ─────────────────────────────────────────────────────────

  async createInvitation(
    accountId: string,
    input: { email: unknown; relationshipType: unknown },
    now: Date = new Date(),
  ): Promise<{ maskedEmail: string; expiresAt: string }> {
    if (!isRelationship(input.relationshipType)) throw new GuardianInputError('Choose how this person is related to you');
    let email: string;
    try {
      email = normalizeIdentifier('EMAIL', String(input.email ?? ''));
    } catch (e) {
      if (e instanceof InvalidIdentifierError) throw new GuardianInputError('Enter a valid email address');
      throw e;
    }
    const studentId = await this.ownStudentId(accountId);
    const summary = await this.privacy.getClassificationSummary(studentId);
    if (!summary.classified) throw new GuardianNotPermittedError('Finish your profile first');
    if (!summary.requiresGuardianConsent) throw new GuardianConflictError('You do not need a parent or guardian to approve your account');
    if (summary.consentSatisfied) throw new GuardianConflictError('A parent or guardian has already approved your account');

    const token = generateInviteToken();
    const expiresAt = new Date(now.getTime() + INVITE_TTL_MS);
    const created = await this.db.client.$transaction(async (tx: Tx) => {
      // One request at a time per student: the rate check and the "replace the pending one" step must not interleave.
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;

      const own = await tx.authentication_identity.findFirst({
        where: { account_id: accountId, kind: 'EMAIL', identifier_normalized: email },
        select: { id: true },
      });
      if (own) throw new GuardianInputError("Enter a parent or guardian's own email address, not yours");

      const since = new Date(now.getTime() - DAY_MS);
      const [sent, received] = await Promise.all([
        tx.guardian_invitation.findMany({ where: { student_id: studentId, created_at: { gt: since } }, select: { created_at: true } }),
        tx.guardian_invitation.findMany({ where: { guardian_email_normalized: email, created_at: { gt: since } }, select: { created_at: true } }),
      ]);
      const rate = decideInviteRate({
        studentSent: sent.map((r: { created_at: Date }) => r.created_at),
        emailReceived: received.map((r: { created_at: Date }) => r.created_at),
        now,
      });
      if (!rate.allowed) {
        throw new GuardianRateLimitedError(
          rate.reason === 'COOLDOWN'
            ? 'Please wait a minute before sending another request.'
            : rate.reason === 'STUDENT_DAILY_LIMIT'
              ? "You've reached today's limit for approval requests. Try again tomorrow."
              : "That address can't receive another request today. Try again tomorrow or use a different address.",
        );
      }

      await tx.guardian_invitation.updateMany({
        where: { student_id: studentId, status: 'PENDING' },
        data: { status: 'CANCELLED', resolved_at: now },
      });
      const row = await tx.guardian_invitation.create({
        data: {
          student_id: studentId,
          invited_by_account_id: accountId,
          guardian_email_normalized: email,
          relationship_type: input.relationshipType as string,
          token_hash: hashInviteToken(token),
          expires_at: expiresAt,
        },
      });
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: studentId,
        eventType: 'guardian.invitation.created.v1',
        payload: { studentId, invitationId: row.id, relationshipType: input.relationshipType },
        idempotencyKey: `guardian-invitation-created:${row.id}`,
      });
      return row as { id: string };
    });

    try {
      await this.mailer.sendInvitation(email, invitationLink(this.webBase, token));
    } catch (error) {
      // Nothing reached the guardian, so the request is useless and must not count as "pending".
      await this.db.client.guardian_invitation
        .updateMany({ where: { id: created.id, status: 'PENDING' }, data: { status: 'CANCELLED', resolved_at: new Date() } })
        .catch(() => undefined);
      if (error instanceof GuardianMailDeliveryError) {
        throw new GuardianUnavailableError('We could not send the email. Please try again in a moment.');
      }
      throw error;
    }
    return { maskedEmail: maskIdentifier('EMAIL', email), expiresAt: expiresAt.toISOString() };
  }

  async status(accountId: string, now: Date = new Date()): Promise<GuardianStatusView> {
    const studentId = await this.ownStudentId(accountId);
    const summary = await this.privacy.getClassificationSummary(studentId);
    const pending = await this.db.client.guardian_invitation.findFirst({
      where: { student_id: studentId, status: 'PENDING', expires_at: { gt: now } },
      orderBy: { created_at: 'desc' },
    });
    return {
      approvalNeeded: summary.classified && summary.requiresGuardianConsent && !summary.consentSatisfied,
      approved: summary.classified && summary.requiresGuardianConsent && summary.consentSatisfied,
      pending: pending
        ? {
            maskedEmail: maskIdentifier('EMAIL', pending.guardian_email_normalized as string),
            relationshipType: pending.relationship_type as string,
            expiresAt: (pending.expires_at as Date).toISOString(),
            canResendAt: new Date((pending.created_at as Date).getTime() + 60_000).toISOString(),
          }
        : null,
    };
  }

  async cancelInvitation(accountId: string, now: Date = new Date()): Promise<void> {
    const studentId = await this.ownStudentId(accountId);
    await this.db.client.guardian_invitation.updateMany({
      where: { student_id: studentId, status: 'PENDING' },
      data: { status: 'CANCELLED', resolved_at: now },
    });
  }

  // ── guardian side ────────────────────────────────────────────────────────

  async preview(guardianAccountId: string, token: string, now: Date = new Date()): Promise<InvitationPreview> {
    const client = this.db.client as unknown as Tx;
    const invitation = await this.usable(client, guardianAccountId, token, now);
    const wording = await this.liveWording(client, now);
    return {
      relationshipType: invitation.relationship_type,
      expiresAt: invitation.expires_at.toISOString(),
      consent: { version: wording.version, title: wording.title, paragraphs: wording.paragraphs, draft: !wording.counselReviewed },
    };
  }

  async accept(
    guardianAccountId: string,
    input: { token: string; consentVersion: unknown; attested: unknown },
    now: Date = new Date(),
  ): Promise<void> {
    if (input.attested !== true) {
      throw new GuardianInputError('Please confirm that you are this student\'s parent or legal guardian');
    }
    if (typeof input.consentVersion !== 'number' || !Number.isInteger(input.consentVersion)) {
      throw new GuardianInputError('consentVersion must be a whole number');
    }
    try {
      await this.db.client.$transaction(async (tx: Tx) => {
        const invitation = await this.usable(tx, guardianAccountId, input.token, now);
        const wording = await this.liveWording(tx, now);
        if (wording.version !== input.consentVersion) {
          throw new GuardianConflictError('The wording was updated. Please read it again before approving.');
        }
        // Claim the invitation first: only one accept can win, so two clicks cannot create two approvals.
        const claimed = await tx.guardian_invitation.updateMany({
          where: { id: invitation.id, status: 'PENDING', expires_at: { gt: now } },
          data: { status: 'ACCEPTED', resolved_at: now, accepted_by_account_id: guardianAccountId },
        });
        if (claimed.count !== 1) throw new GuardianConflictError('This request has already been answered');

        await this.privacy.establishGuardianApproval(
          {
            studentId: invitation.student_id,
            guardianAccountId,
            relationshipType: invitation.relationship_type,
            method: GUARDIAN_METHOD,
            evidenceReference: `guardian_invitation:${invitation.id}`,
          },
          now,
          tx,
        );
        await this.outbox.publish(tx, {
          aggregateType: 'student',
          aggregateId: invitation.student_id,
          eventType: 'guardian.invitation.accepted.v1',
          payload: { studentId: invitation.student_id, invitationId: invitation.id },
          idempotencyKey: `guardian-invitation-accepted:${invitation.id}`,
        });
        await tx.audit_event.create({
          data: {
            actor_account_id: guardianAccountId,
            action: 'guardian.invitation.accepted',
            subject_type: 'guardian_invitation',
            subject_id: invitation.id,
            metadata: { consentVersion: wording.version },
          },
        });
      });
    } catch (error) {
      throw this.translate(error);
    }
  }

  async decline(guardianAccountId: string, token: string, now: Date = new Date()): Promise<void> {
    await this.db.client.$transaction(async (tx: Tx) => {
      const invitation = await this.usable(tx, guardianAccountId, token, now);
      await tx.guardian_invitation.updateMany({
        where: { id: invitation.id, status: 'PENDING' },
        data: { status: 'DECLINED', resolved_at: now },
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: guardianAccountId,
          action: 'guardian.invitation.declined',
          subject_type: 'guardian_invitation',
          subject_id: invitation.id,
        },
      });
    });
  }

  listApprovals(guardianAccountId: string, now: Date = new Date()) {
    return this.privacy.listGuardianApprovals(guardianAccountId, now);
  }

  async withdraw(guardianAccountId: string, consentRecordId: string, now: Date = new Date()): Promise<void> {
    // Only a grant this account made itself, and only a live guardian one, can be withdrawn here.
    const mine = await this.privacy.listGuardianApprovals(guardianAccountId, now);
    if (!mine.some((a: { consentRecordId: string }) => a.consentRecordId === consentRecordId)) {
      throw new GuardianNotFoundError('Approval');
    }
    try {
      await this.privacy.withdrawConsent({ consentRecordId, actorAccountId: guardianAccountId, reasonCode: 'GUARDIAN_WITHDREW' }, now);
    } catch (error) {
      throw this.translate(error);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async ownStudentId(accountId: string): Promise<string> {
    const access = await this.db.client.account_student_access.findFirst({
      where: { account_id: accountId, access_kind: 'SELF', revoked_at: null },
    });
    if (!access) throw new GuardianNotPermittedError('Create your profile first');
    return access.student_id as string;
  }

  /** The invitation for this token, if it is still open and this account controls the invited address. */
  private async usable(
    tx: Tx,
    guardianAccountId: string,
    token: string,
    now: Date,
  ): Promise<{ id: string; student_id: string; relationship_type: string; expires_at: Date }> {
    const invitation = await tx.guardian_invitation.findUnique({ where: { token_hash: hashInviteToken(token) } });
    if (!invitation) throw new GuardianNotFoundError('This link');
    const use = invitationUse({ status: invitation.status, expiresAt: invitation.expires_at }, now);
    if (use === 'RESOLVED') throw new GuardianConflictError('This request has already been answered or was cancelled');
    if (use === 'EXPIRED') throw new GuardianConflictError('This link has expired. Ask the student to send a new request.');

    const identity = await tx.authentication_identity.findFirst({
      where: {
        account_id: guardianAccountId,
        kind: 'EMAIL',
        identifier_normalized: invitation.guardian_email_normalized,
        verified_at: { not: null },
      },
      select: { id: true },
    });
    if (!identity) throw new GuardianNotPermittedError('Sign in with the email address this request was sent to');
    return invitation;
  }

  private async liveWording(tx: Tx, now: Date) {
    const purpose = await tx.consent_purpose.findUnique({ where: { code: CORE_PURPOSE } });
    const version = purpose
      ? await tx.consent_policy_version.findFirst({
          where: { consent_purpose_id: purpose.id, retired_at: null, effective_from: { lte: now } },
          orderBy: { version: 'desc' },
        })
      : null;
    const wording = version ? findConsentWording(version.text_reference as string) : null;
    if (!version || !wording) {
      throw new GuardianUnavailableError('Approval is not available yet. Please try again later.');
    }
    return { ...wording, version: version.version as number };
  }

  /** Domain errors from the privacy module become guardian-flow errors the controller can map. */
  private translate(error: unknown): Error {
    if (error instanceof MethodNotAcceptedError || error instanceof ConsentTextUnavailableError) {
      return new GuardianUnavailableError('Approval is not available yet. Please try again later.');
    }
    if (error instanceof PrivacyForbiddenError) return new GuardianNotPermittedError(error.message);
    if (error instanceof PrivacyNotFoundError) return new GuardianNotFoundError('Record');
    return error as Error;
  }
}
