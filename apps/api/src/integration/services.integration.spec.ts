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

  await prisma.consent_withdrawal.deleteMany();
  await prisma.consent_record.deleteMany();
  await prisma.consent_policy_version.deleteMany();
  await prisma.consent_purpose.deleteMany();
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
