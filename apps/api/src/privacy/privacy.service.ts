import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { classifyAge, type AgeClassificationResult } from './age-classification';
import {
  evaluateProcessing,
  isAuthorityValid,
  type ConsentCapacity,
  type ConsentGrant,
  type GuardianAuthorityState,
  type ProcessingDecision,
} from './consent-evaluator';
import {
  PolicyActivationError,
  assertPolicyActivatable,
  emptyPolicyConfig,
  parsePolicyConfig,
  type JurisdictionPolicyConfig,
} from './jurisdiction-policy';
import {
  ConsentTextUnavailableError,
  MethodNotAcceptedError,
  PrivacyForbiddenError,
  PrivacyNotFoundError,
} from './privacy.errors';

/** A guardian may give consent only through an authority of this type. */
export const CONSENT_AUTHORITY_TYPE = 'CONSENT';

const METHOD_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

/**
 * Domain 01b — Privacy & Consent (see docs/decisions/D11_CONSENT_STATE_OWNERSHIP.md).
 * Owns: jurisdiction_policy, age_classification, guardian_*, consent_*.
 * Never writes account or auth_session (that is 01a).
 *
 * Not exposed over HTTP in Block 002: privileged operations (activating a policy)
 * need the authorization layer, which is a later block. Other domains reach this
 * module through evaluateProcessingForStudent, never by reading consent tables.
 */
