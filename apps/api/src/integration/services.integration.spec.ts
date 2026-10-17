/**
 * Real-database integration tests for IdentityService, PrivacyService,
 * AuthzService, CurriculumAdminService, and CurriculumService.
 *
 * These tests exercise SQL — Prisma transactions, partial unique indexes, and
 * the full write paths that the in-memory unit tests cannot reach.
 *
 * Requirements:
 *   - DATABASE_URL pointing at a live Postgres with the migration applied
 *   - OTP_HMAC_SECRET set (>= 32 chars)
 */

import { PrismaClient } from '@exam-app/database';
import { IdentityService, InvalidOtpError } from '../identity/identity.service';
import type { OtpSender } from '../identity/otp-sender.port';
import { PrivacyService } from '../privacy/privacy.service';
import { PolicyActivationError } from '../privacy/jurisdiction-policy';
import { CurriculumService } from '../curriculum/curriculum.service';
import { CurriculumAdminService } from '../curriculum/curriculum-admin.service';
import { CurriculumForbiddenError, CurriculumConflictError } from '../curriculum/curriculum.errors';
import { ContentImportService } from '../curriculum/import/content-import.service';
import { AuthzService, AuthzError } from '../authz/authz.service';
import type { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { ExamService } from '../exam/exam.service';
import { ExamConflictError, ExamNotPermittedError } from '../exam/exam.errors';
import { DEFAULT_JURISDICTION } from '../student/student.service';
import { GuardianService } from '../guardian/guardian.service';
import { ANALYTICS_DRAFT_WORDING_REFERENCE, DEV_DRAFT_WORDING_REFERENCE, SHARING_DRAFT_WORDING_REFERENCE } from '../guardian/consent-texts';
import { GuardianConflictError, GuardianNotPermittedError, GuardianUnavailableError } from '../guardian/guardian.errors';
import { QuestionService } from '../question/question.service';
import { optionRows } from '../question/question-domain';
import { PublicationService } from '../publication/publication.service';
import { BlueprintService } from '../blueprint/blueprint.service';
import { ItemInvalidationService } from '../exam/item-invalidation.service';
import { HomeService } from '../home/home.service';
import { MasteryService } from '../mastery/mastery.service';
import { MasteryViewService } from '../mastery/mastery-view.service';
import { RecommendationService } from '../recommendation/recommendation.service';
import { CompetitionService } from '../competition/competition.service';
import { SocialService } from '../social/social.service';
import { ParentService } from '../parent/parent.service';
import { EntitlementService } from '../entitlement/entitlement.service';
import { AnalyticsService } from '../analytics/analytics.service';
import { subjectKey } from '../analytics/analytics-domain';
import { RightsService } from '../rights/rights.service';
import { RetentionService } from '../rights/retention.service';
import { MfaService } from '../mfa/mfa.service';
import { hotp, stepAt } from '../mfa/totp';
import { ReleaseService } from '../release/release.service';
import { ReadinessService } from '../release/readiness.service';
import { AiGateway } from '../factory/ai-gateway';
import { MockAiProvider, parseMockFaults } from '../factory/mock-provider';
import { FactoryService } from '../factory/factory.service';
import { CurriculumWorkflowService } from '../curriculum/curriculum-workflow.service';
import { QuestionBankService } from '../question/question-bank.service';
import type { CurriculumActor } from '../curriculum/curriculum-state';
import type { CurriculumTree } from '../curriculum/curriculum-validation';

/* ------------------------------------------------------------------ setup */

const prisma = new PrismaClient();
const dbService = { client: prisma } as unknown as DatabaseService;
const outbox = new OutboxService(dbService);

let capturedCodes: { kind: string; identifier: string; code: string }[] = [];
const sender: OtpSender = {
  send: jest.fn(async (kind, identifier, code) => {
    capturedCodes.push({ kind, identifier, code });
  }),
};

const identityService = new IdentityService(dbService, outbox, sender);
const privacyService = new PrivacyService(dbService, outbox);
const curriculumService = new CurriculumService(dbService, outbox);
const authzService = new AuthzService(dbService);
const curriculumAdmin = new CurriculumAdminService(curriculumService, authzService);
const contentImport = new ContentImportService(curriculumService, curriculumAdmin, authzService);

beforeAll(async () => {
  process.env.OTP_HMAC_SECRET = process.env.OTP_HMAC_SECRET || 'a'.repeat(64);
});

afterAll(async () => {
  await prisma.$disconnect();
});

/** Delete all rows in reverse FK order so no constraint is violated. */
async function cleanAll() {
  capturedCodes = [];
  (sender.send as jest.Mock).mockClear();

  // Step 21: releases (the history refuses DELETE: TRUNCATE still resets it), audiences, reports; the seeded policy is restored.
  await prisma.$executeRawUnsafe('TRUNCATE "subject_release_event"');
  await prisma.subject_release.deleteMany();
  await prisma.release_access.deleteMany();
  await prisma.readiness_report.deleteMany();
  await prisma.readiness_policy_version.deleteMany({ where: { code: { not: 'READINESS_V1' } } });
  await prisma.readiness_policy_version.updateMany({ where: { code: 'READINESS_V1' }, data: { status: 'ACTIVE', signed_off_at: null, signed_off_by_name: null, signed_off_reference: null } });
  // Step 20: data rights, the authenticator, retention.
  await prisma.privacy_request.deleteMany();
  await prisma.deletion_tombstone.deleteMany();
  await prisma.admin_mfa_recovery_code.deleteMany();
  await prisma.admin_mfa_factor.deleteMany();
  await prisma.retention_run.deleteMany();
  // Step 19: analytics and experiments.
  await prisma.analytics_event.deleteMany();
  await prisma.analytics_cursor.deleteMany();
  await prisma.experiment_assignment.deleteMany();
  await prisma.experiment_variant.deleteMany();
  await prisma.experiment.deleteMany();
  // Step 18: the subscription history refuses DELETE (append-only trigger); TRUNCATE still resets it in tests.
  await prisma.$executeRawUnsafe('TRUNCATE "subscription_event", "subscription"');
  await prisma.entitlement_grant.deleteMany();
  await prisma.report_claim.deleteMany();
  await prisma.suppressed_claim.deleteMany();
  await prisma.student_report_version.deleteMany();
  await prisma.student_report.deleteMany();
  await prisma.parent_view_grant.deleteMany();
  await prisma.parent_share_invitation.deleteMany();
  await prisma.question_publication_event.deleteMany();
  await prisma.question_publication.deleteMany();
  await prisma.question_bank_state.deleteMany();
  await prisma.ai_call_log.deleteMany();
  await prisma.generation_attempt.deleteMany();
  await prisma.generation_batch.deleteMany();
  await prisma.challenge_participant.deleteMany();
  await prisma.challenge.deleteMany();
  await prisma.friendship_guardian_approval.deleteMany();
  await prisma.friendship.deleteMany();
  await prisma.friend_code_attempt.deleteMany();
  await prisma.friend_code.deleteMany();
  await prisma.student_block.deleteMany();
  await prisma.social_restriction.deleteMany();
  await prisma.safety_report.deleteMany();
  // The CP ledger refuses DELETE (append-only trigger); TRUNCATE is not a row operation, so tests can still reset it.
  await prisma.$executeRawUnsafe('TRUNCATE "cp_event"');
  await prisma.xp_event.deleteMany();
  await prisma.competitive_qualification.deleteMany();
  await prisma.public_profile.deleteMany();
  await prisma.recommendation_refresh.deleteMany();
  await prisma.recommendation_event.deleteMany();
  await prisma.recommendation_reason.deleteMany();
  await prisma.mastery_state_change.deleteMany();
  await prisma.mastery_update_run.deleteMany();
  await prisma.mastery_evidence_event.deleteMany();
  await prisma.student_mastery_state.deleteMany();
  await prisma.student_difficulty_state.deleteMany();
  await prisma.student_cognitive_state.deleteMany();
  await prisma.assessment_assembly_decision.deleteMany();
  await prisma.assessment_assembly_run.deleteMany();
  // Designs made by tests. The ones the migrations seed (QUICK10, SUBJECT20, SUBJECT25, FOCUS10, PRACTICE10, RETEST10) stay.
  await prisma.assessment_blueprint_version.deleteMany({ where: { blueprint: { code: { startsWith: 'IT_' } } } });
  await prisma.assessment_blueprint.deleteMany({ where: { code: { startsWith: 'IT_' } } });
  await prisma.student_response_event.deleteMany();
  await prisma.student_response.deleteMany();
  await prisma.assessment_result_correction.deleteMany();
  await prisma.assessment_result.deleteMany();
  await prisma.assessment_submission.deleteMany();
  await prisma.assessment_session.deleteMany();
  await prisma.assessment_instance_question.deleteMany();
  await prisma.assessment_instance.deleteMany();
  await prisma.recommendation.deleteMany();
  await prisma.assessment_item_invalidation.deleteMany();
  await prisma.student_question_exposure.deleteMany();
  await prisma.question_event.deleteMany();
  await prisma.question_option.deleteMany();
  await prisma.question_revision.deleteMany();
  await prisma.question.deleteMany();
  await prisma.consent_withdrawal.deleteMany();
  await prisma.consent_record.deleteMany();
  await prisma.consent_policy_version.deleteMany();
  await prisma.consent_purpose.deleteMany();
  await prisma.student_chapter_selection.deleteMany();
  await prisma.school_plan_entry.deleteMany();
  await prisma.school_academic_plan.deleteMany();
  await prisma.student_school_association.deleteMany();
  await prisma.student_academic_context.deleteMany();
  await prisma.school_candidate.deleteMany();
  await prisma.school_branch.deleteMany();
  await prisma.school_alias.deleteMany();
  await prisma.school.deleteMany();
  await prisma.guardian_invitation.deleteMany();
  await prisma.guardian_authority.deleteMany();
  await prisma.guardian_verification.deleteMany();
  await prisma.guardian_relationship.deleteMany();
  await prisma.age_classification.deleteMany();
  await prisma.account_student_access.deleteMany();
  await prisma.student.deleteMany();
  await prisma.auth_session.deleteMany();
  await prisma.otp_challenge.deleteMany();
  await prisma.authentication_identity.deleteMany();
  await prisma.role_assignment.deleteMany();
  await prisma.role_permission.deleteMany();
  await prisma.role.deleteMany();
  await prisma.permission.deleteMany();
  await prisma.resource_scope.deleteMany();
  await prisma.account.deleteMany();
  await prisma.audit_event.deleteMany();
  await prisma.outbox_event.deleteMany();
  await prisma.learning_objective.deleteMany();
  await prisma.micro_concept.deleteMany();
  await prisma.topic.deleteMany();
  await prisma.chapter.deleteMany();
  await prisma.curriculum_validation_result.deleteMany();
  await prisma.curriculum_validation_run.deleteMany();
  await prisma.curriculum_activation_record.deleteMany();
  await prisma.curriculum_approval_record.deleteMany();
  await prisma.curriculum_event_log.deleteMany();
  await prisma.curriculum_evidence_reference.deleteMany();
  await prisma.curriculum_evidence_pack.deleteMany();
  await prisma.curriculum_subject_version.deleteMany();
  await prisma.curriculum_version.deleteMany();
  await prisma.curriculum.deleteMany();
  await prisma.grade.deleteMany();
  await prisma.subject.deleteMany();
  await prisma.jurisdiction_policy.deleteMany();
}

afterEach(cleanAll);

/* ===================================================================== */
/*  IdentityService                                                       */
/* ===================================================================== */

describe('IdentityService (real DB)', () => {
  it('requestOtp + verifyOtp creates account and session', async () => {
    await identityService.requestOtp('EMAIL', 'Alice@Example.COM');
    expect(capturedCodes).toHaveLength(1);
    const code = capturedCodes[0].code;

    const result = await identityService.verifyOtp('EMAIL', 'alice@example.com', code);
    expect(result.isNewAccount).toBe(true);
    expect(result.sessionToken).toBeTruthy();

    const auth = await identityService.authenticate(result.sessionToken);
    expect(auth).not.toBeNull();
    expect(auth!.accountId).toBe(result.accountId);
  });

  it('second login reuses account', async () => {
    const t0 = new Date();
    await identityService.requestOtp('EMAIL', 'bob@example.com', t0);
    const first = await identityService.verifyOtp('EMAIL', 'bob@example.com', capturedCodes[0].code, t0);
    expect(first.isNewAccount).toBe(true);

    // Advance past the 60-second OTP cooldown
    capturedCodes = [];
    const t1 = new Date(t0.getTime() + 61_000);
    await identityService.requestOtp('EMAIL', 'bob@example.com', t1);
    const second = await identityService.verifyOtp('EMAIL', 'bob@example.com', capturedCodes[0].code, t1);
    expect(second.isNewAccount).toBe(false);
    expect(second.accountId).toBe(first.accountId);
  });

  it('wrong code throws InvalidOtpError', async () => {
    await identityService.requestOtp('EMAIL', 'wrong@example.com');
    await expect(
      identityService.verifyOtp('EMAIL', 'wrong@example.com', '000000'),
    ).rejects.toThrow(InvalidOtpError);
  });

  it('revokeSession invalidates the token', async () => {
    await identityService.requestOtp('EMAIL', 'revoke@example.com');
    const login = await identityService.verifyOtp('EMAIL', 'revoke@example.com', capturedCodes[0].code);

    await identityService.revokeSession(login.sessionToken);
    const auth = await identityService.authenticate(login.sessionToken);
    expect(auth).toBeNull();
  });

  it('delivery failure removes the stored code and allows an immediate retry', async () => {
    const { OtpDeliveryError } = require('../identity/otp-sender.port');
    const failSender: OtpSender = {
      send: jest.fn().mockRejectedValue(new OtpDeliveryError('provider down')),
    };
    const failService = new IdentityService(dbService, outbox, failSender);

    // First attempt: send fails → OtpDeliveryError
    await expect(
      failService.requestOtp('EMAIL', 'failtest@example.com'),
    ).rejects.toThrow(OtpDeliveryError);

    // The otp_challenge row should have been cleaned up
    const leftover = await prisma.otp_challenge.findFirst({
      where: { kind: 'EMAIL', identifier_normalized: 'failtest@example.com' },
    });
    expect(leftover).toBeNull();

    // Second attempt immediately (no cooldown): succeeds with working sender
    await identityService.requestOtp('EMAIL', 'failtest@example.com');
    expect(capturedCodes.some((c) => c.identifier === 'failtest@example.com')).toBe(true);
  });
});

/* ===================================================================== */
/*  PrivacyService                                                        */
/* ===================================================================== */

describe('PrivacyService (real DB)', () => {
  async function createAndActivatePolicy(jurisdiction = 'AE') {
    const { id } = await privacyService.createJurisdictionPolicyDraft(
      {
        jurisdictionCode: jurisdiction,
        config: {
          minorAgeThreshold: 18,
          guardianConsentAgeThreshold: 18,
          acceptedDobEvidenceMethods: ['SELF_DECLARED'],
          acceptedGuardianVerificationMethods: ['DOCUMENT_UPLOAD'],
        },
      },
      null,
    );
    await privacyService.markPolicyCounselReviewed(id, 'LEGAL-OPINION-001', null);
    await privacyService.activateJurisdictionPolicy(id, null);
    return id;
  }

  async function createStudentWithAccount() {
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({
      data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' },
    });
    return { accountId: account.id, studentId: student.id };
  }

  describe('jurisdiction policy lifecycle', () => {
    it('draft → reviewed → activate sets status ACTIVE', async () => {
      const id = await createAndActivatePolicy();
      const row = await prisma.jurisdiction_policy.findUnique({ where: { id } });
      expect(row!.status).toBe('ACTIVE');
    });

    it('one-ACTIVE index: activating a second retires the first', async () => {
      await createAndActivatePolicy();
      const { id: id2 } = await privacyService.createJurisdictionPolicyDraft(
        {
          jurisdictionCode: 'AE',
          config: {
            minorAgeThreshold: 18,
            guardianConsentAgeThreshold: 18,
            acceptedDobEvidenceMethods: ['SELF_DECLARED'],
            acceptedGuardianVerificationMethods: ['DOCUMENT_UPLOAD'],
          },
        },
        null,
      );
      await privacyService.markPolicyCounselReviewed(id2, 'LEGAL-002', null);
      await privacyService.activateJurisdictionPolicy(id2, null);

      const active = await prisma.jurisdiction_policy.findMany({
        where: { jurisdiction_code: 'AE', status: 'ACTIVE' },
      });
      expect(active).toHaveLength(1);
      expect(active[0].id).toBe(id2);
    });

    it('cannot activate an UNREVIEWED policy', async () => {
      const { id } = await privacyService.createJurisdictionPolicyDraft(
        {
          jurisdictionCode: 'IN',
          config: {
            minorAgeThreshold: 18,
            guardianConsentAgeThreshold: 18,
            acceptedDobEvidenceMethods: ['SELF_DECLARED'],
            acceptedGuardianVerificationMethods: [],
          },
        },
        null,
      );
      await expect(privacyService.activateJurisdictionPolicy(id, null)).rejects.toThrow(PolicyActivationError);
    });
  });

  describe('age classification', () => {
    it('supersedes previous classification', async () => {
      const { accountId, studentId } = await createStudentWithAccount();
      await createAndActivatePolicy();
      const now = new Date('2026-10-11');

      const r1 = await privacyService.recordAgeClassification(
        { studentId, dateOfBirth: new Date('2016-06-15'), jurisdictionCode: 'AE', dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: accountId },
        now,
      );
      expect(r1.isMinor).toBe(true);
      expect(r1.requiresGuardianConsent).toBe(true);

      const r2 = await privacyService.recordAgeClassification(
        { studentId, dateOfBirth: new Date('2001-03-01'), jurisdictionCode: 'AE', dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: accountId },
        now,
      );
      expect(r2.isMinor).toBe(false);

      const current = await prisma.age_classification.findMany({ where: { student_id: studentId, superseded_at: null } });
      expect(current).toHaveLength(1);
    });

    it('DOB never appears in outbox or audit events', async () => {
      const { accountId, studentId } = await createStudentWithAccount();
      await createAndActivatePolicy();
      await privacyService.recordAgeClassification(
        { studentId, dateOfBirth: new Date('2014-01-15'), jurisdictionCode: 'AE', dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: accountId },
      );

      const outboxRows = await prisma.outbox_event.findMany({ where: { aggregate_id: studentId } });
      for (const row of outboxRows) {
        const json = JSON.stringify(row.payload);
        expect(json).not.toContain('2014-01-15');
        expect(json).not.toContain('dateOfBirth');
        expect(json).not.toContain('date_of_birth');
      }
      const auditRows = await prisma.audit_event.findMany({ where: { subject_id: studentId } });
      for (const row of auditRows) {
        const json = JSON.stringify(row.metadata);
        expect(json).not.toContain('2014-01-15');
        expect(json).not.toContain('dateOfBirth');
      }
    });

    it('fail-closed: no ACTIVE policy means guardian consent required', async () => {
      const { studentId } = await createStudentWithAccount();
      const summary = await privacyService.getClassificationSummary(studentId);
      expect(summary.classified).toBe(false);
      expect(summary.requiresGuardianConsent).toBe(true);
    });
  });

  describe('consent grant and withdraw', () => {
    it('grants and withdraws consent', async () => {
      const { accountId, studentId } = await createStudentWithAccount();
      await createAndActivatePolicy();

      const purpose = await prisma.consent_purpose.create({
        data: { code: 'DATA_PROCESSING', description: 'Student data processing' },
      });
      const jpRow = await prisma.jurisdiction_policy.findFirst({ where: { jurisdiction_code: 'AE', status: 'ACTIVE' } });
      await prisma.consent_policy_version.create({
        data: {
          consent_purpose_id: purpose.id,
          version: 1,
          jurisdiction_policy_id: jpRow!.id,
          text_reference: 'consent-text-v1',
          effective_from: new Date('2026-01-01'),
        },
      });

      await privacyService.recordAgeClassification(
        { studentId, dateOfBirth: new Date('2000-05-01'), jurisdictionCode: 'AE', dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: accountId },
      );

      const { consentRecordId } = await privacyService.grantConsent({
        studentId,
        purposeCode: 'DATA_PROCESSING',
        capacity: 'SELF',
        actorAccountId: accountId,
      });
      expect(consentRecordId).toBeTruthy();

      const d1 = await privacyService.evaluateProcessingForStudent(studentId, 'DATA_PROCESSING');
      expect(d1.allowed).toBe(true);

      await privacyService.withdrawConsent({ consentRecordId, actorAccountId: accountId, reasonCode: 'USER_REQUEST' });
      const d2 = await privacyService.evaluateProcessingForStudent(studentId, 'DATA_PROCESSING');
      expect(d2.allowed).toBe(false);
    });
  });
});

/* ===================================================================== */
/*  AuthzService                                                          */
/* ===================================================================== */

describe('AuthzService (real DB)', () => {
  async function createAccount() {
    const account = await prisma.account.create({ data: {} });
    return account.id;
  }

  it('operator bootstrap: grants a role without an actor account', async () => {
    const targetId = await createAccount();
    const { granted } = await authzService.grantRole({
      targetAccountId: targetId,
      roleCode: 'SUPER_ADMIN',
      actorAccountId: null,
      operator: 'bootstrap-test',
    });
    expect(granted).toBe(true);
    const roles = await authzService.curriculumRolesFor(targetId);
    expect(roles).toContain('SUPER_ADMIN');
  });

  it('idempotent: re-granting returns granted=false', async () => {
    const targetId = await createAccount();
    await authzService.grantRole({ targetAccountId: targetId, roleCode: 'CURRICULUM_EDITOR', actorAccountId: null, operator: 'test' });
    const { granted } = await authzService.grantRole({ targetAccountId: targetId, roleCode: 'CURRICULUM_EDITOR', actorAccountId: null, operator: 'test' });
    expect(granted).toBe(false);
  });

  it('SUPER_ADMIN can grant roles to others', async () => {
    const adminId = await createAccount();
    const editorId = await createAccount();

    await authzService.grantRole({ targetAccountId: adminId, roleCode: 'SUPER_ADMIN', actorAccountId: null, operator: 'bootstrap' });

    const { granted } = await authzService.grantRole({
      targetAccountId: editorId,
      roleCode: 'CURRICULUM_EDITOR',
      actorAccountId: adminId,
    });
    expect(granted).toBe(true);
    const roles = await authzService.curriculumRolesFor(editorId);
    expect(roles).toContain('EDITOR');
  });

  it('non-SUPER_ADMIN cannot grant roles', async () => {
    const editorId = await createAccount();
    const targetId = await createAccount();

    await authzService.grantRole({ targetAccountId: editorId, roleCode: 'CURRICULUM_EDITOR', actorAccountId: null, operator: 'bootstrap' });

    await expect(
      authzService.grantRole({ targetAccountId: targetId, roleCode: 'CURRICULUM_REVIEWER', actorAccountId: editorId }),
    ).rejects.toThrow(AuthzError);
  });

  it('revoke + list: revoking removes role from curriculumRolesFor', async () => {
    const targetId = await createAccount();
    await authzService.grantRole({ targetAccountId: targetId, roleCode: 'CURRICULUM_REVIEWER', actorAccountId: null, operator: 'test' });

    const before = await authzService.curriculumRolesFor(targetId);
    expect(before).toContain('REVIEWER');

    const { revoked } = await authzService.revokeRole({ targetAccountId: targetId, roleCode: 'CURRICULUM_REVIEWER', actorAccountId: null, operator: 'test' });
    expect(revoked).toBe(true);

    const after = await authzService.curriculumRolesFor(targetId);
    expect(after).not.toContain('REVIEWER');
  });

  it('operator is required for bootstrap path (null actor)', async () => {
    const targetId = await createAccount();
    await expect(
      authzService.grantRole({ targetAccountId: targetId, roleCode: 'SUPER_ADMIN', actorAccountId: null }),
    ).rejects.toThrow(AuthzError);
  });

  it('findAccountId returns null for unknown identifier', async () => {
    const result = await authzService.findAccountId('EMAIL', 'nobody@example.com');
    expect(result).toBeNull();
  });

  it('findAccountId resolves an existing account', async () => {
    await identityService.requestOtp('EMAIL', 'found@example.com');
    const login = await identityService.verifyOtp('EMAIL', 'found@example.com', capturedCodes[0].code);

    const found = await authzService.findAccountId('EMAIL', 'found@example.com');
    expect(found).toBe(login.accountId);
  });
});

/* ===================================================================== */
/*  CurriculumAdminService + CurriculumService                            */
/* ===================================================================== */

describe('CurriculumService (real DB)', () => {
  const editor: CurriculumActor = {
    kind: 'HUMAN',
    accountId: '00000000-0000-4000-a000-000000000001',
    role: 'SUPER_ADMIN',
  };

  const minimalTree: CurriculumTree = {
    chapters: [
      {
        code: 'CH01',
        title: 'Test Chapter',
        position: 1,
        provenance: 'OFFICIAL_EXPLICIT',
        evidenceReferenceId: null,
        rationale: null,
        topics: [
          {
            code: 'T01',
            title: 'Test Topic',
            position: 1,
            provenance: 'OFFICIAL_EXPLICIT',
            evidenceReferenceId: null,
            rationale: null,
            microConcepts: [
              {
                code: 'MC01',
                title: 'Test Concept',
                position: 1,
                provenance: 'OFFICIAL_EXPLICIT',
                evidenceReferenceId: null,
                rationale: null,
                learningObjectives: [
                  {
                    code: 'LO01',
                    statement: 'Student can do X',
                    position: 1,
                    provenance: 'OFFICIAL_EXPLICIT',
                    evidenceReferenceId: null,
                    rationale: null,
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  };

  const svKey = {
    curriculumCode: 'TEST-CURR',
    curriculumName: 'Test Curriculum',
    versionLabel: '2026-27',
    gradeCode: 'G8',
    subjectCode: 'MATH',
    subjectName: 'Mathematics',
  };

  function makeTreeWithRef(refId: string): CurriculumTree {
    return {
      chapters: [{
        ...minimalTree.chapters[0],
        evidenceReferenceId: refId,
        topics: [{
          ...minimalTree.chapters[0].topics[0],
          evidenceReferenceId: refId,
          microConcepts: [{
            ...minimalTree.chapters[0].topics[0].microConcepts[0],
            evidenceReferenceId: refId,
            learningObjectives: [{
              ...minimalTree.chapters[0].topics[0].microConcepts[0].learningObjectives[0],
              evidenceReferenceId: refId,
            }],
          }],
        }],
      }],
    };
  }

  async function driveToActive() {
    const { id } = await curriculumService.createSubjectVersion(svKey, editor);
    const { referenceId } = await curriculumService.addEvidenceReference(id, { sourceTitle: 'Syllabus Doc' }, editor);
    await curriculumService.verifyEvidencePack(id, 'Verified', editor);
    await curriculumService.replaceContent(id, makeTreeWithRef(referenceId), editor);
    await curriculumService.transition(id, 'VALIDATION_PENDING', editor);
    await curriculumService.verifyEvidencePack(id, 'Re-verified after edit', editor);
    const { passed } = await curriculumService.runValidation(id);
    expect(passed).toBe(true);
    await curriculumService.transition(id, 'ADMIN_REVIEW', editor);
    await curriculumService.approve(id, editor, 'Approved');
    await curriculumService.activate(id, editor);
    return id;
  }

  it('full lifecycle to ACTIVE', async () => {
    const id = await driveToActive();
    const row = await prisma.curriculum_subject_version.findUnique({ where: { id } });
    expect(row!.state).toBe('ACTIVE');
    expect(row!.activated_at).not.toBeNull();
  });

  it('activation supersedes previous live revision', async () => {
    const firstId = await driveToActive();

    const { id: corrId } = await curriculumService.createCorrectionRevision(firstId, editor);
    const { referenceId } = await curriculumService.addEvidenceReference(corrId, { sourceTitle: 'Updated' }, editor);
    await curriculumService.verifyEvidencePack(corrId, 'Verified', editor);
    await curriculumService.replaceContent(corrId, makeTreeWithRef(referenceId), editor);
    await curriculumService.transition(corrId, 'VALIDATION_PENDING', editor);
    await curriculumService.verifyEvidencePack(corrId, 'Re-verified', editor);
    await curriculumService.runValidation(corrId);
    await curriculumService.transition(corrId, 'ADMIN_REVIEW', editor);
    await curriculumService.approve(corrId, editor, 'OK');
    await curriculumService.activate(corrId, editor);

    const first = await prisma.curriculum_subject_version.findUnique({ where: { id: firstId } });
    expect(first!.state).toBe('SUPERSEDED');
  });

  it('one-live-revision index rejects a second ACTIVE row', async () => {
    await driveToActive();
    const sv = await prisma.curriculum_subject_version.findFirst({ where: { state: 'ACTIVE' } });

    await expect(
      prisma.curriculum_subject_version.create({
        data: {
          curriculum_version_id: sv!.curriculum_version_id,
          grade_id: sv!.grade_id,
          subject_id: sv!.subject_id,
          revision: 99,
          state: 'ACTIVE',
        },
      }),
    ).rejects.toThrow();
  });

  it('getActiveTree returns only ACTIVE content', async () => {
    expect(await curriculumService.getActiveTree({ curriculumCode: 'TEST-CURR', versionLabel: '2026-27', gradeCode: 'G8', subjectCode: 'MATH' })).toBeNull();
    await driveToActive();
    const result = await curriculumService.getActiveTree({ curriculumCode: 'TEST-CURR', versionLabel: '2026-27', gradeCode: 'G8', subjectCode: 'MATH' });
    expect(result).not.toBeNull();
    expect(result!.tree.chapters[0].code).toBe('CH01');
  });
});

describe('CurriculumAdminService (real DB)', () => {
  async function createAccountWithRole(roleCode: string) {
    const account = await prisma.account.create({ data: {} });
    await authzService.grantRole({
      targetAccountId: account.id,
      roleCode,
      actorAccountId: null,
      operator: 'test-setup',
    });
    return account.id;
  }

  const svKey = {
    curriculumCode: 'ADMIN-TEST',
    curriculumName: 'Admin Test',
    versionLabel: '2026-27',
    gradeCode: 'G9',
    subjectCode: 'SCI',
    subjectName: 'Science',
  };

  it('account with no role is refused', async () => {
    const account = await prisma.account.create({ data: {} });
    await expect(
      curriculumAdmin.createSubjectVersion(account.id, svKey),
    ).rejects.toThrow(CurriculumForbiddenError);
  });

  it('EDITOR can create but not approve', async () => {
    const editorId = await createAccountWithRole('CURRICULUM_EDITOR');
    const { id } = await curriculumAdmin.createSubjectVersion(editorId, svKey);
    expect(id).toBeTruthy();

    await curriculumAdmin.addEvidenceReference(editorId, id, { sourceTitle: 'Doc' });
    await expect(curriculumAdmin.approve(editorId, id)).rejects.toThrow(CurriculumForbiddenError);
  });

  it('APPROVER can approve and activate', async () => {
    const editorId = await createAccountWithRole('CURRICULUM_EDITOR');
    const reviewerId = await createAccountWithRole('CURRICULUM_REVIEWER');
    const approverId = await createAccountWithRole('CURRICULUM_APPROVER');

    const { id } = await curriculumAdmin.createSubjectVersion(editorId, svKey);
    const { referenceId } = await curriculumAdmin.addEvidenceReference(editorId, id, { sourceTitle: 'Doc' });
    await curriculumAdmin.verifyEvidencePack(reviewerId, id, 'Verified');

    const tree: CurriculumTree = {
      chapters: [{
        code: 'CH01', title: 'Ch', position: 1, provenance: 'OFFICIAL_EXPLICIT',
        evidenceReferenceId: referenceId, rationale: null,
        topics: [{
          code: 'T01', title: 'To', position: 1, provenance: 'OFFICIAL_EXPLICIT',
          evidenceReferenceId: referenceId, rationale: null,
          microConcepts: [{
            code: 'MC01', title: 'Mc', position: 1, provenance: 'OFFICIAL_EXPLICIT',
            evidenceReferenceId: referenceId, rationale: null,
            learningObjectives: [{
              code: 'LO01', statement: 'Can X', position: 1, provenance: 'OFFICIAL_EXPLICIT',
              evidenceReferenceId: referenceId, rationale: null,
            }],
          }],
        }],
      }],
    };
    await curriculumAdmin.replaceContent(editorId, id, tree);
    await curriculumAdmin.submitForValidation(editorId, id);
    await curriculumAdmin.verifyEvidencePack(reviewerId, id, 'Re-verified');
    await curriculumAdmin.transition(reviewerId, id, 'ADMIN_REVIEW');
    await curriculumAdmin.approve(approverId, id, 'Good');
    await curriculumAdmin.activate(approverId, id);

    const row = await prisma.curriculum_subject_version.findUnique({ where: { id } });
    expect(row!.state).toBe('ACTIVE');
  });
});

/* ===================================================================== */
/*  CurriculumService read methods & content intake (Block 006)           */
/* ===================================================================== */

/** Helper: create an EDITOR account, a subject version with evidence, return ids. */
async function makeEditorWithUnit(): Promise<{ editorId: string; unitId: string }> {
  // Create an account by signing in
  await identityService.requestOtp('EMAIL', `editor-${Date.now()}@example.com`);
  const code = capturedCodes[capturedCodes.length - 1].code;
  const { accountId: editorId } = await identityService.verifyOtp(
    'EMAIL',
    capturedCodes[capturedCodes.length - 1].identifier,
    code,
  );

  // Bootstrap as SUPER_ADMIN so we can create + manage
  await authzService.grantRole({ targetAccountId: editorId, roleCode: 'SUPER_ADMIN', actorAccountId: null, operator: 'test-bootstrap' });

  // Create a subject version
  const { id: unitId } = await curriculumAdmin.createSubjectVersion(editorId, {
    curriculumCode: 'TEST',
    curriculumName: 'Test Curriculum',
    versionLabel: '2026',
    gradeCode: 'G8',
    subjectCode: `SUBJ_${Date.now()}`,
    subjectName: 'Test Subject',
  });

  // Add evidence references
  await curriculumAdmin.addEvidenceReference(editorId, unitId, {
    sourceTitle: 'Test Source',
    sourceUrl: 'https://example.com/source',
    locator: 'p.1',
    retrievedAt: new Date(),
  });

  return { editorId, unitId };
}

describe('CurriculumService read methods (real DB)', () => {
  it('listSubjectVersions returns created units', async () => {
    const { unitId } = await makeEditorWithUnit();
    const list = await curriculumService.listSubjectVersions();
    expect(list.some((u) => u.id === unitId)).toBe(true);
    const match = list.find((u) => u.id === unitId)!;
    expect(match.state).toBe('DRAFT');
    expect(match.curriculumCode).toBe('TEST');
  });

  it('evidenceReferenceIds returns reference ids in creation order', async () => {
    const { editorId, unitId } = await makeEditorWithUnit();
    // Add a second reference
    await curriculumAdmin.addEvidenceReference(editorId, unitId, {
      sourceTitle: 'Second Source',
      sourceUrl: 'https://example.com/source2',
      locator: 'p.5',
      retrievedAt: new Date(),
    });
    const ids = await curriculumService.evidenceReferenceIds(unitId);
    expect(ids).toHaveLength(2);
    // First added comes first
    expect(typeof ids[0]).toBe('string');
    expect(ids[0]).not.toBe(ids[1]);
  });

  it('findSubjectVersion finds latest revision by natural key', async () => {
    const { unitId } = await makeEditorWithUnit();
    const sv = await prisma.curriculum_subject_version.findUnique({
      where: { id: unitId },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    const found = await curriculumService.findSubjectVersion({
      curriculumCode: sv!.curriculum_version.curriculum.code,
      versionLabel: sv!.curriculum_version.label,
      gradeCode: sv!.grade.code,
      subjectCode: sv!.subject.code,
    });
    expect(found).not.toBeNull();
    expect(found!.id).toBe(unitId);
    expect(found!.state).toBe('DRAFT');
  });

  it('findSubjectVersion returns null for nonexistent key', async () => {
    const found = await curriculumService.findSubjectVersion({
      curriculumCode: 'NOPE',
      versionLabel: '9999',
      gradeCode: 'XX',
      subjectCode: 'XX',
    });
    expect(found).toBeNull();
  });
});

describe('Content intake end-to-end (real DB)', () => {
  it('CSV upload → preview → save → submit → automated validation', async () => {
    const { editorId, unitId } = await makeEditorWithUnit();

    const csv = [
      'chapter_code,chapter_title,topic_code,topic_title,concept_code,concept_title,objective_code,objective,evidence_ref,provenance,rationale',
      'CH01,Forces and Motion,CH01-T1,Newton Laws,CH01-T1-C1,First Law,CH01-T1-C1-O1,State Newton first law,1,OFFICIAL_EXPLICIT,From official syllabus page 1',
      'CH01,Forces and Motion,CH01-T1,Newton Laws,CH01-T1-C1,First Law,CH01-T1-C1-O2,Give examples of inertia,1,ADMIN_ADDED,Common teaching practice',
    ].join('\n');

    // 1. Preview — nothing is written
    const preview = await contentImport.preview(editorId, unitId, 'csv', csv);
    expect(preview.ok).toBe(true);
    expect(preview.written).toBe(false);
    expect(preview.counts.chapters).toBe(1);
    expect(preview.counts.objectives).toBe(2);

    // 2. Save as draft — content is written
    const saved = await contentImport.upload(editorId, unitId, 'csv', csv);
    expect(saved.ok).toBe(true);
    expect(saved.written).toBe(true);
    expect(saved.state).toBe('DRAFT');

    // Verify content is in the DB
    const chapters = await prisma.chapter.findMany({ where: { subject_version_id: unitId } });
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe('Forces and Motion');
    const objectives = await prisma.learning_objective.findMany({
      where: { micro_concept: { topic: { chapter: { subject_version_id: unitId } } } },
    });
    expect(objectives).toHaveLength(2);

    // 3. Submit for automated validation
    const validation = await contentImport.submit(editorId, unitId);
    expect(validation).toMatchObject({ passed: expect.any(Boolean) });

    // The state should now be VALIDATED or CHANGES_REQUIRED depending on findings
    const sv = await prisma.curriculum_subject_version.findUnique({ where: { id: unitId } });
    expect(['VALIDATED', 'CHANGES_REQUIRED']).toContain(sv!.state);
  });
});


/* ===================================================================== */
/*  ExamService (Block 009)                                               */
/* ===================================================================== */

describe('ExamService (real DB)', () => {
  const exam = new ExamService(dbService, privacyService, outbox, { allowUnactivatedCurriculum: false, resumeHours: 24 });
  const editor: CurriculumActor = { kind: 'HUMAN', accountId: '00000000-0000-4000-a000-000000000009', role: 'SUPER_ADMIN' };
  let uniq = 0;

  function tree(refId: string): CurriculumTree {
    const base = { provenance: 'OFFICIAL_EXPLICIT' as const, evidenceReferenceId: refId, rationale: null };
    return {
      chapters: [{ code: 'CH01', title: 'Chapter', position: 1, ...base, topics: [{ code: 'T01', title: 'Topic', position: 1, ...base, microConcepts: [{ code: 'MC01', title: 'Concept', position: 1, ...base, learningObjectives: [{ code: 'LO01', statement: 'Student can do X', position: 1, ...base }] }] }] }],
    };
  }

  async function activeUnit(subjectCode = 'EXAMSUBJ') {
    const key = { curriculumCode: 'EXAMCUR', curriculumName: 'Exam Curriculum', versionLabel: '2026-27', gradeCode: 'G8', subjectCode, subjectName: 'Exam Subject' };
    const { id } = await curriculumService.createSubjectVersion(key, editor);
    const { referenceId } = await curriculumService.addEvidenceReference(id, { sourceTitle: 'Syllabus Doc' }, editor);
    await curriculumService.verifyEvidencePack(id, 'Verified', editor);
    await curriculumService.replaceContent(id, tree(referenceId), editor);
    await curriculumService.transition(id, 'VALIDATION_PENDING', editor);
    await curriculumService.verifyEvidencePack(id, 'Re-verified after edit', editor);
    const { passed } = await curriculumService.runValidation(id);
    expect(passed).toBe(true);
    await curriculumService.transition(id, 'ADMIN_REVIEW', editor);
    await curriculumService.approve(id, editor, 'Approved');
    await curriculumService.activate(id, editor);
    return id;
  }

  async function bank(unitId: string, count = 12, opts: { published?: boolean } = {}) {
    const sv = await prisma.curriculum_subject_version.findUniqueOrThrow({ where: { id: unitId } });
    uniq++;
    for (let k = 1; k <= count; k++) {
      const q = await prisma.question.create({
        data: { curriculum_version_id: sv.curriculum_version_id, grade_id: sv.grade_id, subject_id: sv.subject_id, code: `Q${k}`, objective_path: 'CH01/T01/MC01/LO01' },
      });
      const rev = await prisma.question_revision.create({
        data: {
          question_id: q.id,
          revision: 1,
          state: 'APPROVED',
          origin: 'HUMAN',
          stem: `Exam question ${uniq}-${k}?`,
          stem_hash: `exam-hash-${uniq}-${k}`,
          explanation: `Because ${k}`,
          difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[k % 3],
          options: { create: optionRows([0, 1, 2, 3].map((p) => `Answer ${k}-${p}`), (k + 1) % 4) },
        },
      });
      // Approved is not published: tests are built only from published questions.
      if (opts.published !== false) {
        await prisma.question_publication.create({ data: { revision_id: rev.id, state: 'PUBLISHED', published_by: '00000000-0000-4000-8000-000000000001' } });
        await prisma.question_publication_event.create({ data: { revision_id: rev.id, action: 'PUBLISH', actor_kind: 'SYSTEM', actor_account_id: null } });
      }
    }
  }

  async function adult() {
    const { id: policyId } = await privacyService.createJurisdictionPolicyDraft(
      { jurisdictionCode: DEFAULT_JURISDICTION, config: { minorAgeThreshold: 18, guardianConsentAgeThreshold: 18, acceptedDobEvidenceMethods: ['SELF_DECLARED'], acceptedGuardianVerificationMethods: ['DOCUMENT_UPLOAD'] } },
      null,
    );
    await privacyService.markPolicyCounselReviewed(policyId, 'LEGAL-OPINION-001', null);
    await privacyService.activateJurisdictionPolicy(policyId, null);
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await privacyService.recordAgeClassification({ studentId: student.id, dateOfBirth: new Date('2001-03-01'), jurisdictionCode: DEFAULT_JURISDICTION, dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: account.id });
    // Step 12: tests are offered only in the student's own curriculum and grade.
    await prisma.student_academic_context.create({ data: { student_id: student.id, curriculum_code: 'EXAMCUR', grade_code: 'G8' } });
    return { accountId: account.id, studentId: student.id };
  }

  async function correctSlot(sessionId: string, position: number): Promise<number> {
    const session = await prisma.assessment_session.findUniqueOrThrow({ where: { id: sessionId } });
    const item = await prisma.assessment_instance_question.findFirstOrThrow({ where: { instance_id: session.instance_id, position } });
    const right = await prisma.question_option.findFirstOrThrow({ where: { revision_id: item.question_revision_id, is_correct: true } });
    return item.option_order.indexOf(right.position);
  }

  let k = 0;
  const key = () => `integration-key-${String(++k).padStart(6, '0')}`;

  it('a full TEST: assemble, answer, submit, score, review', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();

    const units = await exam.listUnits(accountId);
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({ subjectVersionId: unitId, usableQuestions: 12, ready: true });

    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    for (let p = 1; p <= 10; p++) {
      const v = await exam.present(accountId, assessmentId);
      expect(v.question!.position).toBe(p);
      expect(JSON.stringify(v)).not.toMatch(/is_correct|isCorrect|Because/);
      // Answer the first 7 correctly and the rest wrongly.
      const right = await correctSlot(assessmentId, p);
      await exam.lock(accountId, assessmentId, p, { slot: p <= 7 ? right : (right + 1) % 4, activeMs: 2000, idempotencyKey: key() });
    }
    expect(await exam.present(accountId, assessmentId)).toMatchObject({ phase: 'SUMMARY', summary: { answered: 10, unanswered: 0 } });
    await exam.submit(accountId, assessmentId);

    const result = await exam.result(accountId, assessmentId);
    expect(result).toMatchObject({ total: 10, correct: 7, unanswered: 0, competitiveEligible: true });
    expect(result.items.every((i) => i.options.filter((o) => o.isCorrect).length === 1)).toBe(true);

    expect(await prisma.student_response.count({ where: { session_id: assessmentId, state: 'LOCKED' } })).toBe(10);
    expect(await prisma.student_response_event.count({ where: { session_id: assessmentId, event_type: 'LOCKED' } })).toBe(10);
    expect(await prisma.student_question_exposure.count({ where: { student_id: studentId } })).toBe(10);
    const session = await prisma.assessment_session.findUniqueOrThrow({ where: { id: assessmentId } });
    expect(session).toMatchObject({ status: 'SUBMITTED' });
    expect(session.committed_at).not.toBeNull();
    const events = (await prisma.outbox_event.findMany({ where: { aggregate_id: assessmentId } })).map((e) => e.event_type);
    expect(events).toEqual(expect.arrayContaining(['assessment.created.v1', 'assessment.started.v1', 'assessment.answer_locked.v1', 'assessment.submitted.v1', 'assessment.scored.v1']));
  });

  it('two simultaneous creates give one test', async () => {
    const unitId = await activeUnit();
    await bank(unitId);
    const { accountId } = await adult();
    const [a, b] = await Promise.all([
      exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' }),
      exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' }),
    ]);
    expect(a.assessmentId).toBe(b.assessmentId);
    expect([a.resumed, b.resumed].sort()).toEqual([false, true]);
    expect(await prisma.assessment_session.count()).toBe(1);
  });

  it('simultaneous locks: the same request twice is one lock; two different answers, only one wins', async () => {
    const unitId = await activeUnit();
    await bank(unitId);
    const { accountId } = await adult();
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await exam.present(accountId, assessmentId);

    const same = key();
    const twice = await Promise.all([
      exam.lock(accountId, assessmentId, 1, { slot: 1, activeMs: 1, idempotencyKey: same }),
      exam.lock(accountId, assessmentId, 1, { slot: 1, activeMs: 1, idempotencyKey: same }),
    ]);
    expect(twice[0]).toEqual(twice[1]);
    expect(await prisma.student_response_event.count({ where: { session_id: assessmentId, event_type: 'LOCKED' } })).toBe(1);

    await exam.present(accountId, assessmentId);
    const settled = await Promise.allSettled([
      exam.lock(accountId, assessmentId, 2, { slot: 0, activeMs: 1, idempotencyKey: key() }),
      exam.lock(accountId, assessmentId, 2, { slot: 3, activeMs: 1, idempotencyKey: key() }),
    ]);
    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(lost.reason).toBeInstanceOf(ExamConflictError);
    expect(await prisma.student_response.count({ where: { session_id: assessmentId, state: 'LOCKED' } })).toBe(2);
  });

  it('skip, revisit once, submit anyway', async () => {
    const unitId = await activeUnit();
    await bank(unitId);
    const { accountId } = await adult();
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'PRACTICE' });
    await exam.present(accountId, assessmentId);
    await exam.skip(accountId, assessmentId, 1, { activeMs: 1 });
    for (let p = 2; p <= 10; p++) {
      await exam.present(accountId, assessmentId);
      const r = await exam.lock(accountId, assessmentId, p, { slot: await correctSlot(assessmentId, p), activeMs: 1, idempotencyKey: key() });
      expect(r.reveal).toMatchObject({ correct: true });
    }
    expect(await exam.present(accountId, assessmentId)).toMatchObject({ phase: 'SUMMARY', summary: { unanswered: 1, canReviewSkipped: true } });
    await exam.reviewSkipped(accountId, assessmentId);
    expect((await exam.present(accountId, assessmentId)).question).toMatchObject({ position: 1, pass: 'REVISIT' });
    await exam.skip(accountId, assessmentId, 1, { activeMs: 1 });
    await exam.submit(accountId, assessmentId);
    const result = await exam.result(accountId, assessmentId);
    expect(result).toMatchObject({ correct: 9, unanswered: 1, competitiveEligible: false });
    expect(result.items[0].outcome).toBe('UNANSWERED');
  });

  it('the resume window ends an attempt: scored if anything was locked, void if not', async () => {
    const unitId = await activeUnit();
    await bank(unitId);
    const { accountId } = await adult();

    const a = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await exam.present(accountId, a.assessmentId);
    await exam.lock(accountId, a.assessmentId, 1, { slot: await correctSlot(a.assessmentId, 1), activeMs: 1, idempotencyKey: key() });
    await prisma.assessment_session.update({ where: { id: a.assessmentId }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(await exam.present(accountId, a.assessmentId)).toMatchObject({ phase: 'ENDED', status: 'SUBMITTED' });
    expect(await exam.result(accountId, a.assessmentId)).toMatchObject({ correct: 1, unanswered: 9, competitiveEligible: true });
    expect((await prisma.assessment_submission.findUniqueOrThrow({ where: { session_id: a.assessmentId } })).reason).toBe('EXPIRED');

    const b = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    expect(b.resumed).toBe(false);
    await prisma.assessment_session.update({ where: { id: b.assessmentId }, data: { expires_at: new Date(Date.now() - 1000) } });
    expect(await exam.present(accountId, b.assessmentId)).toMatchObject({ phase: 'ENDED', status: 'VOID' });
    expect(await prisma.assessment_result.count({ where: { session_id: b.assessmentId } })).toBe(0);
  });

  it('one student cannot reach another student\'s test', async () => {
    const unitId = await activeUnit();
    await bank(unitId);
    const first = await adult();
    const { assessmentId } = await exam.create(first.accountId, { subjectVersionId: unitId, mode: 'TEST' });
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await privacyService.recordAgeClassification({ studentId: student.id, dateOfBirth: new Date('2001-03-01'), jurisdictionCode: DEFAULT_JURISDICTION, dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: account.id });
    await expect(exam.present(account.id, assessmentId)).rejects.toThrow(/not found/i);
  });

  it('a student who is not classified, or needs guardian consent, cannot start', async () => {
    const unitId = await activeUnit();
    await bank(unitId);
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await expect(exam.create(account.id, { subjectVersionId: unitId, mode: 'TEST' })).rejects.toBeInstanceOf(ExamNotPermittedError);
  });

  it('an unactivated curriculum is not served in strict mode', async () => {
    const { id } = await curriculumService.createSubjectVersion(
      { curriculumCode: 'EXAMCUR2', curriculumName: 'Other', versionLabel: '2026-27', gradeCode: 'G8', subjectCode: 'DRAFTSUBJ', subjectName: 'Draft Subject' },
      editor,
    );
    await bank(id);
    const { accountId } = await adult();
    expect(await exam.listUnits(accountId)).toEqual([]);
    await expect(exam.create(accountId, { subjectVersionId: id, mode: 'TEST' })).rejects.toThrow(/not open for tests/);
  });

  // ---- Step 9: approved is not published ----

  const questionsSvc = new QuestionService(dbService);
  const publicationSvc = new PublicationService(dbService, authzService, questionsSvc, { allowUnactivatedCurriculum: false, resumeHours: 24 });

  async function roleAccount(roleCode: string) {
    const account = await prisma.account.create({ data: {} });
    await authzService.grantRole({ targetAccountId: account.id, roleCode, actorAccountId: null, operator: 'test-setup' });
    return account.id;
  }
  async function revisionIds(unitId: string): Promise<string[]> {
    const sv = await prisma.curriculum_subject_version.findUniqueOrThrow({ where: { id: unitId } });
    const revs = await prisma.question_revision.findMany({
      where: { question: { curriculum_version_id: sv.curriculum_version_id, grade_id: sv.grade_id, subject_id: sv.subject_id } },
      orderBy: { question: { code: 'asc' } },
      select: { id: true },
    });
    return revs.map((r) => r.id);
  }
  /** Gives each approved revision what publication checks: a confirmed key and a passing automatic check. */
  async function readyToPublish(ids: string[]) {
    for (const id of ids) {
      await prisma.question_revision.update({ where: { id }, data: { answer_verified: true } });
      await prisma.question_validation_run.create({ data: { revision_id: id, validator_version: 'det-1', passed: true, critical_count: 0, major_count: 0, minor_count: 0, findings: [] } });
    }
  }

  it('approved questions that nobody has published are not served', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12, { published: false });
    const { accountId } = await adult();
    await expect(exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' })).rejects.toThrow();
    expect(await prisma.assessment_session.count()).toBe(0);
  });

  it('an approver publishes a whole unit, then tests can be built; a reviewer cannot publish', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12, { published: false });
    await readyToPublish(await revisionIds(unitId));
    const reviewer = await roleAccount('CURRICULUM_REVIEWER');
    const approver = await roleAccount('CURRICULUM_APPROVER');
    await expect(publicationSvc.publishUnit(reviewer, unitId)).rejects.toThrow(/only an approver/);

    expect(await publicationSvc.publishUnit(approver, unitId)).toEqual({ published: 12, skipped: [] });
    expect(await prisma.question_publication.count({ where: { state: 'PUBLISHED' } })).toBe(12);
    expect(await prisma.question_publication_event.count({ where: { action: 'PUBLISH' } })).toBe(12);
    expect((await publicationSvc.summary(approver, unitId)).awaitingPublication).toBe(0);

    const { accountId } = await adult();
    const created = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    expect(created.assessmentId).toBeTruthy();
  });

  it('a withdrawn question, and a degraded one, drop out of new tests', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ids = await revisionIds(unitId);
    const reviewer = await roleAccount('CURRICULUM_REVIEWER');
    await publicationSvc.withdraw(reviewer, ids[0], { reasonCode: 'ANSWER_WRONG', note: 'The key looks wrong.' });
    await publicationSvc.setHealth(reviewer, ids[1], { health: 'WATCH', reasonCode: 'OTHER', note: 'Watching this one.' });

    const { accountId, studentId } = await adult();
    const t = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    const session = await prisma.assessment_session.findUniqueOrThrow({ where: { id: t.assessmentId } });
    const served = (await prisma.assessment_instance_question.findMany({ where: { instance_id: session.instance_id } })).map((i) => i.question_revision_id);
    expect(served).toHaveLength(10);
    expect(served).not.toContain(ids[0]);
    expect(studentId).toBeTruthy();

    // Two DEGRADED plus the withdrawn one leave only 9 servable questions, which is too few for a test.
    await publicationSvc.setHealth(reviewer, ids[2], { health: 'DEGRADED', reasonCode: 'LIVE_PERFORMANCE_SIGNAL', note: 'Far too many miss it.' });
    await publicationSvc.setHealth(reviewer, ids[3], { health: 'DEGRADED', reasonCode: 'LIVE_PERFORMANCE_SIGNAL', note: 'Far too many miss it.' });
    const other = await adult();
    await expect(exam.create(other.accountId, { subjectVersionId: unitId, mode: 'TEST' })).rejects.toThrow();
  });

  it('quarantine and retire withdraw the publication; restoring does not publish again', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ids = await revisionIds(unitId);
    const reviewerId = await roleAccount('CURRICULUM_REVIEWER');
    const approverId = await roleAccount('CURRICULUM_APPROVER');
    const reviewer = { kind: 'HUMAN' as const, accountId: reviewerId, role: 'REVIEWER' as const };
    const approver = { kind: 'HUMAN' as const, accountId: approverId, role: 'APPROVER' as const };

    await questionsSvc.transition(ids[0], 'QUARANTINED', reviewer, { reasonCode: 'ANSWER_WRONG', note: 'Reported wrong.' });
    expect(await prisma.question_publication.findUniqueOrThrow({ where: { revision_id: ids[0] } })).toMatchObject({ state: 'WITHDRAWN', withdrawn_by: reviewerId, withdraw_reason_code: 'ANSWER_WRONG' });
    await questionsSvc.transition(ids[1], 'RETIRED', reviewer, { reasonCode: 'OTHER', note: 'No longer needed.' });
    expect((await prisma.question_publication.findUniqueOrThrow({ where: { revision_id: ids[1] } })).state).toBe('WITHDRAWN');

    await questionsSvc.transition(ids[0], 'APPROVED', approver, { reasonCode: 'OTHER', note: 'Checked, the key is right.' });
    expect((await prisma.question_publication.findUniqueOrThrow({ where: { revision_id: ids[0] } })).state).toBe('WITHDRAWN');
    await readyToPublish([ids[0]]);
    await publicationSvc.publish(approverId, ids[0]);
    expect((await prisma.question_publication.findUniqueOrThrow({ where: { revision_id: ids[0] } })).state).toBe('PUBLISHED');
    expect(await prisma.question_publication_event.count({ where: { revision_id: ids[0] } })).toBe(3);
  });

  it('refuses to publish in a curriculum that is not active, and reports it in publish-all', async () => {
    const { id } = await curriculumService.createSubjectVersion(
      { curriculumCode: 'EXAMCUR3', curriculumName: 'Third', versionLabel: '2026-27', gradeCode: 'G8', subjectCode: 'DRAFTPUB', subjectName: 'Draft Pub' },
      editor,
    );
    await bank(id, 3, { published: false });
    const approver = await roleAccount('CURRICULUM_APPROVER');
    const ids = await revisionIds(id);
    await readyToPublish(ids);
    await expect(publicationSvc.publish(approver, ids[0])).rejects.toThrow(/not active|no longer exists/);
    const r = await publicationSvc.publishUnit(approver, id);
    expect(r.published).toBe(0);
    expect(r.skipped).toHaveLength(3);
    expect(await prisma.question_publication.count()).toBe(0);
  });

  it('one publication row per version, even when two approvers click at once', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 1, { published: false });
    const [rev] = await revisionIds(unitId);
    await readyToPublish([rev]);
    const a = await roleAccount('CURRICULUM_APPROVER');
    const b = await roleAccount('CURRICULUM_APPROVER');
    const results = await Promise.allSettled([publicationSvc.publish(a, rev), publicationSvc.publish(b, rev)]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await prisma.question_publication.count({ where: { revision_id: rev } })).toBe(1);
  });

  // ---- Step 10: tests are built from published blueprint versions ----

  const blueprintSvc = new BlueprintService(dbService, authzService, outbox);

  it('the migration seeds Quick 10 (on, published, 5/3/2), a 20-question draft (off) and a 25-question shell (off)', async () => {
    const rows = await prisma.assessment_blueprint.findMany({
      where: { code: { in: ['QUICK10', 'SUBJECT20', 'SUBJECT25'] } },
      orderBy: { code: 'asc' },
      include: { versions: { include: { difficulties: true, types: true } } },
    });
    expect(rows.map((b) => [b.code, b.enabled, b.versions.map((v) => `${v.version}:${v.status}`)])).toEqual([
      ['QUICK10', true, ['1:PUBLISHED']],
      ['SUBJECT20', false, ['1:DRAFT']],
      ['SUBJECT25', false, []],
    ]);
    const q10 = rows[0].versions[0];
    expect(q10).toMatchObject({ total_questions: 10, scope_mode: 'WHOLE_SUBJECT', prefer_unseen: true, opening_difficulty: 'EASY' });
    expect(Object.fromEntries(q10.difficulties.map((d) => [d.difficulty, d.count]))).toEqual({ EASY: 5, MEDIUM: 3, HARD: 2 });
    expect(q10.types.map((t) => [t.question_type, t.count])).toEqual([['MCQ', 10]]);
    const s20 = rows[1].versions[0];
    expect(Object.fromEntries(s20.difficulties.map((d) => [d.difficulty, d.count]))).toEqual({ EASY: 8, MEDIUM: 7, HARD: 5 });
  });

  it('a test records its assembly run: the published version, one decision per question, and what was relaxed', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12); // 4 per difficulty: Quick 10 wants 5 EASY, so one comes from MEDIUM
    const { accountId } = await adult();
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    const session = await prisma.assessment_session.findUniqueOrThrow({ where: { id: assessmentId }, include: { instance: { include: { items: true } } } });
    const run = await prisma.assessment_assembly_run.findUniqueOrThrow({ where: { instance_id: session.instance_id }, include: { decisions: true, blueprint_version: { include: { blueprint: true } } } });
    expect(run.blueprint_version.blueprint.code).toBe('QUICK10');
    expect(run).toMatchObject({ engine_version: 'assembly-v1', mode: 'TEST', seed: session.instance.seed, relaxed: true, eligible_count: 12 });
    expect(run.relaxations).toEqual([{ kind: 'DIFFICULTY_SUBSTITUTED', wanted: 'EASY', got: 'MEDIUM', count: 1 }]);
    expect(run.decisions).toHaveLength(10);
    const byPos = new Map(session.instance.items.map((i) => [i.position, i.question_revision_id]));
    for (const d of run.decisions) expect(d.question_revision_id).toBe(byPos.get(d.position));
    expect(run.decisions.filter((d) => d.requirement === 'SUBSTITUTE')).toHaveLength(1);
  });

  it('the database allows one published and one draft version per design', async () => {
    const q10 = await prisma.assessment_blueprint.findUniqueOrThrow({ where: { code: 'QUICK10' } });
    await expect(prisma.assessment_blueprint_version.create({ data: { blueprint_id: q10.id, version: 99, status: 'PUBLISHED', total_questions: 10 } })).rejects.toThrow();
    const s20 = await prisma.assessment_blueprint.findUniqueOrThrow({ where: { code: 'SUBJECT20' } });
    await expect(prisma.assessment_blueprint_version.create({ data: { blueprint_id: s20.id, version: 99, status: 'DRAFT', total_questions: 20 } })).rejects.toThrow();
  });

  it('a design is drafted, previewed, published and switched on; a new version retires the old; tests keep their version', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const editor = await roleAccount('CURRICULUM_EDITOR');
    const approver = await roleAccount('CURRICULUM_APPROVER');
    const { accountId } = await adult();

    const made = await blueprintSvc.create(editor, { code: 'IT_TEN', name: 'Integration ten', design: { totalQuestions: 10, difficulty: { EASY: 4, MEDIUM: 4, HARD: 2 } } });
    const v1 = made.versions[0].versionId;
    const preview = await blueprintSvc.preview(editor, v1, unitId, 'fixed');
    expect(preview).toMatchObject({ ok: true, blueprint: 'IT_TEN', version: 1, status: 'DRAFT' });
    expect(await blueprintSvc.preview(editor, v1, unitId, 'fixed')).toEqual(preview);
    expect(await prisma.assessment_assembly_run.count()).toBe(0);

    await expect(exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST', blueprint: 'IT_TEN' })).rejects.toThrow(/not available/);
    await expect(blueprintSvc.publishDraft(editor, made.id)).rejects.toThrow(/only an approver/);
    await blueprintSvc.publishDraft(approver, made.id);
    await blueprintSvc.setEnabled(approver, made.id, true);

    const first = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST', blueprint: 'IT_TEN' });
    const inst1 = (await prisma.assessment_session.findUniqueOrThrow({ where: { id: first.assessmentId }, include: { instance: { include: { assembly_run: true } } } })).instance;
    expect(inst1).toMatchObject({ blueprint_code: 'IT_TEN', blueprint_version: 1 });
    expect(inst1.assembly_run!.blueprint_version_id).toBe(v1);

    await blueprintSvc.saveDraft(editor, made.id, { totalQuestions: 10, difficulty: { EASY: 3, MEDIUM: 4, HARD: 3 } });
    const after = await blueprintSvc.publishDraft(approver, made.id);
    expect(after.versions.map((v) => `${v.version}:${v.status}`)).toEqual(['2:PUBLISHED', '1:RETIRED']);
    expect(after.versions[1].testsBuilt).toBe(1);

    const second = await exam.create(accountId, { subjectVersionId: unitId, mode: 'PRACTICE', blueprint: 'IT_TEN' });
    const inst2 = (await prisma.assessment_session.findUniqueOrThrow({ where: { id: second.assessmentId }, include: { instance: true } })).instance;
    expect(inst2).toMatchObject({ blueprint_code: 'IT_TEN', blueprint_version: 2 });
    // The first test still says which version it was built from.
    expect((await prisma.assessment_instance.findUniqueOrThrow({ where: { id: inst1.id } })).blueprint_version).toBe(1);

    const codes = async () => (await exam.listUnits(accountId))[0].tests.map((t) => t.code);
    // FOCUS10 is seeded on by the Step 12 migration.
    expect(await codes()).toEqual(['FOCUS10', 'IT_TEN', 'QUICK10']);
    await blueprintSvc.setEnabled(approver, made.id, false);
    expect(await codes()).toEqual(['FOCUS10', 'QUICK10']);
    const events = (await prisma.outbox_event.findMany({ where: { aggregate_id: made.id } })).map((e) => e.event_type);
    expect(events).toEqual(['blueprint.version_published.v1', 'blueprint.version_published.v1']);
  });

  // ---- Step 11: execution hardening ----

  const invalidations = new ItemInvalidationService(dbService, authzService, outbox);

  /** A second student on the jurisdiction policy adult() already activated. */
  async function anotherStudent() {
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await privacyService.recordAgeClassification({ studentId: student.id, dateOfBirth: new Date('2001-03-01'), jurisdictionCode: DEFAULT_JURISDICTION, dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: account.id });
    await prisma.student_academic_context.create({ data: { student_id: student.id, curriculum_code: 'EXAMCUR', grade_code: 'G8' } });
    return { accountId: account.id, studentId: student.id };
  }
  async function itemsOf(assessmentId: string) {
    const s = await prisma.assessment_session.findUniqueOrThrow({ where: { id: assessmentId }, include: { instance: { include: { items: { orderBy: { position: 'asc' } } } } } });
    return s.instance.items;
  }
  /** Answers whatever is current until the summary, every answer correct. Returns the positions shown. */
  async function answerAll(accountId: string, assessmentId: string): Promise<number[]> {
    const shown: number[] = [];
    for (;;) {
      const v = await exam.present(accountId, assessmentId);
      if (v.phase !== 'QUESTION') return shown;
      shown.push(v.question!.position);
      await exam.lock(accountId, assessmentId, v.question!.position, { slot: await correctSlot(assessmentId, v.question!.position), activeMs: 1000, idempotencyKey: key() });
    }
  }

  it('InvalidateAssessmentItem: a finished result is rescored with a record; a running test skips the item; repeating changes nothing', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const approver = await roleAccount('CURRICULUM_APPROVER');
    const s1 = await adult();
    const s2 = await anotherStudent();

    const t1 = await exam.create(s1.accountId, { subjectVersionId: unitId, mode: 'TEST' });
    expect(await answerAll(s1.accountId, t1.assessmentId)).toHaveLength(10);
    await exam.submit(s1.accountId, t1.assessmentId);
    const t2 = await exam.create(s2.accountId, { subjectVersionId: unitId, mode: 'TEST' });

    // A version both tests used (10 + 10 from 12 questions, so there is at least one).
    const used2 = new Set((await itemsOf(t2.assessmentId)).map((i) => i.question_revision_id));
    const target = (await itemsOf(t1.assessmentId)).find((i) => used2.has(i.question_revision_id))!.question_revision_id;

    const note = 'The marked answer is wrong; C is correct.';
    await expect(invalidations.invalidate(approver, target, { reasonCode: 'ANSWER_WRONG', note })).rejects.toThrow(/out of serving/);
    await prisma.question_revision.update({ where: { id: target }, data: { state: 'QUARANTINED' } });
    expect(await invalidations.impact(approver, target)).toMatchObject({ items: 2, submitted: 1, inProgress: 1, blockers: [] });

    const out = await invalidations.invalidate(approver, target, { reasonCode: 'ANSWER_WRONG', note });
    expect(out).toMatchObject({ itemsAffected: 2, resultsRescored: 1, sessionsInvalidated: 0, repeated: false });

    const r1 = await exam.result(s1.accountId, t1.assessmentId);
    expect(r1).toMatchObject({ total: 9, correct: 9, removed: 1, corrected: true, competitiveEligible: true });
    const corr = await prisma.assessment_result_correction.findMany({ where: { session_id: t1.assessmentId } });
    expect(corr).toHaveLength(1);
    expect(corr[0]).toMatchObject({ reason: 'INVALIDATION', invalidation_id: out.invalidationId });
    expect(corr[0].before).toMatchObject({ total: 10, correct: 10 });
    expect(corr[0].after).toMatchObject({ total: 9, correct: 9 });
    expect((await prisma.outbox_event.findMany({ where: { aggregate_id: t1.assessmentId, event_type: 'assessment.rescored.v1' } }))).toHaveLength(1);

    const shown = await answerAll(s2.accountId, t2.assessmentId);
    expect(shown).toHaveLength(9);
    await exam.submit(s2.accountId, t2.assessmentId);
    expect(await exam.result(s2.accountId, t2.assessmentId)).toMatchObject({ total: 9, correct: 9, removed: 1, corrected: false });

    expect(await invalidations.invalidate(approver, target, { reasonCode: 'ANSWER_AMBIGUOUS', note: 'A different reason this time.' })).toMatchObject({ invalidationId: out.invalidationId, repeated: true });
    expect(await prisma.assessment_result_correction.count()).toBe(1);
  });

  it('a question that cannot be shown is a technical failure: skipped, and not counted', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId } = await adult();
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    const first = (await itemsOf(assessmentId))[0];
    await prisma.question_option.deleteMany({ where: { revision_id: first.question_revision_id, position: 3 } });
    const v = await exam.present(accountId, assessmentId);
    expect(v).toMatchObject({ phase: 'QUESTION', removed: 1 });
    expect(v.question!.position).toBe(2);
    expect((await itemsOf(assessmentId))[0].excluded).toBe('TECHNICAL_FAILURE');
  });

  it('a retried skip with the same request key is accepted once', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId } = await adult();
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await exam.present(accountId, assessmentId);
    const k = key();
    const both = await Promise.allSettled([
      exam.skip(accountId, assessmentId, 1, { activeMs: 1, idempotencyKey: k }),
      exam.skip(accountId, assessmentId, 1, { activeMs: 1, idempotencyKey: k }),
    ]);
    expect(both.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await prisma.student_response.findFirstOrThrow({ where: { session_id: assessmentId, state: 'SKIPPED' } })).toMatchObject({ skip_count: 1 });
    expect(await prisma.student_response_event.count({ where: { session_id: assessmentId, event_type: 'SKIPPED' } })).toBe(1);
  });

  it('the sweeper settles expired tests without the student coming back', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId } = await adult();
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await exam.present(accountId, assessmentId);
    await exam.lock(accountId, assessmentId, 1, { slot: await correctSlot(assessmentId, 1), activeMs: 1, idempotencyKey: key() });
    await prisma.assessment_session.update({ where: { id: assessmentId }, data: { expires_at: new Date(Date.now() - 60_000) } });
    expect(await exam.sweepExpired()).toBe(1);
    expect(await prisma.assessment_session.findUniqueOrThrow({ where: { id: assessmentId } })).toMatchObject({ status: 'SUBMITTED' });
    expect(await prisma.assessment_result.findUniqueOrThrow({ where: { session_id: assessmentId } })).toMatchObject({ total: 10, correct: 1, unanswered: 9 });
    expect(await exam.sweepExpired()).toBe(0);
  });

  // ---- Step 12: student web journey ----

  const recommendations = new RecommendationService(dbService, exam, outbox);
  const homes = new HomeService(dbService, exam, recommendations);

  it('a student is offered only their own curriculum and grade; another cohort is Coming soon, never substituted', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();
    expect((await exam.listUnits(accountId)).map((u) => u.subjectVersionId)).toEqual([unitId]);

    await prisma.student_academic_context.update({ where: { student_id: studentId }, data: { grade_code: 'G9' } });
    expect(await exam.listUnits(accountId)).toEqual([]);
    await expect(exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' })).rejects.toThrow(/not part of your curriculum and grade/);
    expect(await homes.home(accountId)).toMatchObject({ supported: false, nextAction: { kind: 'COMING_SOON' } });

    await prisma.student_academic_context.delete({ where: { student_id: studentId } });
    expect(await homes.home(accountId)).toMatchObject({ cohort: null, nextAction: { kind: 'FINISH_PROFILE' } });
  });

  it('Home: first test builds the mastery profile (Focus 10 on chosen chapters), then resume, then the next subject', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();

    expect((await homes.home(accountId)).nextAction).toMatchObject({ kind: 'FIRST_TEST', blueprint: 'QUICK10', reason: 'Building your mastery profile' });
    await prisma.student_chapter_selection.create({ data: { student_id: studentId, subject_code: 'EXAMSUBJ', chapter_code: 'CH01' } });
    const first = await homes.home(accountId);
    expect(first).toMatchObject({ firstExperience: true, nextAction: { kind: 'FIRST_TEST', subjectVersionId: unitId, blueprint: 'FOCUS10', mode: 'TEST' } });
    expect(first.subjects[0]).toMatchObject({ chosenChapters: 1, completed: 0, lastResult: null });

    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST', blueprint: 'FOCUS10' });
    const inst = (await prisma.assessment_session.findUniqueOrThrow({ where: { id: assessmentId }, include: { instance: true } })).instance;
    expect(inst.blueprint_code).toBe('FOCUS10');
    expect(inst.assembly_report).toMatchObject({ scope: { mode: 'STUDENT_FOCUS', strict: false, chapters: ['CH01'] } });
    expect((await homes.home(accountId)).nextAction).toMatchObject({ kind: 'RESUME', assessmentId });

    expect(await answerAll(accountId, assessmentId)).toHaveLength(10);
    await exam.submit(accountId, assessmentId);
    const after = await homes.home(accountId);
    expect(after).toMatchObject({ firstExperience: false, nextAction: { kind: 'TAKE_TEST', subjectVersionId: unitId } });
    expect(after.subjects[0]).toMatchObject({ completed: 1, lastResult: { assessmentId, correct: 10, total: 10, mode: 'TEST' } });
  });

  // ---- Step 13: mastery ----

  const mastery = new MasteryService(dbService, outbox);
  const masteryViews = new MasteryViewService(dbService, exam, authzService);
  const LO = 'CH01/T01/MC01/LO01';

  async function finishedTest(accountId: string, unitId: string): Promise<string> {
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await answerAll(accountId, assessmentId);
    await exam.submit(accountId, assessmentId);
    return assessmentId;
  }

  it('mastery: the seeded policy is active; a finished test becomes weighted evidence once; two tests pass the gate', async () => {
    expect(await prisma.mastery_policy_version.findMany({ where: { status: 'ACTIVE' }, select: { code: true } })).toEqual([{ code: 'MASTERY_V1' }]);
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();

    const t1 = await finishedTest(accountId, unitId);
    expect((await masteryViews.mine(accountId)).pending).toBe(1);
    const runs = await mastery.reconcile();
    expect(runs).toEqual([expect.objectContaining({ sessionId: t1, evidenceAdded: 10, objectivesChanged: 1 })]);
    expect(await mastery.reconcile()).toEqual([]);
    expect(await prisma.mastery_evidence_event.count({ where: { student_id: studentId } })).toBe(10);
    const ev = await prisma.mastery_evidence_event.findFirstOrThrow({ where: { session_id: t1 } });
    expect(ev).toMatchObject({ objective_path: LO, w_context: 0.9, w_quality: 0.9, w_independence: 1, weight: 0.81, score: 1 });
    expect(ev.learning_objective_id).not.toBeNull();
    let state = await prisma.student_mastery_state.findFirstOrThrow({ where: { student_id: studentId, objective_path: LO } });
    expect(state).toMatchObject({ evidence_count: 10, sessions: 1, label: 'BUILDING_EVIDENCE', reportable: false });

    await finishedTest(accountId, unitId);
    await mastery.reconcile();
    state = await prisma.student_mastery_state.findFirstOrThrow({ where: { student_id: studentId, objective_path: LO } });
    expect(state).toMatchObject({ evidence_count: 20, sessions: 2, families: 12, reportable: true, label: 'STRONG' });
    expect(state.confidence).toBeGreaterThanOrEqual(85);
    // The questions seen again count almost nothing.
    expect(await prisma.mastery_evidence_event.count({ where: { student_id: studentId, w_independence: 0.05 } })).toBe(8);
    expect(await prisma.mastery_state_change.count({ where: { student_id: studentId } })).toBe(2);
    expect(await prisma.student_difficulty_state.count({ where: { student_id: studentId } })).toBe(3);

    const view = await masteryViews.mine(accountId);
    expect(view).toMatchObject({ pending: 0, subjects: [{ objectives: 1, started: 1, reportable: 1, chapters: [{ code: 'CH01', items: [{ path: LO, label: 'STRONG', answers: 20 }] }] }] });
    expect(JSON.stringify(view)).not.toMatch(/confidence/);
  });

  it('mastery: invalidating a question withdraws its evidence and recomputes, with the change recorded', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();
    const approver = await roleAccount('CURRICULUM_APPROVER');
    const t1 = await finishedTest(accountId, unitId);
    await mastery.reconcile();

    const target = (await itemsOf(t1))[0].question_revision_id;
    await prisma.question_revision.update({ where: { id: target }, data: { state: 'QUARANTINED' } });
    await invalidations.invalidate(approver, target, { reasonCode: 'ANSWER_WRONG', note: 'The marked answer is wrong.' });
    const [run] = await mastery.reconcile();
    expect(run).toMatchObject({ sessionId: t1, evidenceAdded: 0, evidenceInvalidated: 1, objectivesChanged: 1 });
    expect(await prisma.mastery_evidence_event.count({ where: { student_id: studentId, invalidation_reason: 'ITEM_INVALIDATED' } })).toBe(1);
    expect(await prisma.student_mastery_state.findFirstOrThrow({ where: { student_id: studentId, objective_path: LO } })).toMatchObject({ evidence_count: 9 });
    expect(await prisma.mastery_update_run.findMany({ where: { session_id: t1 }, orderBy: { result_revision: 'asc' }, select: { result_revision: true } })).toEqual([{ result_revision: 0 }, { result_revision: 1 }]);
  });

  // ---- Step 14: recommendations, practice and retest ----

  /** Answers whatever is current until the summary; `right(n)` decides whether the n-th answer (0-based) is correct. */
  async function answerWith(accountId: string, assessmentId: string, right: (n: number) => boolean): Promise<void> {
    for (let n = 0; ; n++) {
      const v = await exam.present(accountId, assessmentId);
      if (v.phase !== 'QUESTION') return;
      const p = v.question!.position;
      const c = await correctSlot(assessmentId, p);
      await exam.lock(accountId, assessmentId, p, { slot: right(n) ? c : (c + 1) % 4, activeMs: 1000, idempotencyKey: key() });
    }
  }
  const instanceOf = async (assessmentId: string) => (await prisma.assessment_session.findUniqueOrThrow({ where: { id: assessmentId }, include: { instance: true } })).instance;

  it('recommendations: the seeded policy and designs; practise what you missed, then a retest, each recorded', async () => {
    expect(await prisma.recommendation_policy_version.findMany({ where: { status: 'ACTIVE' }, select: { code: true } })).toEqual([{ code: 'RECO_V1' }]);
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();
    // Practice and retest designs are never offered as ordinary tests.
    expect((await exam.listUnits(accountId))[0].tests.map((t) => t.code)).not.toEqual(expect.arrayContaining(['PRACTICE10']));
    await expect(exam.create(accountId, { subjectVersionId: unitId, mode: 'PRACTICE', blueprint: 'PRACTICE10' })).rejects.toThrow(/recommendation/);

    const { assessmentId: t1 } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await answerWith(accountId, t1, (n) => n < 6);
    await exam.submit(accountId, t1);

    const p = await recommendations.practiseMissed(accountId, t1);
    expect(p.resumed).toBe(false);
    expect(await recommendations.practiseMissed(accountId, t1)).toEqual({ ...p, resumed: true });
    const practice = await prisma.recommendation.findUniqueOrThrow({ where: { id: p.recommendationId }, include: { reasons: true } });
    expect(practice).toMatchObject({ kind: 'PRACTICE', source: 'RESULT', status: 'STARTED', source_assessment_id: t1, objective_paths: [LO] });
    expect(practice.reasons).toEqual([expect.objectContaining({ objective_path: LO, code: 'MISSED_IN_TEST', facts: { assessmentId: t1, missed: 4 } })]);
    const pi = await instanceOf(p.assessmentId);
    expect(pi).toMatchObject({ mode: 'PRACTICE', blueprint_code: 'PRACTICE10', recommendation_id: practice.id, target_objectives: [LO] });
    expect((pi.assembly_report as any).scope).toMatchObject({ mode: 'OBJECTIVES', objectives: [LO] });

    await answerWith(accountId, p.assessmentId, () => true);
    await exam.submit(accountId, p.assessmentId);
    expect(await mastery.reconcile()).toHaveLength(2);
    const refreshed = await recommendations.reconcile();
    expect(refreshed).toHaveLength(2);
    expect(await recommendations.reconcile()).toEqual([]);
    expect(await prisma.recommendation.findUniqueOrThrow({ where: { id: practice.id } })).toMatchObject({ status: 'COMPLETED' });
    const retest = await prisma.recommendation.findFirstOrThrow({ where: { student_id: studentId, kind: 'RETEST' }, include: { reasons: true } });
    expect(retest).toMatchObject({ status: 'OPEN', source: 'PRACTICE_DONE', parent_id: practice.id, objective_paths: [LO] });
    expect(retest.reasons[0]).toMatchObject({ code: 'PRACTISED', facts: { practiceAnswers: 10 } });

    expect((await homes.home(accountId)).nextAction).toMatchObject({ kind: 'RETEST', recommendationId: retest.id, objectives: 1 });
    const r = await recommendations.start(accountId, retest.id);
    expect(await instanceOf(r.assessmentId)).toMatchObject({ mode: 'TEST', blueprint_code: 'RETEST10', recommendation_id: retest.id });
    await answerWith(accountId, r.assessmentId, () => true);
    await exam.submit(accountId, r.assessmentId);
    await mastery.reconcile();
    await recommendations.reconcile();
    expect(await prisma.recommendation.findUniqueOrThrow({ where: { id: retest.id } })).toMatchObject({ status: 'COMPLETED' });
    // The retest is ordinary test evidence (Quick-size context), not practice.
    expect(await prisma.mastery_evidence_event.findFirstOrThrow({ where: { session_id: r.assessmentId } })).toMatchObject({ mode: 'TEST', w_context: 0.9, blueprint_code: 'RETEST10' });

    // CREATED and STARTED can share a millisecond, so compare as a set.
    const types = (await prisma.recommendation_event.findMany({ where: { recommendation_id: practice.id } })).map((e) => e.type).sort();
    expect(types).toEqual(['COMPLETED', 'CREATED', 'STARTED']);
    const published = (await prisma.outbox_event.findMany({ where: { aggregate_id: practice.id } })).map((e) => e.event_type);
    expect(published).toEqual(expect.arrayContaining(['recommendation.created.v1', 'recommendation.started.v1', 'recommendation.completed.v1']));
  });

  // ---- Step 15: competitive points, XP and weekly leaderboards ----

  const competition = new CompetitionService(dbService, exam, outbox);

  /** Another adult in the same cohort (the jurisdiction policy is already active from adult()). */
  async function anotherAdult() {
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await privacyService.recordAgeClassification({ studentId: student.id, dateOfBirth: new Date('2000-05-01'), jurisdictionCode: DEFAULT_JURISDICTION, dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: account.id });
    await prisma.student_academic_context.create({ data: { student_id: student.id, curriculum_code: 'EXAMCUR', grade_code: 'G8' } });
    return { accountId: account.id, studentId: student.id };
  }
  async function tookTest(accountId: string, unitId: string, right: (n: number) => boolean, mode: 'TEST' | 'PRACTICE' = 'TEST'): Promise<string> {
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode });
    await answerWith(accountId, assessmentId, right);
    await exam.submit(accountId, assessmentId);
    return assessmentId;
  }

  it('competition: the seeded policy; a test earns CP once; a rescore adds a compensating entry; the ledger refuses edits', async () => {
    // Step 16 retired CP_V1 for CP_V2 (CP_V1 plus ranked challenges); everything below is the same under both.
    expect(await prisma.competitive_scoring_policy.findMany({ orderBy: { code: 'asc' }, select: { code: true, status: true } })).toEqual([
      { code: 'CP_V1', status: 'RETIRED' },
      { code: 'CP_V2', status: 'ACTIVE' },
    ]);
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();
    const approver = await roleAccount('CURRICULUM_APPROVER');

    const t1 = await tookTest(accountId, unitId, (n) => n < 7);
    const [first] = await competition.reconcile();
    expect(first).toMatchObject({ sessionId: t1, qualified: true, ledger: { kind: 'AWARD' }, xp: 15 });
    expect(first.cp).toBeGreaterThan(0);
    expect(first.cp).toBeLessThanOrEqual(90);
    expect(await competition.reconcile()).toEqual([]);
    expect(await prisma.public_profile.findUniqueOrThrow({ where: { student_id: studentId } })).toMatchObject({ handle: expect.stringMatching(/^Learner-/) });

    // Append-only, enforced by the database.
    await expect(prisma.cp_event.updateMany({ where: { session_id: t1 }, data: { amount: 1 } })).rejects.toThrow(/append-only/);
    await expect(prisma.cp_event.deleteMany({ where: { session_id: t1 } })).rejects.toThrow(/append-only/);

    // Remove a question the student got right: accuracy on what is left drops, so CP is corrected by a new entry.
    const items = await itemsOf(t1);
    const responses = await prisma.student_response.findMany({ where: { session_id: t1, is_correct: true } });
    const target = items.find((i) => responses.some((r) => r.instance_question_id === i.id))!.question_revision_id;
    await prisma.question_revision.update({ where: { id: target }, data: { state: 'QUARANTINED' } });
    await invalidations.invalidate(approver, target, { reasonCode: 'ANSWER_WRONG', note: 'The marked answer is wrong.' });
    const [second] = await competition.reconcile();
    expect(second).toMatchObject({ sessionId: t1, qualified: true, xp: 0 });
    expect(second.ledger).toMatchObject({ kind: 'ADJUSTMENT' });
    expect(second.ledger!.amount).toBeLessThan(0);
    const events = await prisma.cp_event.findMany({ where: { session_id: t1 }, orderBy: { created_at: 'asc' } });
    expect(events.map((e) => e.kind)).toEqual(['AWARD', 'ADJUSTMENT']);
    expect(events.reduce((a, e) => a + e.amount, 0)).toBe(second.cp);
    expect(new Set(events.map((e) => e.earned_at.toISOString())).size).toBe(1);
    expect(await prisma.competitive_qualification.findMany({ where: { session_id: t1 }, orderBy: { result_revision: 'asc' }, select: { result_revision: true } })).toEqual([{ result_revision: 0 }, { result_revision: 1 }]);
    expect(await prisma.xp_event.count({ where: { session_id: t1 } })).toBe(1);
    expect((await prisma.outbox_event.findMany({ where: { aggregate_id: studentId, event_type: 'competition.cp_recorded.v1' } })).length).toBe(2);
  });

  it('competition: the weekly board needs 2 tests and 20 questions, lists handles and CP only, never shows a minor to others; practice earns XP only', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const me = await adult();
    const rival = await anotherAdult();
    const kid = await anotherAdult();

    await tookTest(me.accountId, unitId, (n) => n < 7);
    await tookTest(rival.accountId, unitId, () => true);
    await tookTest(rival.accountId, unitId, () => true);
    await tookTest(kid.accountId, unitId, () => true);
    await tookTest(kid.accountId, unitId, () => true);
    const practice = await tookTest(me.accountId, unitId, () => true, 'PRACTICE');
    await competition.reconcile();
    // Release 1 rule under test: a minor is never listed to other students (here the classification says minor).
    await prisma.age_classification.updateMany({ where: { student_id: kid.studentId }, data: { is_minor: true } });

    expect(await prisma.competitive_qualification.findFirstOrThrow({ where: { session_id: practice } })).toMatchObject({ qualified: false, reasons: ['NOT_A_TEST'], cp: 0 });
    expect(await prisma.cp_event.count({ where: { session_id: practice } })).toBe(0);
    expect(await prisma.xp_event.findUniqueOrThrow({ where: { session_id: practice } })).toMatchObject({ mode: 'PRACTICE', amount: 15 });

    let view = await competition.view(me.accountId);
    let board = view.boards.find((b) => b.scope === 'COHORT')!;
    expect(view).toMatchObject({ policy: 'CP_V2', shownToOthers: true, canChangeVisibility: true, xp: { week: 30, total: 30 } });
    expect(board.you).toMatchObject({ qualified: 1, eligibleQuestions: 10, rank: null, needs: { tests: 1, questions: 10 } });
    expect(board.entries).toHaveLength(1);
    expect(board.entries[0]).toMatchObject({ rank: 1, you: false, handle: expect.stringMatching(/^Learner-/) });

    await tookTest(me.accountId, unitId, (n) => n < 7);
    await competition.reconcile();
    view = await competition.view(me.accountId);
    board = view.boards.find((b) => b.scope === 'COHORT')!;
    expect(board.entries.map((e) => [e.rank, e.you])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(board.rankedCount).toBe(2);
    expect(view.boards.find((b) => b.scope === 'SUBJECT')!.entries).toHaveLength(2);
    const json = JSON.stringify(view);
    expect(json).not.toMatch(/accuracy|studentId/);
    expect(json).not.toContain(kid.studentId);

    // The minor sees the board and their own rank, but cannot be shown to others.
    const kidView = await competition.view(kid.accountId);
    expect(kidView).toMatchObject({ shownToOthers: false, canChangeVisibility: false });
    expect(kidView.boards[0].you.rank).not.toBeNull();
    await expect(competition.setShown(kid.accountId, true)).rejects.toThrow(/minors are not shown/);

    // An adult may hide; then others no longer see them.
    await competition.setShown(rival.accountId, false);
    expect((await competition.view(me.accountId)).boards[0].entries.map((e) => e.you)).toEqual([true]);
  });

  // ---- Step 16: friends and ranked challenges (switched on here; off by default) ----

  const social = new SocialService(dbService, exam, privacyService, authzService, outbox, { enabled: true });

  /**
   * A minor in the cohort whose guardian approved them through the REAL guardian flow (invitation, signed-in guardian,
   * consent wording, verification, authority, consent record): no part of the guardian lookup is faked.
   * Call after adult(): it activates a policy that accepts the email-link method.
   */
  let guardianLink = '';
  const guardianFlow = new GuardianService(dbService, privacyService, outbox, { sendInvitation: async (_to: string, link: string) => { guardianLink = link; } }, 'https://app.example.com');
  async function guardedMinor(guardianEmail = 'mum@example.com') {
    const { id: policyId } = await privacyService.createJurisdictionPolicyDraft(
      { jurisdictionCode: DEFAULT_JURISDICTION, config: { minorAgeThreshold: 18, guardianConsentAgeThreshold: 18, acceptedDobEvidenceMethods: ['SELF_DECLARED'], acceptedGuardianVerificationMethods: ['EMAIL_LINK_ATTESTATION'] } },
      null,
    );
    await privacyService.markPolicyCounselReviewed(policyId, 'LEGAL-OPINION-001', null);
    await privacyService.activateJurisdictionPolicy(policyId, null);
    await privacyService.publishConsentWording({ purposeCode: 'CORE_SERVICE', textReference: DEV_DRAFT_WORDING_REFERENCE, description: 'Core service' });
    const account = await prisma.account.create({ data: {} });
    await prisma.authentication_identity.create({ data: { account_id: account.id, kind: 'EMAIL', identifier_normalized: `maya${++uniq}@example.com`, verified_at: new Date() } });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await privacyService.recordAgeClassification({ studentId: student.id, dateOfBirth: new Date('2013-05-01'), jurisdictionCode: DEFAULT_JURISDICTION, dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: account.id });
    await prisma.student_academic_context.create({ data: { student_id: student.id, curriculum_code: 'EXAMCUR', grade_code: 'G8' } });
    await guardianFlow.createInvitation(account.id, { email: guardianEmail, relationshipType: 'MOTHER' });
    const guardian = await prisma.account.create({ data: {} });
    await prisma.authentication_identity.create({ data: { account_id: guardian.id, kind: 'EMAIL', identifier_normalized: guardianEmail, verified_at: new Date() } });
    const token = guardianLink.split('#t=')[1];
    const preview = await guardianFlow.preview(guardian.id, token);
    await guardianFlow.accept(guardian.id, { token, consentVersion: preview.consent.version, attested: true });
    expect((await privacyService.getClassificationSummary(student.id)).consentSatisfied).toBe(true);
    return { accountId: account.id, studentId: student.id, guardianId: guardian.id };
  }

  it('social: friends by an in-person code, a ranked challenge on the same ten unseen questions, results only when both finish, CP_V2', async () => {
    expect(await prisma.competitive_scoring_policy.findMany({ where: { status: 'ACTIVE' }, select: { code: true } })).toEqual([{ code: 'CP_V2' }]);
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const alice = await adult();
    const bob = await anotherAdult();

    const { code } = await social.createCode(alice.accountId);
    const f = await social.redeem(bob.accountId, code);
    expect(f.status).toBe('ACTIVE');
    await expect(social.redeem(bob.accountId, code)).rejects.toThrow(/not valid/);
    expect(await prisma.friend_code_attempt.count({ where: { student_id: bob.studentId, ok: false } })).toBe(1);

    const { challengeId } = await social.createChallenge(alice.accountId, { friendshipId: f.friendshipId, subjectVersionId: unitId });
    const a = await social.start(alice.accountId, challengeId);
    const b = await social.respond(bob.accountId, challengeId, true);
    const [ia, ib] = await Promise.all([itemsOf(a.assessmentId), itemsOf(b.assessmentId!)]);
    expect(ia.map((i) => [i.position, i.question_revision_id, i.option_order.join()])).toEqual(ib.map((i) => [i.position, i.question_revision_id, i.option_order.join()]));
    expect(new Set(ia.map((i) => i.question_id)).size).toBe(10);

    await answerWith(alice.accountId, a.assessmentId, (n) => n < 8);
    await exam.submit(alice.accountId, a.assessmentId);
    // Bob cannot see how Alice did until he has finished too.
    let bobView = (await social.overview(bob.accountId)).challenges![0];
    expect(bobView).toMatchObject({ status: 'ACTIVE', myState: 'IN_PROGRESS', result: null });
    await answerWith(bob.accountId, b.assessmentId!, (n) => n < 6);
    await exam.submit(bob.accountId, b.assessmentId!);
    bobView = (await social.overview(bob.accountId)).challenges![0];
    expect(bobView).toMatchObject({ status: 'COMPLETED', result: { mine: { correct: 6, total: 10 }, theirs: { correct: 8, total: 10 }, outcome: 'LOSS' } });
    expect((await social.overview(alice.accountId)).challenges![0].result!.outcome).toBe('WIN');

    // A challenge test earns CP like a Quick 10 (CP_V2); losing costs nothing.
    await competition.reconcile();
    const quals = await prisma.competitive_qualification.findMany({ where: { session_id: { in: [a.assessmentId, b.assessmentId!] } } });
    expect(quals.map((q) => [q.blueprint_code, q.qualified, q.fresh_questions])).toEqual([
      ['CHALLENGE10', true, 10],
      ['CHALLENGE10', true, 10],
    ]);
    expect(await prisma.cp_event.count({ where: { session_id: { in: [a.assessmentId, b.assessmentId!] }, amount: { lt: 0 } } })).toBe(0);
  });

  it('social: a minor\'s friendship waits for the guardian; a report ends it and queues it; a restriction stops social use; the database refuses free text', async () => {
    await activeUnit();
    const alice = await adult();
    // Step 17: the guardian is real (approved through the guardian flow), not a stubbed lookup.
    const kid = await guardedMinor();
    const parent = { id: kid.guardianId };
    await prisma.student.update({ where: { id: kid.studentId }, data: { display_name: 'Kiran' } });
    {
      const { code } = await social.createCode(kid.accountId);
      const f = await social.redeem(alice.accountId, code);
      expect(f.status).toBe('PENDING_GUARDIAN');
      await expect(social.createChallenge(alice.accountId, { friendshipId: f.friendshipId, subjectVersionId: (await exam.listUnits(alice.accountId))[0].subjectVersionId })).rejects.toThrow(/active/);
      const [pending] = await social.guardianPending(parent.id);
      expect(pending).toMatchObject({ studentName: 'Kiran', otherHandle: expect.stringMatching(/^Learner-/) });
      expect(await social.guardianDecide(parent.id, pending.approvalId, true)).toEqual({ friendshipStatus: 'ACTIVE' });
      expect(await prisma.audit_event.count({ where: { action: 'social.friendship_approved_by_guardian', subject_id: kid.studentId } })).toBe(1);

      await social.report(alice.accountId, { friendshipId: f.friendshipId, reason: 'UNWANTED_CONTACT' });
      expect(await prisma.friendship.findUniqueOrThrow({ where: { id: f.friendshipId } })).toMatchObject({ status: 'ENDED', ended_reason: 'REPORTED' });
      const admin = await roleAccount('SUPER_ADMIN');
      await expect(social.reports(alice.accountId)).rejects.toThrow(/safety administrator/);
      const [report] = await social.reports(admin);
      expect(report).toMatchObject({ reason: 'UNWANTED_CONTACT', reported: { studentId: kid.studentId, openReports: 1 } });
      await social.resolve(admin, report.id, 'RESTRICTED');
      await expect(social.createCode(kid.accountId)).rejects.toThrow(/not available on your account/);

      // No free text: the database itself refuses a reason outside the list, and a friendship with oneself.
      await expect(prisma.safety_report.create({ data: { reporter_student_id: alice.studentId, reported_student_id: kid.studentId, reason: 'he said rude things', status: 'OPEN' } })).rejects.toThrow();
      await expect(prisma.friendship.create({ data: { student_low: alice.studentId, student_high: alice.studentId, status: 'ACTIVE' } })).rejects.toThrow();
    }
  });

  it('recommendations: chosen from mastery after a weak start, shown without numbers, and "not now" is respected', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();
    for (let i = 0; i < 2; i++) {
      const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
      await answerWith(accountId, assessmentId, () => false);
      await exam.submit(accountId, assessmentId);
    }
    await mastery.reconcile();
    expect(await prisma.student_mastery_state.findFirstOrThrow({ where: { student_id: studentId, objective_path: LO } })).toMatchObject({ label: 'NEEDS_ATTENTION', reportable: true });
    await recommendations.reconcile();
    const recs = await prisma.recommendation.findMany({ where: { student_id: studentId }, include: { reasons: true } });
    expect(recs).toEqual([expect.objectContaining({ kind: 'PRACTICE', source: 'MASTERY', status: 'OPEN', objective_paths: [LO] })]);
    expect(recs[0].reasons[0]).toMatchObject({ code: 'NEEDS_ATTENTION' });

    const home = await homes.home(accountId);
    expect(home.nextAction).toMatchObject({ kind: 'PRACTICE', recommendationId: recs[0].id });
    expect(home.focus).toEqual([expect.objectContaining({ id: recs[0].id, objectives: [{ path: LO, statement: 'Student can do X', chapterTitle: 'Chapter' }], reasons: [{ path: LO, code: 'NEEDS_ATTENTION' }] })]);
    expect(JSON.stringify(await recommendations.mine(accountId))).not.toMatch(/confidence|"mastery"/);

    expect(await recommendations.dismiss(accountId, recs[0].id)).toEqual({ dismissed: true });
    const { assessmentId } = await exam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    await answerWith(accountId, assessmentId, () => false);
    await exam.submit(accountId, assessmentId);
    await mastery.reconcile();
    await recommendations.reconcile();
    // Still Needs attention, but put off: nothing new for the quiet period.
    expect(await prisma.recommendation.count({ where: { student_id: studentId, status: { in: ['OPEN', 'STARTED'] } } })).toBe(0);
    expect((await homes.home(accountId)).nextAction.kind).toBe('TAKE_TEST');
  });

  // ---- Step 17: the parent claim gate and the parent's view ----

  const shareMail: string[] = [];
  const parents = new ParentService(dbService, privacyService, exam, outbox, { sendShareInvitation: async (_to: string, link: string) => { shareMail.push(link); } }, 'https://app.example.com');
  const WEEK = 7 * 86_400_000;

  it('parent: a guardian approved through the real flow sees the gated summary; the weekly report freezes; a correction adds a version; withdrawing ends access', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    await adult();
    const kid = await guardedMinor();
    const stranger = await prisma.account.create({ data: {} });

    // Before any test: building evidence, nothing claimed.
    expect(await parents.children(kid.guardianId)).toEqual([{ studentId: kid.studentId, label: expect.stringMatching(/^m\*\*\*@example\.com$/), basis: 'GUARDIAN' }]);
    const empty = await parents.dashboard(kid.guardianId, kid.studentId);
    expect(empty).toMatchObject({ basis: 'GUARDIAN', strengths: [], focus: [], improvements: [], activity: { tests: 0 } });

    await tookTest(kid.accountId, unitId, () => true);
    await tookTest(kid.accountId, unitId, () => true);
    await mastery.reconcile();
    expect(await prisma.student_mastery_state.findFirstOrThrow({ where: { student_id: kid.studentId } })).toMatchObject({ label: 'STRONG' });

    const v = await parents.dashboard(kid.guardianId, kid.studentId);
    expect(v.strengths.map((c) => c.text)).toEqual(['Shows strong understanding: Student can do X']);
    expect(v.subjects[0]).toMatchObject({ subjectName: 'Exam Subject', objectives: 1, reportable: 1, counts: { STRONG: 1 } });
    expect(v.activity).toMatchObject({ tests: 2, practice: 0, questionsAnswered: 20 });
    expect(JSON.stringify(v)).not.toMatch(/"mastery"|"confidence"|"correct"/);
    expect(await prisma.audit_event.count({ where: { action: 'parent.summary_viewed', subject_id: kid.studentId, actor_account_id: kid.guardianId } })).toBe(2);
    // The student sees exactly the same in "See what they see".
    expect((await parents.preview(kid.accountId)).strengths).toEqual(v.strengths);
    // Nobody else: 404, not 403.
    await expect(parents.dashboard(stranger.id, kid.studentId)).rejects.toThrow(/Not found/);

    // Next week: last week's report is frozen once, with the approved claim recorded.
    const nextWeek = new Date(Date.now() + WEEK);
    const [r1] = await parents.reconcile(nextWeek);
    expect(r1).toMatchObject({ studentId: kid.studentId, version: 1, reason: 'WEEK_ENDED' });
    expect(await parents.reconcile(nextWeek)).toEqual([]);
    expect(await prisma.report_claim.findMany({ select: { kind: true, label: true, template_code: true } })).toEqual([{ kind: 'STRENGTH', label: 'STRONG', template_code: 'STRENGTH_V1' }]);
    // A frozen version cannot be edited (database trigger).
    await expect(prisma.student_report_version.updateMany({ data: { reason: 'EVIDENCE_CHANGED' } })).rejects.toThrow(/frozen/);

    // A question the kid answered is invalidated: mastery recomputes, and the report gets version 2.
    const approver = await roleAccount('CURRICULUM_APPROVER');
    const target = (await prisma.assessment_instance_question.findFirstOrThrow({ where: { instance: { student_id: kid.studentId } } })).question_revision_id;
    await prisma.question_revision.update({ where: { id: target }, data: { state: 'QUARANTINED' } });
    await invalidations.invalidate(approver, target, { reasonCode: 'ANSWER_WRONG', note: 'The marked answer is wrong.' });
    await mastery.reconcile();
    const [r2] = await parents.reconcile(nextWeek);
    expect(r2).toMatchObject({ reportId: r1.reportId, version: 2, reason: 'EVIDENCE_CHANGED' });
    expect(await parents.report(kid.guardianId, kid.studentId, r1.reportId)).toMatchObject({ version: 2, reason: 'EVIDENCE_CHANGED' });
    expect(await prisma.student_report_version.count({ where: { report_id: r1.reportId } })).toBe(2);
    expect((await prisma.outbox_event.findMany({ where: { aggregate_id: kid.studentId, event_type: 'parent.report_generated.v1' } })).length).toBe(2);

    // The guardian withdraws their approval: the summary is gone at once.
    const [approval] = await guardianFlow.listApprovals(kid.guardianId);
    await guardianFlow.withdraw(kid.guardianId, approval.consentRecordId);
    await expect(parents.dashboard(kid.guardianId, kid.studentId)).rejects.toThrow(/Not found/);
    expect(await parents.children(kid.guardianId)).toEqual([]);
  });

  it('parent: an adult student shares with a parent under their own consent, and stopping ends access at once; the database keeps one open grant per pair', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ann = await adult();
    await privacyService.publishConsentWording({ purposeCode: 'PARENT_REPORT_SHARING', textReference: SHARING_DRAFT_WORDING_REFERENCE, description: 'Sharing a progress summary with a parent' });
    const mum = await prisma.account.create({ data: {} });
    await prisma.authentication_identity.create({ data: { account_id: mum.id, kind: 'EMAIL', identifier_normalized: 'ann-mum@example.com', verified_at: new Date() } });

    const status = await parents.sharing(ann.accountId);
    expect(status).toMatchObject({ canShare: true, isMinor: false, consent: { version: 1, draft: true } });
    await parents.invite(ann.accountId, { email: 'ann-mum@example.com', consentVersion: status.consent!.version, agreed: true });
    expect(await prisma.consent_record.findFirstOrThrow({ where: { student_id: ann.studentId, purpose: { code: 'PARENT_REPORT_SHARING' } } })).toMatchObject({ capacity: 'SELF', granted_by_account_id: ann.accountId });
    const token = shareMail[shareMail.length - 1].split('#t=')[1];
    expect(await prisma.parent_share_invitation.count({ where: { token_hash: { not: token } } })).toBe(1);
    await parents.acceptInvitation(mum.id, token);

    await tookTest(ann.accountId, unitId, () => true);
    expect((await parents.dashboard(mum.id, ann.studentId)).basis).toBe('STUDENT_SHARE');
    // A second open grant for the same pair is refused by the database itself.
    const grant = await prisma.parent_view_grant.findFirstOrThrow({ where: { student_id: ann.studentId } });
    await expect(prisma.parent_view_grant.create({ data: { student_id: ann.studentId, viewer_account_id: mum.id, invitation_id: ann.studentId, consent_record_id: mum.id } })).rejects.toThrow();

    await parents.stopSharing(ann.accountId, grant.id);
    expect(await prisma.consent_withdrawal.count({ where: { consent_record_id: grant.consent_record_id } })).toBe(1);
    await expect(parents.dashboard(mum.id, ann.studentId)).rejects.toThrow(/Not found/);
    expect(await prisma.audit_event.count({ where: { action: 'parent.sharing_ended', subject_id: ann.studentId } })).toBe(1);
  });

  // ---- Step 18: entitlements and subscription foundation ----

  const entitlements = new EntitlementService(dbService, authzService, privacyService, outbox);
  const limitedExam = new ExamService(dbService, privacyService, outbox, { allowUnactivatedCurriculum: false, resumeHours: 24 }, entitlements);

  it('entitlements: the seeded plans; FREE limits only self-chosen starts; the beta grant lifts them; history is append-only', async () => {
    expect(await prisma.plan.findMany({ orderBy: { code: 'asc' }, select: { code: true, is_default: true } })).toEqual([
      { code: 'BETA', is_default: false },
      { code: 'FREE', is_default: true },
      { code: 'PLUS', is_default: false },
    ]);
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const { accountId, studentId } = await adult();
    for (let i = 0; i < 3; i++) {
      const { assessmentId } = await limitedExam.create(accountId, { subjectVersionId: unitId, mode: i === 2 ? 'PRACTICE' : 'TEST' });
      await answerWith(accountId, assessmentId, () => true);
      await limitedExam.submit(accountId, assessmentId);
    }
    expect(await entitlements.mine(accountId)).toMatchObject({ planName: 'Free', startedToday: 3, leftToday: 0 });
    await expect(limitedExam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' })).rejects.toThrow(/started all the tests your plan includes today/);
    // A long test is refused on FREE whatever the count.
    await expect(entitlements.assertCanStart(prisma as any, studentId, 20)).rejects.toThrow(/Longer tests/);

    // The private beta: every student gets BETA to the date, and the limits are gone.
    const until = new Date(Date.now() + 30 * 86_400_000);
    expect(await entitlements.reconcile(until)).toMatchObject({ granted: 1 });
    expect(await entitlements.reconcile(until)).toMatchObject({ granted: 0 });
    expect((await entitlements.mine(accountId)).planName).toBe('Beta');
    const { assessmentId } = await limitedExam.create(accountId, { subjectVersionId: unitId, mode: 'TEST' });
    expect(assessmentId).toBeTruthy();
    // The database keeps one active beta per student, and a beta grant has no holder.
    const beta = await prisma.plan.findUniqueOrThrow({ where: { code: 'BETA' } });
    await expect(prisma.subscription.create({ data: { student_id: studentId, plan_id: beta.id, source: 'BETA', status: 'ACTIVE', starts_at: new Date(), ends_at: until } })).rejects.toThrow();
    // The history cannot be edited.
    await expect(prisma.subscription_event.updateMany({ data: { type: 'ENDED' } })).rejects.toThrow(/append-only/);
  });

  it('entitlements: an administrator grants a plan held by the adult student, and ends it; others may not; a minor cannot hold one', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ann = await adult();
    await prisma.authentication_identity.create({ data: { account_id: ann.accountId, kind: 'EMAIL', identifier_normalized: 'ann-step18@example.com', verified_at: new Date() } });
    const kid = await guardedMinor('step18-mum@example.com');
    const admin = await roleAccount('SUPER_ADMIN');

    await expect(entitlements.grantPlan(ann.accountId, { studentId: ann.studentId, planCode: 'PLUS', reason: 'Comp for a bug' })).rejects.toThrow(/administrator/);
    expect(await entitlements.lookup(admin, 'ANN-step18@example.com')).toEqual({ studentId: ann.studentId });
    const { subscriptionId } = await entitlements.grantPlan(admin, { studentId: ann.studentId, planCode: 'PLUS', holderEmail: 'ann-step18@example.com', reason: 'Comp for a bug', endsAt: new Date(Date.now() + 86_400_000).toISOString() });
    expect((await entitlements.mine(ann.accountId)).values).toMatchObject({ SELF_TESTS_PER_DAY: null, LONG_TESTS: true });
    // The guardian may hold the minor's plan; the minor may not hold one.
    const kidEmail = (await prisma.authentication_identity.findFirstOrThrow({ where: { account_id: kid.accountId } })).identifier_normalized;
    await expect(entitlements.grantPlan(admin, { studentId: kid.studentId, planCode: 'PLUS', holderEmail: kidEmail, reason: 'Comp for a bug' })).rejects.toThrow(/minor cannot hold/);
    await entitlements.grantPlan(admin, { studentId: kid.studentId, planCode: 'PLUS', holderEmail: 'step18-mum@example.com', reason: 'Comp for a bug' });
    // Holding a plan gives the holder no access: the guardian's access is their approval, nothing more.
    expect(await parents.children(kid.guardianId)).toHaveLength(1);

    await entitlements.endSubscription(admin, subscriptionId, 'Refund requested');
    expect((await entitlements.mine(ann.accountId)).values).toMatchObject({ SELF_TESTS_PER_DAY: 3, LONG_TESTS: false });
    expect((await prisma.subscription_event.findMany({ where: { subscription_id: subscriptionId }, orderBy: { at: 'asc' } })).map((e: { type: string }) => e.type)).toEqual(['CREATED', 'ENDED']);
    expect(await prisma.audit_event.count({ where: { action: { in: ['entitlement.plan_granted', 'entitlement.plan_ended'] } } })).toBe(3);
  });

  // ---- Step 19: analytics (pseudonymous, consented) and experiments ----

  const analytics = new AnalyticsService(dbService, privacyService, authzService);
  const SOON = () => new Date(Date.now() + 20_000);

  it('analytics: nothing is kept without consent; with an adult\'s consent the outbox becomes pseudonymous events; withdrawing deletes them', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ann = await adult();
    await privacyService.publishConsentWording({ purposeCode: 'PRODUCT_ANALYTICS', textReference: ANALYTICS_DRAFT_WORDING_REFERENCE, description: 'Product statistics' });

    // Before consenting: a test is taken and projected, and nothing is kept.
    await tookTest(ann.accountId, unitId, () => true);
    await analytics.projectOutbox(SOON());
    expect(await prisma.analytics_event.count()).toBe(0);

    const c = await analytics.myConsent(ann.accountId);
    expect(c).toMatchObject({ decidedBy: 'SELF', granted: false, consent: { version: 1, draft: true } });
    await analytics.setMyConsent(ann.accountId, { granted: true, consentVersion: c.consent!.version });
    await tookTest(ann.accountId, unitId, () => true);
    await mastery.reconcile();
    await competition.reconcile();
    await analytics.recordClient(ann.accountId, 'RESULTS_OPENED');
    await analytics.projectOutbox(SOON());
    const rows = await prisma.analytics_event.findMany({ orderBy: { occurred_at: 'asc' } });
    const key = subjectKey(ann.studentId, 'development-only-analytics-pseudonym-key-000');
    expect(new Set(rows.map((r: { subject_key: string }) => r.subject_key))).toEqual(new Set([key]));
    expect(rows.map((r: { name: string }) => r.name)).toEqual(expect.arrayContaining(['SIGNED_UP', 'ASSESSMENT_STARTED', 'ASSESSMENT_COMPLETED', 'MASTERY_UPDATED', 'QUALIFIED_TEST', 'RESULTS_OPENED']));
    // Only events after consent: one test started, not two.
    expect(rows.filter((r: { name: string }) => r.name === 'ASSESSMENT_STARTED')).toHaveLength(1);
    // Nothing identifying: no ids, no scores.
    expect(JSON.stringify(rows)).not.toContain(ann.studentId);
    // Nor any outbox event id (an outbox row names the student): de-duplication keys are keyed hashes.
    const outboxIds = (await prisma.outbox_event.findMany({ select: { id: true } })).map((o: { id: string }) => o.id);
    expect(outboxIds.some((id: string) => JSON.stringify(rows).includes(id))).toBe(false);
    expect(JSON.stringify(rows)).not.toMatch(/"correct"|"total"|"amount"/);
    // Running again records nothing twice.
    const before = await prisma.analytics_event.count();
    await analytics.projectOutbox(SOON());
    expect(await prisma.analytics_event.count()).toBe(before);
    // The database refuses an event that is not on the list, and a raw id as the subject.
    await expect(prisma.analytics_event.create({ data: { subject_key: key, name: 'PAGE_VIEW', source: 'CLIENT', occurred_at: new Date() } })).rejects.toThrow();
    await expect(prisma.analytics_event.create({ data: { subject_key: ann.studentId, name: 'QUALIFIED_TEST', source: 'SERVER', occurred_at: new Date() } })).rejects.toThrow();

    // The administrator sees totals only (one learner: hidden as "<5").
    const admin = await roleAccount('SUPER_ADMIN');
    const m = await analytics.metrics(admin);
    expect(m.weeks[m.weeks.length - 1].northStar).toBe('<5');
    await expect(analytics.metrics(ann.accountId)).rejects.toThrow(/administrator/);

    // Turning it off deletes everything kept about the student.
    await analytics.setMyConsent(ann.accountId, { granted: false, consentVersion: 1 });
    expect(await prisma.analytics_event.count()).toBe(0);
    expect(await prisma.consent_withdrawal.count()).toBeGreaterThan(0);
  });

  it("analytics: a minor's guardian decides; the minor cannot; experiments give consenting students a stable variant", async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    await adult();
    const kid = await guardedMinor('step19-mum@example.com');
    await privacyService.publishConsentWording({ purposeCode: 'PRODUCT_ANALYTICS', textReference: ANALYTICS_DRAFT_WORDING_REFERENCE, description: 'Product statistics' });
    await expect(analytics.setMyConsent(kid.accountId, { granted: true, consentVersion: 1 })).rejects.toThrow(/parent or guardian decides/);
    const g = await analytics.guardianConsents(kid.guardianId);
    expect(g.children).toEqual([expect.objectContaining({ studentId: kid.studentId, granted: false })]);
    await analytics.setGuardianConsent(kid.guardianId, kid.studentId, { granted: true, consentVersion: 1 });
    expect(await prisma.consent_record.findFirstOrThrow({ where: { student_id: kid.studentId, purpose: { code: 'PRODUCT_ANALYTICS' } } })).toMatchObject({ capacity: 'GUARDIAN', granted_by_account_id: kid.guardianId });
    expect(await analytics.consents(kid.studentId)).toBe(true);

    const admin = await roleAccount('SUPER_ADMIN');
    const { id } = await analytics.createExperiment(admin, { key: 'home_cards', description: 'Cards on Home instead of a list', variants: [{ key: 'control', weight: 1, isControl: true }, { key: 'cards', weight: 1 }] });
    await analytics.setExperimentStatus(admin, id, 'RUNNING');
    const v = await analytics.variantFor(kid.studentId, 'home_cards');
    expect(await analytics.variantFor(kid.studentId, 'home_cards')).toBe(v);
    expect(await prisma.experiment_assignment.count()).toBe(1);
    // Withdrawing (by the guardian) deletes the assignment too.
    await analytics.setGuardianConsent(kid.guardianId, kid.studentId, { granted: false, consentVersion: 1 });
    expect(await prisma.experiment_assignment.count()).toBe(0);
  });

  // ---- Step 20: data rights (export, erasure), the administrators' authenticator, retention ----

  const rights = new RightsService(dbService, privacyService, analytics, outbox);
  const DAY = 86_400_000;

  it('rights: an adult downloads a copy; erasure waits 14 days, then deletes personal data, unlinks the rest, and can be reapplied after a restore', async () => {
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ann = await adult();
    await prisma.student.update({ where: { id: ann.studentId }, data: { display_name: 'Ann' } });
    await prisma.authentication_identity.create({ data: { account_id: ann.accountId, kind: 'EMAIL', identifier_normalized: 'ann-step20@example.com', verified_at: new Date() } });
    await prisma.auth_session.create({ data: { account_id: ann.accountId, token_hash: 'step20-session-hash', expires_at: new Date(Date.now() + DAY) } });
    await privacyService.publishConsentWording({ purposeCode: 'PRODUCT_ANALYTICS', textReference: ANALYTICS_DRAFT_WORDING_REFERENCE, description: 'Product statistics' });
    await analytics.setMyConsent(ann.accountId, { granted: true, consentVersion: 1 });
    await tookTest(ann.accountId, unitId, () => true);
    await mastery.reconcile();
    await competition.reconcile();
    await analytics.recordClient(ann.accountId, 'RESULTS_OPENED');
    await competition.view(ann.accountId);

    // The copy: the student's own rows, no secrets.
    const copy: any = await rights.exportFor(ann.accountId, null);
    expect(copy).toMatchObject({ about: 'STUDENT', student: { id: ann.studentId, display_name: 'Ann' }, counts: { analyticsEvents: 1 } });
    expect(copy.tables.assessment_result).toHaveLength(1);
    expect(copy.tables.student_response.length).toBeGreaterThan(0);
    expect(copy.tables.public_profile).toHaveLength(1);
    expect(JSON.stringify(copy)).not.toMatch(/step20-session-hash|token_hash|code_hash|idempotency_key/);
    expect(await prisma.audit_event.count({ where: { action: 'privacy.export.downloaded', actor_account_id: ann.accountId } })).toBe(1);

    // Erasure: one open request per subject (the database keeps it so), nothing happens before the 14 days.
    const now = new Date();
    const { requestId, dueAt } = await rights.requestErasure(ann.accountId, null, now);
    expect(new Date(dueAt).getTime() - now.getTime()).toBe(14 * DAY);
    await expect(prisma.privacy_request.create({ data: { kind: 'ERASURE', subject_type: 'STUDENT', subject_id: ann.studentId, requested_by_account_id: ann.accountId, capacity: 'SELF', status: 'PENDING', due_at: now } })).rejects.toThrow();
    expect(await rights.runDue(new Date(now.getTime() + 13 * DAY))).toEqual({ completed: 0, failed: 0 });
    const at = new Date(now.getTime() + 14 * DAY);
    expect(await rights.runDue(at)).toEqual({ completed: 1, failed: 0 });

    // Personal data is gone.
    expect(await prisma.authentication_identity.count({ where: { account_id: ann.accountId } })).toBe(0);
    expect(await prisma.auth_session.count({ where: { account_id: ann.accountId } })).toBe(0);
    expect(await prisma.age_classification.count({ where: { student_id: ann.studentId } })).toBe(0);
    expect(await prisma.public_profile.count({ where: { student_id: ann.studentId } })).toBe(0);
    expect(await prisma.account_student_access.count({ where: { student_id: ann.studentId } })).toBe(0);
    expect(await prisma.analytics_event.count()).toBe(0);
    expect(await prisma.student.findUniqueOrThrow({ where: { id: ann.studentId } })).toMatchObject({ display_name: null, erased_at: at });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: ann.accountId } })).toMatchObject({ status: 'CLOSED', erased_at: at });
    // Learning records stay, under an id that leads to no one; consents stay as evidence, withdrawn.
    expect(await prisma.assessment_result.count({ where: { student_id: ann.studentId } })).toBe(1);
    expect(await prisma.cp_event.count({ where: { student_id: ann.studentId } })).toBeGreaterThan(0);
    const consents = await prisma.consent_record.findMany({ where: { student_id: ann.studentId }, include: { withdrawal: true } });
    expect(consents.length).toBeGreaterThan(0);
    expect(consents.every((c: any) => c.withdrawal !== null)).toBe(true);
    expect(await prisma.consent_withdrawal.count({ where: { reason_code: 'ERASURE' } })).toBeGreaterThan(0);
    expect(await prisma.privacy_request.findUniqueOrThrow({ where: { id: requestId } })).toMatchObject({ status: 'COMPLETED' });
    expect(await prisma.deletion_tombstone.findMany()).toEqual([expect.objectContaining({ subject_type: 'STUDENT', subject_id: ann.studentId, account_ids: [ann.accountId] })]);
    // The weekly parent summary is never made again for the erased student (it would be due a week later).
    expect(await parents.reconcile(new Date(Date.now() + 7 * DAY))).toEqual([]);
    expect(await prisma.student_report.count()).toBe(0);
    // Nor are they on this week's boards: their public handle and age are gone, so they are never shown.
    const bea = await adult();
    const boards = await competition.view(bea.accountId);
    expect(JSON.stringify(boards)).not.toContain(copy.tables.public_profile[0].handle);
    // The database refuses an erased account that is not closed.
    await expect(prisma.account.update({ where: { id: ann.accountId }, data: { status: 'ACTIVE' } })).rejects.toThrow();
    // The same email can sign up again as a new person.
    await identityService.requestOtp('EMAIL', 'ann-step20@example.com');
    const login = await identityService.verifyOtp('EMAIL', 'ann-step20@example.com', capturedCodes[capturedCodes.length - 1].code);
    expect(login).toMatchObject({ isNewAccount: true });
    expect(login.accountId).not.toBe(ann.accountId);

    // A restore brings the old rows back: the exported tombstones erase them again.
    const tombs = await rights.tombstones();
    await prisma.authentication_identity.create({ data: { account_id: ann.accountId, kind: 'PHONE', identifier_normalized: '+919800000020', verified_at: new Date() } });
    await prisma.account_student_access.create({ data: { account_id: ann.accountId, student_id: ann.studentId, access_kind: 'SELF' } });
    await prisma.student.update({ where: { id: ann.studentId }, data: { display_name: 'Ann', erased_at: null } });
    expect(await rights.reapply(tombs)).toEqual({ applied: 1, skipped: 0 });
    expect(await prisma.authentication_identity.count({ where: { account_id: ann.accountId } })).toBe(0);
    expect((await prisma.student.findUniqueOrThrow({ where: { id: ann.studentId } })).display_name).toBeNull();
  });

  it("rights: a guardian downloads and erases a minor's data; the guardian link ends; the guardian's account stays", async () => {
    const kid = await guardedMinor('step20-mum@example.com');
    const copy: any = await rights.exportFor(kid.guardianId, kid.studentId);
    expect(copy).toMatchObject({ about: 'STUDENT', student: { id: kid.studentId } });
    await expect(rights.requestErasure(kid.accountId, null)).rejects.toThrow(/parent or guardian/);
    await expect(rights.requestErasure(kid.guardianId, null)).rejects.toThrow(/approve a child/);
    const now = new Date();
    await rights.requestErasure(kid.guardianId, kid.studentId, now);
    expect(await rights.runDue(new Date(now.getTime() + 14 * DAY))).toEqual({ completed: 1, failed: 0 });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: kid.accountId } })).toMatchObject({ status: 'CLOSED' });
    expect(await prisma.account.findUniqueOrThrow({ where: { id: kid.guardianId } })).toMatchObject({ status: 'ACTIVE' });
    expect(await prisma.guardian_relationship.findFirstOrThrow({ where: { student_id: kid.studentId } })).toMatchObject({ status: 'REVOKED' });
    expect(await prisma.guardian_authority.count({ where: { revoked_at: null } })).toBe(0);
    expect(await prisma.guardian_invitation.count({ where: { student_id: kid.studentId } })).toBe(0);
    expect(await privacyService.listGuardianApprovals(kid.guardianId)).toEqual([]);
    // Now the guardian approves no one, so they may delete their own account.
    await expect(rights.requestErasure(kid.guardianId, null)).resolves.toMatchObject({ requestId: expect.any(String) });
  });

  it('mfa: an administrator sets up an authenticator; the secret is encrypted; a code works once; the check is per session', async () => {
    const admin = await roleAccount('SUPER_ADMIN');
    const s1 = await prisma.auth_session.create({ data: { account_id: admin, token_hash: 'mfa-s1', expires_at: new Date(Date.now() + DAY) } });
    const s2 = await prisma.auth_session.create({ data: { account_id: admin, token_hash: 'mfa-s2', expires_at: new Date(Date.now() + DAY) } });
    const mfa = new MfaService(dbService);
    expect(await mfa.check(admin, s1.id)).toBe('MFA_REQUIRED');
    const now = new Date();
    const { secret } = await mfa.startEnrolment(admin, now);
    expect((await prisma.admin_mfa_factor.findUniqueOrThrow({ where: { account_id: admin } })).secret_ciphertext).not.toContain(secret);
    const { recoveryCodes } = await mfa.confirmEnrolment(admin, s1.id, hotp(secret, stepAt(now)), now);
    expect(await prisma.admin_mfa_recovery_code.count()).toBe(10);
    expect(await mfa.check(admin, s1.id, now)).toBe('OK');
    expect(await mfa.check(admin, s2.id, now)).toBe('MFA_REQUIRED');
    const later = new Date(now.getTime() + 30_000);
    const code = hotp(secret, stepAt(later));
    await mfa.verify(admin, s2.id, { code }, later);
    await expect(mfa.verify(admin, s2.id, { code }, later)).rejects.toThrow(/did not work/);
    await mfa.verify(admin, s2.id, { recoveryCode: recoveryCodes[0] }, later);
    await expect(mfa.verify(admin, s2.id, { recoveryCode: recoveryCodes[0] }, later)).rejects.toThrow(/did not work/);
    // The database refuses an active authenticator with no confirmation time.
    await expect(prisma.admin_mfa_factor.update({ where: { account_id: admin }, data: { activated_at: null } })).rejects.toThrow();
    expect(await prisma.audit_event.count({ where: { action: 'mfa.verify_failed', actor_account_id: admin } })).toBe(2);
  });

  it('retention: deletes expired sign-in codes and old sessions, flags inactive accounts, and records the run', async () => {
    const old = new Date(Date.now() - 100 * DAY);
    const acct = await prisma.account.create({ data: { created_at: new Date(Date.now() - 800 * DAY) } });
    await prisma.otp_challenge.create({ data: { kind: 'EMAIL', identifier_normalized: 'old@example.com', code_hash: 'x', expires_at: old } });
    await prisma.otp_challenge.create({ data: { kind: 'EMAIL', identifier_normalized: 'new@example.com', code_hash: 'y', expires_at: new Date() } });
    await prisma.auth_session.create({ data: { account_id: acct.id, token_hash: 'ret-old', expires_at: old } });
    const counts = await new RetentionService(dbService).run(new Date());
    expect(counts).toMatchObject({ otpChallenges: 1, sessions: 1, inactiveFlagged: 1 });
    expect(await prisma.otp_challenge.count()).toBe(1);
    expect((await prisma.account.findUniqueOrThrow({ where: { id: acct.id } })).inactive_flagged_at).not.toBeNull();
    expect(await prisma.retention_run.findFirstOrThrow()).toMatchObject({ ok: true, counts });
  });

  // ---- Step 21: content readiness and release tiers ----

  const release = new ReleaseService(dbService, authzService);
  const readiness = new ReadinessService(dbService, authzService, release, outbox);
  const gatedExam = new ExamService(dbService, privacyService, outbox, { allowUnactivatedCurriculum: false, resumeHours: 24 }, undefined, release);
  const LENIENT = {
    objective: { limited: 1, assessmentReady: 2, robust: 3 },
    tiers: Object.fromEntries(['INTERNAL', 'CONTROLLED', 'GENERAL'].map((t) => [t, { objectivesLimitedShare: 1, objectivesReadyShare: 0, objectivesRobustShare: 0, chapterMin: 1, chapterMinPerDifficulty: 1, chapterMinCognitive: 0, maxQualityIssueShare: 1, designDepth: 1 }])),
  };
  async function withEmail(accountId: string, email: string) {
    await prisma.authentication_identity.create({ data: { account_id: accountId, kind: 'EMAIL', identifier_normalized: email, verified_at: new Date() } });
  }

  it('readiness: the seeded policy is provisional; a thin bank is ready for nothing, students are not offered it, and it cannot be released', async () => {
    expect(await prisma.readiness_policy_version.findMany({ select: { code: true, status: true, signed_off_at: true } })).toEqual([{ code: 'READINESS_V1', status: 'ACTIVE', signed_off_at: null }]);
    const unitId = await activeUnit();
    await bank(unitId, 12);
    const ann = await adult();
    // Without a release, the subject is Coming soon for the student, and a test cannot be started on it.
    expect(await gatedExam.listUnits(ann.accountId)).toEqual([]);
    await expect(gatedExam.create(ann.accountId, { subjectVersionId: unitId, mode: 'TEST' })).rejects.toThrow(/not open for tests yet/);

    const editor = await roleAccount('CURRICULUM_EDITOR');
    const r = await readiness.generate(editor, unitId);
    expect(r).toMatchObject({ highest: 'FOUNDATION_ONLY', policy: { code: 'READINESS_V1', signedOff: false } });
    expect(r.result.totals).toMatchObject({ servable: 12, distinct: 12, objectives: expect.any(Number) });
    const failing = r.result.tiers.INTERNAL.checks.filter((c) => !c.ok).map((c) => c.code);
    expect(failing).toEqual(expect.arrayContaining(['CHAPTER_COGNITIVE', 'DESIGN_QUICK10']));
    expect(await prisma.readiness_report.findUniqueOrThrow({ where: { id: r.id } })).toMatchObject({ highest_tier: 'FOUNDATION_ONLY', subject_version_id: unitId });

    const approver = await roleAccount('CURRICULUM_APPROVER');
    await expect(readiness.changeTier(editor, unitId, { to: 'INTERNAL', reportId: r.id, note: 'Checked by the academic lead' })).rejects.toThrow(/Only an approver/);
    await expect(readiness.changeTier(approver, unitId, { to: 'INTERNAL', reportId: r.id, note: 'Checked by the academic lead' })).rejects.toThrow(/does not pass the INTERNAL checks/);
    // The database keeps one active policy, and a fixed list of tiers.
    await expect(prisma.readiness_policy_version.create({ data: { code: 'SECOND', status: 'ACTIVE', params: LENIENT } })).rejects.toThrow();
    await expect(prisma.subject_release.create({ data: { curriculum_version_id: ann.studentId, grade_id: ann.studentId, subject_id: ann.studentId, tier: 'EVERYONE', changed_at: new Date(), changed_by_account_id: approver } })).rejects.toThrow();
  });

  it('readiness: released to INTERNAL, only internal testers see the subject; CONTROLLED needs a signed-off policy; taking it back hides it again', async () => {
    const unitId = await activeUnit();
    // 15 questions = 5 of each difficulty: enough for Quick 10's and Focus 10's 5/3/2 mix once (the lenient design depth).
    await bank(unitId, 15);
    const approver = await roleAccount('CURRICULUM_APPROVER');
    const admin = await roleAccount('SUPER_ADMIN');
    await withEmail(approver, 'lead-step21@example.com');
    const ann = await adult();
    await withEmail(ann.accountId, 'ann-step21@example.com');
    const bob = await adult();
    await withEmail(bob.accountId, 'bob-step21@example.com');

    await readiness.publishPolicy({ code: 'IT_LENIENT', params: LENIENT, notes: 'Integration test', operator: 'test' });
    const r1 = await readiness.generate(approver, unitId);
    expect(r1.highest).toBe('GENERAL');
    await readiness.changeTier(approver, unitId, { to: 'INTERNAL', reportId: r1.id, note: 'Alpha bank checked by the subject lead' });

    // Internal access sees it and can start a test; nobody else does.
    expect(await gatedExam.listUnits(ann.accountId)).toEqual([]);
    await release.grantAccess(admin, { email: 'ann-step21@example.com', tier: 'INTERNAL', reason: 'Alpha tester' });
    expect((await gatedExam.listUnits(ann.accountId)).map((u) => u.subjectVersionId)).toEqual([unitId]);
    const { assessmentId } = await gatedExam.create(ann.accountId, { subjectVersionId: unitId, mode: 'TEST' });
    expect(assessmentId).toBeTruthy();
    expect(await gatedExam.listUnits(bob.accountId)).toEqual([]);
    // One live audience per account (the database keeps it so).
    await expect(prisma.release_access.create({ data: { account_id: ann.accountId, tier: 'CONTROLLED', reason: 'Second grant' } })).rejects.toThrow();

    // CONTROLLED needs the policy signed off by an academic lead.
    await expect(readiness.changeTier(approver, unitId, { to: 'CONTROLLED', reportId: r1.id, note: 'Beta bank checked by the subject lead' })).rejects.toThrow(/signed off by an academic lead/);
    await readiness.signOff({ code: 'IT_LENIENT', approverName: 'Dr Test Lead', reference: 'Integration memo', operator: 'test' });
    const r2 = await readiness.generate(approver, unitId);
    await readiness.changeTier(approver, unitId, { to: 'CONTROLLED', reportId: r2.id, note: 'Beta bank checked by the subject lead' });
    expect(await gatedExam.listUnits(bob.accountId)).toEqual([]);
    await release.grantAccess(admin, { email: 'bob-step21@example.com', tier: 'CONTROLLED', reason: 'Beta wave 1' });
    expect(await gatedExam.listUnits(bob.accountId)).toHaveLength(1);

    // Taking it back needs no report and hides it at once.
    await readiness.changeTier(approver, unitId, { to: 'FOUNDATION_ONLY', note: 'A wrong answer key was found in chapter 1' });
    expect(await gatedExam.listUnits(ann.accountId)).toEqual([]);
    expect(await gatedExam.listUnits(bob.accountId)).toEqual([]);
    const history = await readiness.history(approver, unitId);
    expect(history.map((h) => `${h.from}>${h.to}`)).toEqual(['CONTROLLED>FOUNDATION_ONLY', 'INTERNAL>CONTROLLED', 'FOUNDATION_ONLY>INTERNAL']);
    expect(history[2]).toMatchObject({ approver: 'lead-step21@example.com', reportId: r1.id });
    // The history cannot be edited.
    await expect(prisma.subject_release_event.updateMany({ data: { note: 'Rewritten history entry' } })).rejects.toThrow(/append-only/);
    expect(await prisma.audit_event.count({ where: { action: { in: ['release.promoted', 'release.demoted'] } } })).toBe(3);
  });
});


