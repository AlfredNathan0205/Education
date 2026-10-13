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
  PolicyConfigError,
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

/** The one purpose every student needs before anything else is processed (taking tests, storing results). */
export const CORE_PURPOSE = 'CORE_SERVICE';

export interface GrantConsentInput {
  studentId: string;
  purposeCode: string;
  capacity: ConsentCapacity;
  actorAccountId: string;
  guardianAuthorityId?: string;
}

const JURISDICTION_CODE = /^[A-Z]{2}$/;
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
   * Create a new DRAFT policy version from counsel-supplied values. Always created
   * UNREVIEWED: loading values never makes them legally effective. The config is
   * immutable after creation (there is no update method), so a later counsel review
   * applies to exactly the content that was reviewed. A correction is a new version.
   */
  async createJurisdictionPolicyDraft(
    input: { jurisdictionCode: string; config: unknown },
    actorAccountId: string | null,
    operator?: string,
  ): Promise<{ id: string; version: number }> {
    if (!JURISDICTION_CODE.test(input.jurisdictionCode)) {
      throw new PolicyConfigError('jurisdictionCode must be an ISO 3166-1 alpha-2 code, e.g. AE');
    }
    const config = parsePolicyConfig(input.config);

    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const latest = await tx.jurisdiction_policy.findFirst({
        where: { jurisdiction_code: input.jurisdictionCode },
        orderBy: { version: 'desc' },
      });
      const version = (latest?.version ?? 0) + 1;
      const created = await tx.jurisdiction_policy.create({
        data: {
          jurisdiction_code: input.jurisdictionCode,
          version,
          status: 'DRAFT',
          legal_review: 'UNREVIEWED',
          config: config as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: actorAccountId,
          action: 'privacy.jurisdiction_policy.drafted',
          subject_type: 'jurisdiction_policy',
          subject_id: created.id,
          metadata: { jurisdictionCode: input.jurisdictionCode, version, operator: operator ?? null },
        },
      });
      return { id: created.id as string, version };
    });
  }

  /**
   * Record that counsel has reviewed this exact DRAFT policy. A human assertion
   * with a pointer to the opinion (never its content). Does not activate.
   */
  async markPolicyCounselReviewed(
    policyId: string,
    legalReviewReference: string,
    actorAccountId: string | null,
    operator?: string,
  ): Promise<void> {
    const reference = legalReviewReference.trim();
    if (reference.length === 0 || reference.length > 255) {
      throw new PolicyActivationError(['legal review reference must be 1-255 characters']);
    }
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const policy = await tx.jurisdiction_policy.findUnique({ where: { id: policyId } });
      if (!policy) throw new PrivacyNotFoundError('jurisdiction policy');
      if (policy.status !== 'DRAFT') {
        throw new PolicyActivationError([`only a DRAFT policy can be marked reviewed (is ${policy.status})`]);
      }
      await tx.jurisdiction_policy.update({
        where: { id: policyId },
        data: { legal_review: 'COUNSEL_REVIEWED', legal_review_reference: reference },
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: actorAccountId,
          action: 'privacy.jurisdiction_policy.counsel_reviewed',
          subject_type: 'jurisdiction_policy',
          subject_id: policyId,
          metadata: { reference, operator: operator ?? null },
        },
      });
    });
  }

  /**
   * Make a policy ACTIVE. This is the legal gate in code: it refuses unless the
   * policy is counsel-reviewed and fully established. Retires any previously
   * ACTIVE policy for the same jurisdiction in the same transaction.
   */
  async activateJurisdictionPolicy(
    policyId: string,
    actorAccountId: string | null,
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

  /**
   * Whether a student has been age-classified and whether guardian consent is required.
   * Returns NO date of birth: callers outside this module must never see it.
   */
  async getClassificationSummary(studentId: string): Promise<{
    classified: boolean;
    requiresGuardianConsent: boolean;
    /** True only when the core-service consent is currently valid (a live, verified guardian grant when one is required). */
    consentSatisfied: boolean;
    basis: string | null;
  }> {
    const row = await this.db.client.age_classification.findFirst({
      where: { student_id: studentId, superseded_at: null },
      select: { requires_guardian_consent: true, basis: true },
    });
    // Unclassified students are treated as needing guardian consent (fail closed).
    if (!row) {
      return { classified: false, requiresGuardianConsent: true, consentSatisfied: false, basis: null };
    }
    const required = row.requires_guardian_consent as boolean;
    const consentSatisfied = required
      ? (await this.evaluateProcessingForStudent(studentId, CORE_PURPOSE)).allowed
      : true;
    return {
      classified: true,
      requiresGuardianConsent: required,
      consentSatisfied,
      basis: row.basis as string,
    };
  }

  /**
   * If the student's current classification was fail-closed because no active
   * policy existed at the time, and an active policy exists NOW, re-classify
   * using the DOB already stored in the original classification row.
   *
   * Creates a new age_classification row (append-only) and supersedes the old
   * one. The DOB stays inside this module — it is read from the DB, used for
   * classification, and stored again, but never returned or emitted.
   *
   * A classification made under an active policy (basis = POLICY) is never
   * re-evaluated: only FAIL_CLOSED_NO_ACTIVE_POLICY triggers this path.
   */
  async reclassifyIfStale(
    studentId: string,
    jurisdictionCode: string,
    now: Date = new Date(),
  ): Promise<void> {
    // Quick check outside the transaction to avoid locking on every GET.
    const peek = await this.db.client.age_classification.findFirst({
      where: { student_id: studentId, superseded_at: null },
      select: { basis: true },
    });
    if (!peek || peek.basis !== 'FAIL_CLOSED_NO_ACTIVE_POLICY') return;

    // All reads and writes inside a single transaction with a row lock on the
    // student, so two concurrent GETs cannot both create a new classification.
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      // Serialize: same pattern as recordAgeClassification.
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${studentId}::uuid FOR UPDATE`;

      // Re-read under lock — another request may have already reclassified.
      const current = await tx.age_classification.findFirst({
        where: { student_id: studentId, superseded_at: null },
        select: {
          id: true,
          basis: true,
          date_of_birth: true,
          dob_evidence_method: true,
        },
      });
      if (!current || current.basis !== 'FAIL_CLOSED_NO_ACTIVE_POLICY') return;

      const policyRow = await tx.jurisdiction_policy.findFirst({
        where: {
          jurisdiction_code: jurisdictionCode,
          status: 'ACTIVE',
          legal_review: 'COUNSEL_REVIEWED',
        },
        orderBy: { version: 'desc' },
      });
      if (!policyRow) return;

      let config: JurisdictionPolicyConfig | null = null;
      try {
        config = parsePolicyConfig(policyRow.config);
      } catch {
        return;
      }

      // If the policy has no accepted DOB evidence methods, or the stored
      // method is not in the accepted list, do not reclassify. Fail closed:
      // an empty list means "not yet established" and must not pass any method.
      const method = current.dob_evidence_method as string;
      if (
        config.acceptedDobEvidenceMethods.length === 0 ||
        !config.acceptedDobEvidenceMethods.includes(method)
      ) {
        return;
      }

      const dateOfBirth = current.date_of_birth as Date;
      const result = classifyAge({ dateOfBirth, asOf: now, policy: config });

      await tx.age_classification.updateMany({
        where: { student_id: studentId, superseded_at: null },
        data: { superseded_at: now },
      });
      const row = await tx.age_classification.create({
        data: {
          student_id: studentId,
          jurisdiction_policy_id: policyRow.id,
          date_of_birth: dateOfBirth,
          is_minor: result.isMinor,
          requires_guardian_consent: result.requiresGuardianConsent,
          basis: result.basis,
          dob_evidence_method: method,
        },
      });

      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: studentId,
        eventType: 'privacy.age_classification.reclassified.v1',
        payload: {
          studentId,
          isMinor: result.isMinor,
          requiresGuardianConsent: result.requiresGuardianConsent,
          basis: result.basis,
          previousBasis: 'FAIL_CLOSED_NO_ACTIVE_POLICY',
        },
        idempotencyKey: `age-reclassification:${row.id}`,
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: null,
          action: 'privacy.age_classification.reclassified',
          subject_type: 'student',
          subject_id: studentId,
          metadata: {
            basis: result.basis,
            previousBasis: 'FAIL_CLOSED_NO_ACTIVE_POLICY',
            jurisdictionPolicyId: policyRow.id,
          },
        },
      });
    });
  }

  /**
   * Record a consent grant, by the student themselves or by a verified guardian.
   * Pass `tx` to make the grant part of a larger transaction (guardian approval does).
   */
  async grantConsent(
    input: GrantConsentInput,
    now: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<{ consentRecordId: string }> {
    if (tx) return this.grantConsentIn(tx, input, now);
    return this.db.client.$transaction((t: Prisma.TransactionClient) =>
      this.grantConsentIn(t, input, now),
    );
  }

  private async grantConsentIn(
    tx: Prisma.TransactionClient,
    input: GrantConsentInput,
    now: Date,
  ): Promise<{ consentRecordId: string }> {
    {
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
    }
  }

  /**
   * A guardian approves a student: one transaction that records the relationship, a VERIFIED
   * verification, a CONSENT authority and the guardian's consent to the core purpose.
   *
   * Fail closed. Nothing is written unless
   *  - the student is classified and actually needs guardian consent,
   *  - the guardian account is not the student's own account,
   *  - the student's jurisdiction has an ACTIVE, counsel-reviewed policy that accepts `method`, and
   *  - the core purpose has live consent wording (otherwise ConsentTextUnavailableError).
   * `method` is only a code: whether it is legally sufficient is the policy's decision, never this code's.
   */
  async establishGuardianApproval(
    input: {
      studentId: string;
      guardianAccountId: string;
      relationshipType: string;
      method: string;
      /** Opaque pointer to the evidence held elsewhere (for example the invitation id). */
      evidenceReference: string;
    },
    now: Date = new Date(),
    tx?: Prisma.TransactionClient,
  ): Promise<{ consentRecordId: string; guardianAuthorityId: string }> {
    const run = async (t: Prisma.TransactionClient) => {
      if (!METHOD_CODE.test(input.method)) {
        throw new MethodNotAcceptedError('Guardian verification method must be an UPPER_SNAKE_CASE code');
      }
      const classification = await t.age_classification.findFirst({
        where: { student_id: input.studentId, superseded_at: null },
        select: { requires_guardian_consent: true, jurisdiction_policy_id: true },
      });
      if (!classification) throw new PrivacyForbiddenError('The student has not been age-classified');
      if (!classification.requires_guardian_consent) {
        throw new PrivacyForbiddenError('This student does not need guardian consent');
      }

      const own = await t.account_student_access.findFirst({
        where: {
          account_id: input.guardianAccountId,
          student_id: input.studentId,
          access_kind: 'SELF',
          revoked_at: null,
        },
        select: { id: true },
      });
      if (own) throw new PrivacyForbiddenError('A student cannot approve their own account');

      // The rules that count are those in force NOW for the jurisdiction the student was classified under.
      const classifiedUnder = classification.jurisdiction_policy_id
        ? await t.jurisdiction_policy.findUnique({
            where: { id: classification.jurisdiction_policy_id },
            select: { jurisdiction_code: true },
          })
        : null;
      if (!classifiedUnder) {
        throw new MethodNotAcceptedError('No jurisdiction policy applies to this student yet');
      }
      const policyRow = await t.jurisdiction_policy.findFirst({
        where: {
          jurisdiction_code: classifiedUnder.jurisdiction_code,
          status: 'ACTIVE',
          legal_review: 'COUNSEL_REVIEWED',
        },
        orderBy: { version: 'desc' },
      });
      let accepted: string[] = [];
      if (policyRow) {
        try {
          accepted = parsePolicyConfig(policyRow.config).acceptedGuardianVerificationMethods;
        } catch {
          accepted = []; // corrupt policy data: fail closed
        }
      }
      if (!policyRow || !accepted.includes(input.method)) {
        throw new MethodNotAcceptedError(
          `Guardian verification method ${input.method} is not accepted under the active policy`,
        );
      }

      const relationship = await t.guardian_relationship.upsert({
        where: {
          guardian_account_id_student_id: {
            guardian_account_id: input.guardianAccountId,
            student_id: input.studentId,
          },
        },
        create: {
          guardian_account_id: input.guardianAccountId,
          student_id: input.studentId,
          relationship_type: input.relationshipType,
          status: 'VERIFIED',
        },
        update: { relationship_type: input.relationshipType, status: 'VERIFIED' },
      });
      const verification = await t.guardian_verification.create({
        data: {
          guardian_relationship_id: relationship.id,
          method: input.method,
          status: 'VERIFIED',
          evidence_reference: input.evidenceReference,
          jurisdiction_policy_id: policyRow.id,
          verified_at: now,
        },
      });
      const authority = await t.guardian_authority.create({
        data: {
          guardian_relationship_id: relationship.id,
          guardian_verification_id: verification.id,
          authority_type: CONSENT_AUTHORITY_TYPE,
        },
      });

      const { consentRecordId } = await this.grantConsentIn(
        t,
        {
          studentId: input.studentId,
          purposeCode: CORE_PURPOSE,
          capacity: 'GUARDIAN',
          actorAccountId: input.guardianAccountId,
          guardianAuthorityId: authority.id,
        },
        now,
      );

      await this.outbox.publish(t, {
        aggregateType: 'student',
        aggregateId: input.studentId,
        eventType: 'privacy.guardian.verified.v1',
        payload: {
          studentId: input.studentId,
          guardianRelationshipId: relationship.id,
          method: input.method,
          jurisdictionPolicyId: policyRow.id,
        },
        idempotencyKey: `guardian-verified:${verification.id}`,
      });
      await t.audit_event.create({
        data: {
          actor_account_id: input.guardianAccountId,
          action: 'privacy.guardian.verified',
          subject_type: 'guardian_verification',
          subject_id: verification.id,
          metadata: { method: input.method, relationshipType: input.relationshipType },
        },
      });
      return { consentRecordId, guardianAuthorityId: authority.id as string };
    };
    if (tx) return run(tx);
    return this.db.client.$transaction(run);
  }

  /** The students this account currently approves: live guardian grants, newest first. */
  async listGuardianApprovals(
    guardianAccountId: string,
    now: Date = new Date(),
  ): Promise<Array<{ consentRecordId: string; studentId: string; displayName: string | null; grantedAt: Date }>> {
    const records = await this.db.client.consent_record.findMany({
      where: {
        granted_by_account_id: guardianAccountId,
        capacity: 'GUARDIAN',
        purpose: { code: CORE_PURPOSE },
        withdrawal: null,
      },
      orderBy: { granted_at: 'desc' },
      include: {
        student: { select: { display_name: true } },
        authority: { include: { guardian_verification: true } },
      },
    });
    return records
      .filter((r: (typeof records)[number]) =>
        r.authority
          ? isAuthorityValid(
              {
                id: r.authority.id,
                revokedAt: r.authority.revoked_at,
                verificationStatus: r.authority.guardian_verification.status,
                verificationExpiresAt: r.authority.guardian_verification.expires_at,
              },
              now,
            )
          : false,
      )
      .map((r: (typeof records)[number]) => ({
        consentRecordId: r.id as string,
        studentId: r.student_id as string,
        displayName: (r.student.display_name ?? null) as string | null,
        grantedAt: r.granted_at as Date,
      }));
  }

  /**
   * Operator tooling: make sure a consent purpose exists, and add a new version of its wording.
   * `textReference` points at the versioned text (a path or URL), it is not the text. A new version
   * retires the previous live one, so grants always cite the wording the person actually saw.
   */
  async publishConsentWording(
    input: { purposeCode: string; description: string; textReference: string },
    now: Date = new Date(),
  ): Promise<{ version: number }> {
    if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(input.purposeCode)) {
      throw new PrivacyForbiddenError('Purpose code must be UPPER_SNAKE_CASE');
    }
    if (input.textReference.trim() === '' || input.textReference.length > 255) {
      throw new PrivacyForbiddenError('A text reference of 1 to 255 characters is required');
    }
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const purpose = await tx.consent_purpose.upsert({
        where: { code: input.purposeCode },
        create: { code: input.purposeCode, description: input.description.slice(0, 500) },
        update: {},
      });
      const latest = await tx.consent_policy_version.findFirst({
        where: { consent_purpose_id: purpose.id },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const version = (latest?.version ?? 0) + 1;
      await tx.consent_policy_version.updateMany({
        where: { consent_purpose_id: purpose.id, retired_at: null },
        data: { retired_at: now },
      });
      await tx.consent_policy_version.create({
        data: {
          consent_purpose_id: purpose.id,
          version,
          text_reference: input.textReference,
          effective_from: now,
        },
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: null,
          action: 'privacy.consent_wording.published',
          subject_type: 'consent_purpose',
          subject_id: purpose.id,
          metadata: { purposeCode: input.purposeCode, version },
        },
      });
      return { version };
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