@Injectable()
export class PrivacyService {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Make a policy ACTIVE. This is the legal gate in code: it refuses unless the
   * policy is counsel-reviewed and fully established. Retires any previously
   * ACTIVE policy for the same jurisdiction in the same transaction.
   */
  async activateJurisdictionPolicy(
    policyId: string,
    actorAccountId: string,
    now: Date = new Date(),
  ): Promise<void> {
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const policy = await tx.jurisdiction_policy.findUnique({ where: { id: policyId } });
      if (!policy) throw new PrivacyNotFoundError('jurisdiction policy');
      if (policy.status === 'ACTIVE') return; // idempotent
      if (policy.status === 'RETIRED') throw new PolicyActivationError(['policy is RETIRED']);

      assertPolicyActivatable({
        legalReview: policy.legal_review,
        legalReviewReference: policy.legal_review_reference,
        config: parsePolicyConfig(policy.config),
      });

      await tx.jurisdiction_policy.updateMany({
        where: { jurisdiction_code: policy.jurisdiction_code, status: 'ACTIVE' },
        data: { status: 'RETIRED' },
      });
      await tx.jurisdiction_policy.update({
        where: { id: policyId },
        data: { status: 'ACTIVE', effective_from: now },
      });

      await this.outbox.publish(tx, {
        aggregateType: 'jurisdiction_policy',
        aggregateId: policyId,
        eventType: 'privacy.jurisdiction_policy.activated.v1',
        payload: { policyId, jurisdictionCode: policy.jurisdiction_code, version: policy.version },
        idempotencyKey: `jurisdiction-policy-activated:${policyId}`,
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: actorAccountId,
          action: 'privacy.jurisdiction_policy.activated',
          subject_type: 'jurisdiction_policy',
          subject_id: policyId,
          metadata: { jurisdictionCode: policy.jurisdiction_code, version: policy.version },
        },
      });
    });
  }

  /**
   * Classify a student by age and record the result. Append-only: any previous
   * classification is superseded, never edited, so a DOB correction keeps history.
   * Fails closed when no counsel-reviewed ACTIVE policy exists for the jurisdiction.
   * The date of birth is stored here only; it is never put in an event or audit row.
   */
  async recordAgeClassification(
    input: {
      studentId: string;
      dateOfBirth: Date;
      jurisdictionCode: string;
      dobEvidenceMethod: string;
      actorAccountId: string | null;
    },
    now: Date = new Date(),
  ): Promise<AgeClassificationResult> {
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      // Serialize concurrent classifications of the same student so exactly one row stays current.
      const locked = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM student WHERE id = ${input.studentId}::uuid FOR UPDATE`;
      if (locked.length === 0) throw new PrivacyNotFoundError('student');

      const policyRow = await tx.jurisdiction_policy.findFirst({
        where: {
          jurisdiction_code: input.jurisdictionCode,
          status: 'ACTIVE',
          legal_review: 'COUNSEL_REVIEWED',
        },
        orderBy: { version: 'desc' },
      });

      let config: JurisdictionPolicyConfig | null = null;
      if (policyRow) {
        try {
          config = parsePolicyConfig(policyRow.config);
        } catch {
          config = emptyPolicyConfig(); // corrupt policy data: fail closed rather than guess
        }
      }

      if (!METHOD_CODE.test(input.dobEvidenceMethod)) {
        throw new MethodNotAcceptedError('DOB evidence method must be an UPPER_SNAKE_CASE code');
      }
      if (
        config &&
        config.acceptedDobEvidenceMethods.length > 0 &&
        !config.acceptedDobEvidenceMethods.includes(input.dobEvidenceMethod)
      ) {
        throw new MethodNotAcceptedError(
          `DOB evidence method ${input.dobEvidenceMethod} is not accepted under the active policy`,
        );
      }

      const result = classifyAge({ dateOfBirth: input.dateOfBirth, asOf: now, policy: config });

      await tx.age_classification.updateMany({
        where: { student_id: input.studentId, superseded_at: null },
        data: { superseded_at: now },
      });
      const row = await tx.age_classification.create({
        data: {
          student_id: input.studentId,
          jurisdiction_policy_id: policyRow?.id ?? null,
          date_of_birth: input.dateOfBirth,
          is_minor: result.isMinor,
          requires_guardian_consent: result.requiresGuardianConsent,
          basis: result.basis,
          dob_evidence_method: input.dobEvidenceMethod,
        },
      });

      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: input.studentId,
        eventType: 'privacy.age_classification.recorded.v1',
        payload: {
          studentId: input.studentId,
          isMinor: result.isMinor,
          requiresGuardianConsent: result.requiresGuardianConsent,
          basis: result.basis,
        },
        idempotencyKey: `age-classification:${row.id}`,
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: input.actorAccountId,
          action: 'privacy.age_classification.recorded',
          subject_type: 'student',
          subject_id: input.studentId,
          metadata: { basis: result.basis, jurisdictionPolicyId: policyRow?.id ?? null },
        },
      });

      return result;
    });
  }

  /** Record a consent grant, by the student themselves or by a verified guardian. */
  async grantConsent(
    input: {
      studentId: string;
      purposeCode: string;
      capacity: ConsentCapacity;
      actorAccountId: string;
      guardianAuthorityId?: string;
    },
    now: Date = new Date(),
  ): Promise<{ consentRecordId: string }> {
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const purpose = await tx.consent_purpose.findUnique({ where: { code: input.purposeCode } });
      if (!purpose) throw new PrivacyNotFoundError('consent purpose');

      const policyVersion = await tx.consent_policy_version.findFirst({
        where: { consent_purpose_id: purpose.id, retired_at: null, effective_from: { lte: now } },
        orderBy: { version: 'desc' },
      });
      if (!policyVersion) throw new ConsentTextUnavailableError(input.purposeCode);

      if (input.capacity === 'SELF') {
        const access = await tx.account_student_access.findFirst({
          where: {
            account_id: input.actorAccountId,
            student_id: input.studentId,
            access_kind: 'SELF',
            revoked_at: null,
          },
          select: { id: true },
        });
        if (!access) throw new PrivacyForbiddenError('Account has no self access to this student');
      } else {
        if (!input.guardianAuthorityId) {
          throw new PrivacyForbiddenError('Guardian consent requires a guardian authority');
        }
        const authority = await tx.guardian_authority.findUnique({
          where: { id: input.guardianAuthorityId },
          include: { guardian_relationship: true, guardian_verification: true },
        });
        const usable =
          authority !== null &&
          authority.authority_type === CONSENT_AUTHORITY_TYPE &&
          authority.guardian_relationship.guardian_account_id === input.actorAccountId &&
          authority.guardian_relationship.student_id === input.studentId &&
          isAuthorityValid(
            {
              id: authority.id,
              revokedAt: authority.revoked_at,
              verificationStatus: authority.guardian_verification.status,
              verificationExpiresAt: authority.guardian_verification.expires_at,
            },
            now,
          );
        if (!usable)
          throw new PrivacyForbiddenError('Guardian authority is not valid for this student');
      }

      const record = await tx.consent_record.create({
        data: {
          student_id: input.studentId,
          consent_purpose_id: purpose.id,
          consent_policy_version_id: policyVersion.id,
          granted_by_account_id: input.actorAccountId,
          capacity: input.capacity,
          guardian_authority_id: input.capacity === 'GUARDIAN' ? input.guardianAuthorityId : null,
        },
      });

      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: input.studentId,
        eventType: 'privacy.consent.granted.v1',
        payload: {
          consentRecordId: record.id,
          studentId: input.studentId,
          purposeCode: input.purposeCode,
          capacity: input.capacity,
          consentPolicyVersion: policyVersion.version,
        },
        idempotencyKey: `consent-granted:${record.id}`,
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: input.actorAccountId,
          action: 'privacy.consent.granted',
          subject_type: 'consent_record',
          subject_id: record.id,
          metadata: { purposeCode: input.purposeCode, capacity: input.capacity },
        },
      });

      return { consentRecordId: record.id };
    });
  }

  /**
   * Withdraw a grant. Allowed for whoever granted it, or any account with live
   * access to the student. Idempotent: withdrawing twice is a no-op.
   */
  async withdrawConsent(
    input: { consentRecordId: string; actorAccountId: string; reasonCode?: string },
    now: Date = new Date(),
  ): Promise<void> {
    try {
      await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
        const record = await tx.consent_record.findUnique({
          where: { id: input.consentRecordId },
          include: { withdrawal: { select: { id: true } }, purpose: { select: { code: true } } },
        });
        if (!record) throw new PrivacyNotFoundError('consent record');
        if (record.withdrawal) return;

        if (record.granted_by_account_id !== input.actorAccountId) {
          const access = await tx.account_student_access.findFirst({
            where: {
              account_id: input.actorAccountId,
              student_id: record.student_id,
              revoked_at: null,
            },
            select: { id: true },
          });
          if (!access) throw new PrivacyForbiddenError('Account may not withdraw this consent');
        }

        await tx.consent_withdrawal.create({
          data: {
            consent_record_id: record.id,
            withdrawn_by_account_id: input.actorAccountId,
            withdrawn_at: now,
            reason_code: input.reasonCode ?? null,
          },
        });
        await this.outbox.publish(tx, {
          aggregateType: 'student',
          aggregateId: record.student_id,
          eventType: 'privacy.consent.withdrawn.v1',
          payload: {
            consentRecordId: record.id,
            studentId: record.student_id,
            purposeCode: record.purpose.code,
          },
          idempotencyKey: `consent-withdrawn:${record.id}`,
        });
        await tx.audit_event.create({
          data: {
            actor_account_id: input.actorAccountId,
            action: 'privacy.consent.withdrawn',
            subject_type: 'consent_record',
            subject_id: record.id,
            reason_code: input.reasonCode ?? null,
          },
        });
      });
    } catch (error) {
      // A concurrent withdrawal hit the unique constraint on consent_record_id: already done.
      if ((error as { code?: string }).code === 'P2002') return;
      throw error;
    }
  }

  /**
   * The question every other domain asks: may this purpose be processed for this
   * student right now? A student with no age classification is treated as
   * requiring guardian consent (fail closed).
   */
  async evaluateProcessingForStudent(
    studentId: string,
    purposeCode: string,
    now: Date = new Date(),
  ): Promise<ProcessingDecision> {
    const client = this.db.client;

    const classification = await client.age_classification.findFirst({
      where: { student_id: studentId, superseded_at: null },
      orderBy: { classified_at: 'desc' },
      select: { requires_guardian_consent: true },
    });
    const requiresGuardianConsent = classification
      ? classification.requires_guardian_consent
      : true;

    const records = await client.consent_record.findMany({
      where: { student_id: studentId, purpose: { code: purposeCode } },
      include: {
        withdrawal: { select: { id: true } },
        authority: { include: { guardian_verification: true } },
      },
    });

    const grants: ConsentGrant[] = records.map((r: (typeof records)[number]) => ({
      id: r.id,
      purposeCode,
      capacity: r.capacity,
      guardianAuthorityId: r.guardian_authority_id,
      grantedAt: r.granted_at,
      withdrawn: r.withdrawal !== null,
    }));
    const authorities: GuardianAuthorityState[] = records.flatMap((r: (typeof records)[number]) =>
      r.authority
        ? [
            {
              id: r.authority.id,
              revokedAt: r.authority.revoked_at,
              verificationStatus: r.authority.guardian_verification.status,
              verificationExpiresAt: r.authority.guardian_verification.expires_at,
            },
          ]
        : [],
    );

    return evaluateProcessing({ purposeCode, requiresGuardianConsent, grants, authorities, now });
  }
}