/* ===================================================================== */
/*  Guardian approval                                                     */
/* ===================================================================== */

describe('GuardianService (real DB)', () => {
  const sentMail: { to: string; link: string }[] = [];
  const mailer = { sendInvitation: async (to: string, link: string) => { sentMail.push({ to, link }); } };
  const guardian = new GuardianService(dbService, privacyService, outbox, mailer, 'https://app.example.com');
  const GUARDIAN_EMAIL = 'parent@example.com';
  const tokenOfLast = () => sentMail[sentMail.length - 1].link.split('#t=')[1];

  async function policy(methods: string[] = ['EMAIL_LINK_ATTESTATION']) {
    const { id } = await privacyService.createJurisdictionPolicyDraft(
      { jurisdictionCode: DEFAULT_JURISDICTION, config: { minorAgeThreshold: 18, guardianConsentAgeThreshold: 18, acceptedDobEvidenceMethods: ['SELF_DECLARED'], acceptedGuardianVerificationMethods: methods } },
      null,
    );
    await privacyService.markPolicyCounselReviewed(id, 'LEGAL-OPINION-001', null);
    await privacyService.activateJurisdictionPolicy(id, null);
  }
  async function wording() {
    await privacyService.publishConsentWording({ purposeCode: 'CORE_SERVICE', textReference: DEV_DRAFT_WORDING_REFERENCE, description: 'Core service' });
  }
  async function minor() {
    const account = await prisma.account.create({ data: {} });
    const student = await prisma.student.create({ data: {} });
    await prisma.account_student_access.create({ data: { account_id: account.id, student_id: student.id, access_kind: 'SELF' } });
    await privacyService.recordAgeClassification({ studentId: student.id, dateOfBirth: new Date('2013-05-01'), jurisdictionCode: DEFAULT_JURISDICTION, dobEvidenceMethod: 'SELF_DECLARED', actorAccountId: account.id });
    return { accountId: account.id, studentId: student.id };
  }
  async function guardianAccount(email = GUARDIAN_EMAIL) {
    const account = await prisma.account.create({ data: {} });
    await prisma.authentication_identity.create({ data: { account_id: account.id, kind: 'EMAIL', identifier_normalized: email, verified_at: new Date() } });
    return account.id;
  }
  const ask = (accountId: string) => guardian.createInvitation(accountId, { email: GUARDIAN_EMAIL, relationshipType: 'MOTHER' });

  beforeEach(() => { sentMail.length = 0; });

  it('full flow: request, approve, student is cleared; withdraw puts the block back', async () => {
    await policy();
    await wording();
    const s = await minor();
    expect((await privacyService.getClassificationSummary(s.studentId)).consentSatisfied).toBe(false);

    await ask(s.accountId);
    expect(sentMail).toHaveLength(1);
    const g = await guardianAccount();
    const preview = await guardian.preview(g, tokenOfLast());
    await guardian.accept(g, { token: tokenOfLast(), consentVersion: preview.consent.version, attested: true });

    expect((await privacyService.getClassificationSummary(s.studentId)).consentSatisfied).toBe(true);
    expect(await prisma.guardian_verification.count({ where: { status: 'VERIFIED', method: 'EMAIL_LINK_ATTESTATION' } })).toBe(1);
    expect((await guardian.status(s.accountId)).approved).toBe(true);

    const [approval] = await guardian.listApprovals(g);
    await guardian.withdraw(g, approval.consentRecordId);
    expect((await privacyService.getClassificationSummary(s.studentId)).consentSatisfied).toBe(false);
  });

  it('only the token hash is stored', async () => {
    await policy(); await wording();
    const s = await minor();
    await ask(s.accountId);
    const rows = await prisma.guardian_invitation.findMany();
    expect(JSON.stringify(rows)).not.toContain(tokenOfLast());
  });

  it('refuses, and writes nothing, when the active policy does not accept the method', async () => {
    await policy(['DOCUMENT_UPLOAD']); await wording();
    const s = await minor();
    await ask(s.accountId);
    const g = await guardianAccount();
    const v = (await guardian.preview(g, tokenOfLast())).consent.version;
    await expect(guardian.accept(g, { token: tokenOfLast(), consentVersion: v, attested: true })).rejects.toBeInstanceOf(GuardianUnavailableError);
    expect((await prisma.guardian_invitation.findFirstOrThrow()).status).toBe('PENDING');
    expect(await prisma.guardian_relationship.count()).toBe(0);
    expect(await prisma.consent_record.count()).toBe(0);
  });

  it('refuses when no consent wording has been published', async () => {
    await policy();
    const s = await minor();
    await ask(s.accountId);
    const g = await guardianAccount();
    await expect(guardian.preview(g, tokenOfLast())).rejects.toBeInstanceOf(GuardianUnavailableError);
  });

  it('an account that does not control the invited address cannot see or accept it', async () => {
    await policy(); await wording();
    const s = await minor();
    await ask(s.accountId);
    const stranger = await guardianAccount('someone-else@example.com');
    await expect(guardian.preview(stranger, tokenOfLast())).rejects.toBeInstanceOf(GuardianNotPermittedError);
    await expect(guardian.accept(stranger, { token: tokenOfLast(), consentVersion: 1, attested: true })).rejects.toBeInstanceOf(GuardianNotPermittedError);
    expect(await prisma.consent_record.count()).toBe(0);
  });

  it('two simultaneous accepts produce exactly one approval', async () => {
    await policy(); await wording();
    const s = await minor();
    await ask(s.accountId);
    const g = await guardianAccount();
    const v = (await guardian.preview(g, tokenOfLast())).consent.version;
    const results = await Promise.allSettled([
      guardian.accept(g, { token: tokenOfLast(), consentVersion: v, attested: true }),
      guardian.accept(g, { token: tokenOfLast(), consentVersion: v, attested: true }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(GuardianConflictError);
    expect(await prisma.consent_record.count()).toBe(1);
    expect(await prisma.guardian_authority.count()).toBe(1);
  });

  it('a student never has more than one pending request, even when two are sent at once', async () => {
    await policy(); await wording();
    const s = await minor();
    await Promise.allSettled([ask(s.accountId), ask(s.accountId)]);
    expect(await prisma.guardian_invitation.count({ where: { status: 'PENDING' } })).toBeLessThanOrEqual(1);
  });

  it('the daily limit holds across resends', async () => {
    await policy(); await wording();
    const s = await minor();
    await ask(s.accountId);
    // push the earlier ones back past the cooldown so only the daily limit can stop us
    const back = async () => prisma.guardian_invitation.updateMany({ data: { created_at: new Date(Date.now() - 5 * 60_000) } });
    await back(); await ask(s.accountId);
    await back(); await ask(s.accountId);
    await back();
    await expect(ask(s.accountId)).rejects.toThrow(/limit|can't receive/);
  });

  it('a request that has expired cannot be used', async () => {
    await policy(); await wording();
    const s = await minor();
    await ask(s.accountId);
    await prisma.guardian_invitation.updateMany({ data: { expires_at: new Date(Date.now() - 1000) } });
    const g = await guardianAccount();
    await expect(guardian.preview(g, tokenOfLast())).rejects.toThrow(/expired/);
  });

  it('declining approves nothing', async () => {
    await policy(); await wording();
    const s = await minor();
    await ask(s.accountId);
    const g = await guardianAccount();
    await guardian.decline(g, tokenOfLast());
    expect((await privacyService.getClassificationSummary(s.studentId)).consentSatisfied).toBe(false);
    expect(await prisma.consent_record.count()).toBe(0);
  });

  it('the exam gate opens only after approval', async () => {
    await policy(); await wording();
    const s = await minor();
    const exam = new ExamService(dbService, privacyService, outbox, { allowUnactivatedCurriculum: false, resumeHours: 24 });
    await expect(exam.listUnits(s.accountId)).rejects.toBeInstanceOf(ExamNotPermittedError);
    await ask(s.accountId);
    const g = await guardianAccount();
    const v = (await guardian.preview(g, tokenOfLast())).consent.version;
    await guardian.accept(g, { token: tokenOfLast(), consentVersion: v, attested: true });
    await expect(exam.listUnits(s.accountId)).resolves.toBeDefined();
  });
});


/* ===================================================================== */
/*  School registry tables (constraints the migration must carry)         */
/* ===================================================================== */

describe('School association constraints (real DB)', () => {
  async function student() {
    return prisma.student.create({ data: {} });
  }

  it('allows only one open school association per student', async () => {
    const st = await student();
    const school = await prisma.school.create({ data: { name: 'Example School', country_code: 'AE', city: 'Dubai' } });
    await prisma.student_school_association.create({ data: { student_id: st.id, school_id: school.id, state: 'STUDENT_SELECTED' } });
    await expect(
      prisma.student_school_association.create({ data: { student_id: st.id, school_id: school.id, state: 'STUDENT_SELECTED' } }),
    ).rejects.toThrow();
  });

  it('allows a new association once the earlier one has ended (history is kept)', async () => {
    const st = await student();
    const school = await prisma.school.create({ data: { name: 'Example School', country_code: 'AE', city: 'Dubai' } });
    await prisma.student_school_association.create({ data: { student_id: st.id, school_id: school.id, state: 'STUDENT_SELECTED', ended_at: new Date(), end_reason: 'LEFT' } });
    await prisma.student_school_association.create({ data: { student_id: st.id, school_id: school.id, state: 'STUDENT_SELECTED' } });
    expect(await prisma.student_school_association.count({ where: { student_id: st.id } })).toBe(2);
  });

  it('requires exactly one of school or candidate', async () => {
    const st = await student();
    const school = await prisma.school.create({ data: { name: 'Example School', country_code: 'AE', city: 'Dubai' } });
    const cand = await prisma.school_candidate.create({ data: { name_as_entered: 'Typed School', country_code: 'AE' } });
    await expect(prisma.student_school_association.create({ data: { student_id: st.id, state: 'UNVERIFIED' } })).rejects.toThrow();
    await expect(
      prisma.student_school_association.create({ data: { student_id: st.id, school_id: school.id, candidate_id: cand.id, state: 'UNVERIFIED' } }),
    ).rejects.toThrow();
  });
});

describe('School plans and chapter selection constraints (real DB)', () => {
  it('keeps one plan per school, grade and year, and one entry per term, assessment and chapter', async () => {
    const school = await prisma.school.create({ data: { name: 'Plan School', country_code: 'AE' } });
    const plan = await prisma.school_academic_plan.create({
      data: { school_id: school.id, curriculum_code: 'ICSE', grade_code: 'GRADE_8', academic_year: '2026-27', created_by: 'test' },
    });
    await expect(
      prisma.school_academic_plan.create({ data: { school_id: school.id, curriculum_code: 'ICSE', grade_code: 'GRADE_8', academic_year: '2026-27', created_by: 'test' } }),
    ).rejects.toThrow();
    const entry = { plan_id: plan.id, term_label: 'Term 1', assessment_label: '', subject_code: 'PHYSICS', chapter_code: 'FORCE', position: 0 };
    await prisma.school_plan_entry.create({ data: entry });
    await expect(prisma.school_plan_entry.create({ data: { ...entry, position: 1 } })).rejects.toThrow();
  });

  it('stores a chapter once per student', async () => {
    const st = await prisma.student.create({ data: {} });
    const row = { student_id: st.id, subject_code: 'PHYSICS', chapter_code: 'FORCE' };
    await prisma.student_chapter_selection.create({ data: row });
    await expect(prisma.student_chapter_selection.create({ data: row })).rejects.toThrow();
  });
});


describe('AI question factory with the mock provider (real DB)', () => {
  async function unitWithObjective() {
    const { editorId, unitId } = await makeEditorWithUnit();
    const csv = [
      'chapter_code,chapter_title,topic_code,topic_title,concept_code,concept_title,objective_code,objective,evidence_ref,provenance,rationale',
      'CH01,Forces and Motion,CH01-T1,Newton Laws,CH01-T1-C1,First Law,CH01-T1-C1-O1,State Newton first law,1,OFFICIAL_EXPLICIT,From official syllabus page 1',
    ].join('\n');
    await contentImport.upload(editorId, unitId, 'csv', csv);
    const sv = await prisma.curriculum_subject_version.findUnique({ where: { id: unitId }, include: { grade: true, subject: true } });
    return { unitId, gradeCode: sv!.grade.code, subjectCode: sv!.subject.code };
  }
  const make = (faults?: string) => {
    const gateway = new AiGateway(new MockAiProvider(parseMockFaults(faults)), prisma as never, { dailyTokenBudget: 10_000_000, timeoutMs: 5000 });
    return new FactoryService(dbService, new QuestionService(dbService), gateway, { enabled: true, dailyTokenBudget: 10_000_000, solverPasses: 1, callTimeoutMs: 5000 });
  };

  it('writes AI drafts for a person, logs every call, and never approves anything', async () => {
    const { unitId, gradeCode, subjectCode } = await unitWithObjective();
    const summary = await make('wrong-answer=3').runBatch({
      curriculumCode: 'TEST', gradeCode, subjectCode, objectiveCode: 'CH01-T1-C1-O1', difficulty: 'EASY', cognitive: 'C1', count: 3, operator: 'it',
    });
    expect(summary).toMatchObject({ attempted: 3, draftsStored: 2, rejected: 1 });

    const q = await prisma.question_revision.findMany({ where: { question: { objective_path: { endsWith: 'CH01-T1-C1-O1' } } } });
    expect(q).toHaveLength(2);
    for (const r of q) {
      expect(r.origin).toBe('AI_DRAFT');
      expect(r.state).toBe('DRAFT');
      expect(r.cognitive).toBe('C1');
      expect(r.ai_source).toContain(`factory batch ${summary.batchId}`);
    }
    const attempts = await prisma.generation_attempt.findMany({ where: { batch_id: summary.batchId }, orderBy: { sequence: 'asc' } });
    expect(attempts.map((a) => a.outcome)).toEqual(['DRAFT_STORED', 'DRAFT_STORED', 'REJECTED_QUALITY']);
    expect(attempts[0].question_revision_id).toBeTruthy();
    expect(attempts[2].question_revision_id).toBeNull();
    const calls = await prisma.ai_call_log.findMany({ where: { batch_id: summary.batchId } });
    expect(calls.length).toBeGreaterThan(20);
    expect(calls.every((c) => c.input_hash.length === 64)).toBe(true);
    const batch = await prisma.generation_batch.findUnique({ where: { id: summary.batchId } });
    expect(batch).toMatchObject({ status: 'COMPLETED', drafts_stored: 2, rejected: 1 });
    expect(unitId).toBeTruthy();
  });

  it('a second batch carries on instead of repeating the first', async () => {
    const { gradeCode, subjectCode } = await unitWithObjective();
    const run = () => make().runBatch({ curriculumCode: 'TEST', gradeCode, subjectCode, objectiveCode: 'CH01-T1-C1-O1', difficulty: 'EASY', cognitive: 'C1', count: 2, operator: 'it' });
    const a = await run();
    const b = await run();
    expect(a.draftsStored).toBe(2);
    expect(b).toMatchObject({ draftsStored: 2, duplicates: 0 });
  });
});

/* ===================================================================== */
/*  Step 22: the admin workflow, one question in a form                   */
/* ===================================================================== */

describe('Step 22: the curriculum workflow from the admin page, and one question in a form (real DB)', () => {
  const workflow = new CurriculumWorkflowService(dbService, curriculumService, curriculumAdmin, authzService);
  const bank = new QuestionBankService(new QuestionService(dbService), curriculumService, authzService);

  async function person(roleCode: string) {
    const account = await prisma.account.create({ data: {} });
    await prisma.authentication_identity.create({ data: { account_id: account.id, kind: 'EMAIL', identifier_normalized: `${roleCode.toLowerCase()}-${account.id.slice(0, 8)}@example.com`, verified_at: new Date() } as never });
    await authzService.grantRole({ targetAccountId: account.id, roleCode, actorAccountId: null, operator: 'test-setup' });
    return account.id;
  }
  const NOTE = { note: 'Checked against the official syllabus' };

  async function approved() {
    const editor = await person('SUPER_ADMIN');
    const reviewer = await person('CURRICULUM_REVIEWER');
    const approver = await person('CURRICULUM_APPROVER');
    const { id } = await workflow.create(editor, { curriculumCode: 'wf', curriculumName: 'Workflow', versionLabel: '2026-27', gradeCode: 'g8', subjectCode: `wf_${Date.now()}`, subjectName: 'Workflow Subject' });
    const { referenceId } = await workflow.addEvidence(editor, id, { title: 'Official syllabus', url: 'https://example.org/s.pdf', locator: 'p. 4' });
    const leaf = { provenance: 'OFFICIAL_EXPLICIT' as const, evidenceReferenceId: referenceId, rationale: null };
    await curriculumAdmin.replaceContent(editor, id, {
      chapters: [{ code: 'CH01', title: 'Matter', position: 1, ...leaf, topics: [{ code: 'T01', title: 'States', position: 1, ...leaf, microConcepts: [{ code: 'MC01', title: 'Particles', position: 1, ...leaf, learningObjectives: [{ code: 'LO01', statement: 'Describe the three states of matter', position: 1, ...leaf }] }] }] }],
    });
    const checked = await workflow.submit(editor, id);
    expect(checked.passed).toBe(true);
    await workflow.verifyEvidence(reviewer, id, NOTE);
    await workflow.sendToReview(reviewer, id);
    expect((await workflow.approve(approver, id, NOTE)).state).toBe('APPROVED');
    return { id, editor, reviewer, approver };
  }

  it('the editor, even a super administrator, cannot activate; an approver who did not edit it can, with a note, audited', async () => {
    const { id, editor, approver } = await approved();
    const mine = await workflow.detail(editor, id);
    expect(mine.unit.curriculumCode).toBe('WF');
    expect(mine.evidence).toMatchObject({ status: 'VERIFIED', references: [{ number: 1, title: 'Official syllabus' }] });
    expect(mine.content).toMatchObject({ chapters: 1, objectives: 1 });
    expect(mine.actions.activate).toEqual({ allowed: false, reason: expect.stringMatching(/You edited this revision/) });
    await expect(workflow.activate(editor, id, NOTE)).rejects.toThrow(/did not edit/);
    await expect(workflow.activate(approver, id, { note: 'short' })).rejects.toThrow(/10/);
    expect((await workflow.detail(approver, id)).actions.activate).toEqual({ allowed: true });

    expect((await workflow.activate(approver, id, NOTE)).state).toBe('ACTIVE');
    const audit = await prisma.audit_event.findFirst({ where: { action: 'curriculum.activated', subject_id: id } });
    expect(audit).toMatchObject({ actor_account_id: approver });
    const history = (await workflow.detail(approver, id)).history;
    expect(history[0]).toMatchObject({ from: 'APPROVED', to: 'ACTIVE' });
  });

  it('a live curriculum is suspended and resumed by an approver, and corrected with a new revision', async () => {
    const { id, editor, approver } = await approved();
    await workflow.activate(approver, id, NOTE);
    expect((await workflow.suspend(approver, id, { note: 'A wrong unit in chapter 1' })).state).toBe('SUSPENDED');
    await expect(workflow.resume(editor, id, NOTE)).rejects.toThrow(/did not edit/);
    expect((await workflow.resume(approver, id, { note: 'Fixed upstream, resuming' })).state).toBe('ACTIVE');
    expect(await prisma.audit_event.count({ where: { subject_id: id, action: { in: ['curriculum.suspended', 'curriculum.resumed'] } } })).toBe(2);

    const next = await workflow.startCorrection(editor, id);
    expect(next.revision).toBe(2);
    const d = await workflow.detail(editor, next.id);
    expect(d.unit.state).toBe('DRAFT');
    expect(d.revisions.map((r) => [r.revision, r.state])).toEqual([[2, 'DRAFT'], [1, 'ACTIVE']]);
    expect((await workflow.detail(editor, id)).actions.startCorrection).toEqual({ allowed: false, reason: 'A correction is already being prepared' });
  });

  it('one question written in a form is saved as a draft through the same checks as an upload', async () => {
    const { id, approver } = await approved();
    await workflow.activate(approver, id, NOTE);
    const editor = await person('CURRICULUM_EDITOR');
    expect(await bank.objectives(editor, id)).toEqual([expect.objectContaining({ code: 'LO01', path: 'CH01/T01/MC01/LO01', ambiguous: false })]);
    const form = { code: 'wf-q1', objectiveCode: 'LO01', stem: 'Which state of matter has a fixed shape?', options: ['Solid', 'Liquid', 'Gas', 'Plasma'], correct: 'A', difficulty: 'EASY', cognitive: 'C1', explanation: '' };

    const bad = await bank.saveOne(editor, id, { ...form, options: ['Solid', 'Liquid', 'Gas'] });
    expect(bad.written).toBe(false);
    expect(await prisma.question.count({ where: { code: 'WF-Q1' } })).toBe(0);

    const saved = await bank.saveOne(editor, id, form);
    expect(saved).toMatchObject({ ok: true, written: true, revisionId: expect.any(String) });
    const rev = await prisma.question_revision.findUniqueOrThrow({ where: { id: saved.revisionId as string }, include: { options: true } });
    expect(rev).toMatchObject({ state: 'DRAFT', origin: 'HUMAN', difficulty: 'EASY', cognitive: 'C1' });
    expect(rev.options.filter((o: { is_correct: boolean }) => o.is_correct)).toHaveLength(1);

    const reviewer = await person('CURRICULUM_REVIEWER');
    await expect(bank.saveOne(reviewer, id, { ...form, code: 'wf-q2' })).rejects.toThrow(/editor/);
  });
});
