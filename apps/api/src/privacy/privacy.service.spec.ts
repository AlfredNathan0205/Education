import type { DatabaseService } from '../database/database.service';
import type { OutboxService } from '../outbox/outbox.service';
import { PolicyActivationError, PolicyConfigError } from './jurisdiction-policy';
import {
  ConsentTextUnavailableError,
  MethodNotAcceptedError,
  PrivacyForbiddenError,
} from './privacy.errors';
import { PrivacyService } from './privacy.service';

/**
 * These tests run the service against an in-memory fake of the Prisma client, so
 * they verify the guard rails and orchestration (legal gate, fail-closed, no DOB
 * in events). They do NOT exercise real SQL: Prisma typing and the schema are
 * verified by CI's `prisma generate` + typecheck, and real queries by a database.
 */

const NOW = new Date('2026-10-11T12:00:00Z');
const ACTOR = 'actor-account';
const STUDENT = 'student-1';

/** Illustrative values only; not legal parameters for any real jurisdiction. */
const completeConfig = {
  minorAgeThreshold: 18,
  guardianConsentAgeThreshold: 16,
  acceptedDobEvidenceMethods: ['SELF_DECLARED'],
  acceptedGuardianVerificationMethods: ['GUARDIAN_OTP'],
};

function makeFakes() {
  const client: Record<string, any> = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: STUDENT }]),
    jurisdiction_policy: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      updateMany: jest.fn(),
      update: jest.fn(),
      create: jest.fn(),
    },
    age_classification: { findFirst: jest.fn(), updateMany: jest.fn(), create: jest.fn() },
    consent_purpose: { findUnique: jest.fn() },
    consent_policy_version: { findFirst: jest.fn() },
    consent_record: { create: jest.fn(), findUnique: jest.fn(), findMany: jest.fn() },
    consent_withdrawal: { create: jest.fn() },
    account_student_access: { findFirst: jest.fn() },
    guardian_authority: { findUnique: jest.fn() },
    audit_event: { create: jest.fn() },
  };
  client.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(client));
  const outbox = { publish: jest.fn() };
  const service = new PrivacyService(
    { client } as unknown as DatabaseService,
    outbox as unknown as OutboxService,
  );
  return { client, outbox, service };
}

describe('PrivacyService.activateJurisdictionPolicy (the legal gate)', () => {
  const policy = (over: Record<string, unknown> = {}) => ({
    id: 'p1',
    jurisdiction_code: 'AE',
    version: 1,
    status: 'DRAFT',
    legal_review: 'COUNSEL_REVIEWED',
    legal_review_reference: 'memo-1',
    config: completeConfig,
    ...over,
  });

  it('refuses an unreviewed policy and writes nothing', async () => {
    const { client, outbox, service } = makeFakes();
    client.jurisdiction_policy.findUnique.mockResolvedValue(policy({ legal_review: 'UNREVIEWED' }));

    await expect(service.activateJurisdictionPolicy('p1', ACTOR, NOW)).rejects.toBeInstanceOf(
      PolicyActivationError,
    );
    expect(client.jurisdiction_policy.update).not.toHaveBeenCalled();
    expect(client.jurisdiction_policy.updateMany).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
    expect(client.audit_event.create).not.toHaveBeenCalled();
  });

  it('refuses a retired policy', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findUnique.mockResolvedValue(policy({ status: 'RETIRED' }));
    await expect(service.activateJurisdictionPolicy('p1', ACTOR, NOW)).rejects.toBeInstanceOf(
      PolicyActivationError,
    );
  });

  it('activates a reviewed policy, retires the previous one, and emits event + audit', async () => {
    const { client, outbox, service } = makeFakes();
    client.jurisdiction_policy.findUnique.mockResolvedValue(policy());

    await service.activateJurisdictionPolicy('p1', ACTOR, NOW);

    expect(client.jurisdiction_policy.updateMany).toHaveBeenCalledWith({
      where: { jurisdiction_code: 'AE', status: 'ACTIVE' },
      data: { status: 'RETIRED' },
    });
    expect(client.jurisdiction_policy.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { status: 'ACTIVE', effective_from: NOW },
    });
    expect(outbox.publish).toHaveBeenCalledTimes(1);
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });

  it('is idempotent for an already ACTIVE policy', async () => {
    const { client, outbox, service } = makeFakes();
    client.jurisdiction_policy.findUnique.mockResolvedValue(policy({ status: 'ACTIVE' }));
    await service.activateJurisdictionPolicy('p1', ACTOR, NOW);
    expect(client.jurisdiction_policy.update).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });
});

describe('PrivacyService.recordAgeClassification', () => {
  const dob = new Date('2013-03-01T00:00:00Z');
  const input = {
    studentId: STUDENT,
    dateOfBirth: dob,
    jurisdictionCode: 'AE',
    dobEvidenceMethod: 'SELF_DECLARED',
    actorAccountId: ACTOR,
  };

  it('fails closed when there is no ACTIVE counsel-reviewed policy', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue(null);
    client.age_classification.create.mockResolvedValue({ id: 'ac1' });

    const result = await service.recordAgeClassification(input, NOW);

    expect(result).toMatchObject({
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'FAIL_CLOSED_NO_ACTIVE_POLICY',
    });
    expect(client.age_classification.create.mock.calls[0][0].data).toMatchObject({
      jurisdiction_policy_id: null,
      requires_guardian_consent: true,
    });
  });

  it('only looks up policies that are ACTIVE and counsel-reviewed', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue(null);
    client.age_classification.create.mockResolvedValue({ id: 'ac1' });
    await service.recordAgeClassification(input, NOW);
    expect(client.jurisdiction_policy.findFirst.mock.calls[0][0].where).toEqual({
      jurisdiction_code: 'AE',
      status: 'ACTIVE',
      legal_review: 'COUNSEL_REVIEWED',
    });
  });

  it('fails closed (not open) when the stored policy config is corrupt', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue({
      id: 'p1',
      config: { nonsense: true },
    });
    client.age_classification.create.mockResolvedValue({ id: 'ac1' });
    const result = await service.recordAgeClassification(
      { ...input, dateOfBirth: new Date('1990-01-01') },
      NOW,
    );
    expect(result).toMatchObject({ isMinor: true, basis: 'FAIL_CLOSED_INCOMPLETE_POLICY' });
  });

  it('classifies by the active policy and supersedes the previous classification', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue({ id: 'p1', config: completeConfig });
    client.age_classification.create.mockResolvedValue({ id: 'ac1' });

    const result = await service.recordAgeClassification(input, NOW);

    expect(result).toMatchObject({
      ageYears: 13,
      isMinor: true,
      requiresGuardianConsent: true,
      basis: 'POLICY',
    });
    expect(client.age_classification.updateMany).toHaveBeenCalledWith({
      where: { student_id: STUDENT, superseded_at: null },
      data: { superseded_at: NOW },
    });
  });

  it('rejects a DOB evidence method the active policy does not accept', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue({ id: 'p1', config: completeConfig });
    await expect(
      service.recordAgeClassification({ ...input, dobEvidenceMethod: 'PASSPORT_SCAN' }, NOW),
    ).rejects.toBeInstanceOf(MethodNotAcceptedError);
    expect(client.age_classification.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed method code', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue(null);
    await expect(
      service.recordAgeClassification({ ...input, dobEvidenceMethod: 'self declared' }, NOW),
    ).rejects.toBeInstanceOf(MethodNotAcceptedError);
  });

  it('never puts the date of birth in the outbox event or the audit row', async () => {
    const { client, outbox, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue({ id: 'p1', config: completeConfig });
    client.age_classification.create.mockResolvedValue({ id: 'ac1' });

    await service.recordAgeClassification(input, NOW);

    const emitted = JSON.stringify([
      outbox.publish.mock.calls,
      client.audit_event.create.mock.calls,
    ]);
    expect(emitted).not.toContain('2013');
    expect(emitted).not.toContain('date_of_birth');
    expect(emitted).not.toContain('dateOfBirth');
  });
});

describe('PrivacyService.grantConsent', () => {
  const base = { studentId: STUDENT, purposeCode: 'CORE_ASSESSMENT', actorAccountId: ACTOR };
  const withPurposeAndText = (client: Record<string, any>) => {
    client.consent_purpose.findUnique.mockResolvedValue({ id: 'purpose-1' });
    client.consent_policy_version.findFirst.mockResolvedValue({ id: 'cpv-1', version: 3 });
    client.consent_record.create.mockResolvedValue({ id: 'cr-1' });
  };
  const authority = (over: Record<string, unknown> = {}) => ({
    id: 'auth-1',
    authority_type: 'CONSENT',
    revoked_at: null,
    guardian_relationship: { guardian_account_id: ACTOR, student_id: STUDENT },
    guardian_verification: { status: 'VERIFIED', expires_at: null },
    ...over,
  });

  it('refuses when the purpose has no live consent text', async () => {
    const { client, service } = makeFakes();
    client.consent_purpose.findUnique.mockResolvedValue({ id: 'purpose-1' });
    client.consent_policy_version.findFirst.mockResolvedValue(null);
    await expect(service.grantConsent({ ...base, capacity: 'SELF' }, NOW)).rejects.toBeInstanceOf(
      ConsentTextUnavailableError,
    );
  });

  it('refuses SELF consent from an account with no self access', async () => {
    const { client, service } = makeFakes();
    withPurposeAndText(client);
    client.account_student_access.findFirst.mockResolvedValue(null);
    await expect(service.grantConsent({ ...base, capacity: 'SELF' }, NOW)).rejects.toBeInstanceOf(
      PrivacyForbiddenError,
    );
    expect(client.consent_record.create).not.toHaveBeenCalled();
  });

  it('refuses GUARDIAN consent without an authority', async () => {
    const { client, service } = makeFakes();
    withPurposeAndText(client);
    await expect(
      service.grantConsent({ ...base, capacity: 'GUARDIAN' }, NOW),
    ).rejects.toBeInstanceOf(PrivacyForbiddenError);
  });

  it.each([
    [
      'belongs to a different guardian',
      { guardian_relationship: { guardian_account_id: 'someone-else', student_id: STUDENT } },
    ],
    [
      'is for a different student',
      { guardian_relationship: { guardian_account_id: ACTOR, student_id: 'other-student' } },
    ],
    ['is revoked', { revoked_at: new Date('2026-01-01') }],
    [
      'has an unverified verification',
      { guardian_verification: { status: 'PENDING', expires_at: null } },
    ],
    [
      'has a lapsed verification',
      { guardian_verification: { status: 'VERIFIED', expires_at: new Date('2026-01-01') } },
    ],
    ['is not a CONSENT authority', { authority_type: 'ACCESS' }],
  ])('refuses GUARDIAN consent when the authority %s', async (_label, over) => {
    const { client, service } = makeFakes();
    withPurposeAndText(client);
    client.guardian_authority.findUnique.mockResolvedValue(authority(over));
    await expect(
      service.grantConsent({ ...base, capacity: 'GUARDIAN', guardianAuthorityId: 'auth-1' }, NOW),
    ).rejects.toBeInstanceOf(PrivacyForbiddenError);
    expect(client.consent_record.create).not.toHaveBeenCalled();
  });

  it('records GUARDIAN consent through a valid authority, with event and audit', async () => {
    const { client, outbox, service } = makeFakes();
    withPurposeAndText(client);
    client.guardian_authority.findUnique.mockResolvedValue(authority());

    const out = await service.grantConsent(
      { ...base, capacity: 'GUARDIAN', guardianAuthorityId: 'auth-1' },
      NOW,
    );

    expect(out).toEqual({ consentRecordId: 'cr-1' });
    expect(client.consent_record.create.mock.calls[0][0].data).toMatchObject({
      capacity: 'GUARDIAN',
      guardian_authority_id: 'auth-1',
      consent_policy_version_id: 'cpv-1',
    });
    expect(outbox.publish).toHaveBeenCalledTimes(1);
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });
});

describe('PrivacyService.withdrawConsent', () => {
  const record = (over: Record<string, unknown> = {}) => ({
    id: 'cr-1',
    student_id: STUDENT,
    granted_by_account_id: 'granter',
    withdrawal: null,
    purpose: { code: 'CORE_ASSESSMENT' },
    ...over,
  });

  it('lets the original granter withdraw', async () => {
    const { client, outbox, service } = makeFakes();
    client.consent_record.findUnique.mockResolvedValue(record());
    await service.withdrawConsent(
      { consentRecordId: 'cr-1', actorAccountId: 'granter', reasonCode: 'CHANGED_MIND' },
      NOW,
    );
    expect(client.consent_withdrawal.create).toHaveBeenCalledTimes(1);
    expect(outbox.publish).toHaveBeenCalledTimes(1);
  });

  it('lets another account with live access to the student withdraw', async () => {
    const { client, service } = makeFakes();
    client.consent_record.findUnique.mockResolvedValue(record());
    client.account_student_access.findFirst.mockResolvedValue({ id: 'acc-1' });
    await service.withdrawConsent({ consentRecordId: 'cr-1', actorAccountId: 'parent' }, NOW);
    expect(client.consent_withdrawal.create).toHaveBeenCalledTimes(1);
  });

  it('refuses an unrelated account', async () => {
    const { client, service } = makeFakes();
    client.consent_record.findUnique.mockResolvedValue(record());
    client.account_student_access.findFirst.mockResolvedValue(null);
    await expect(
      service.withdrawConsent({ consentRecordId: 'cr-1', actorAccountId: 'stranger' }, NOW),
    ).rejects.toBeInstanceOf(PrivacyForbiddenError);
    expect(client.consent_withdrawal.create).not.toHaveBeenCalled();
  });

  it('is a no-op when already withdrawn', async () => {
    const { client, outbox, service } = makeFakes();
    client.consent_record.findUnique.mockResolvedValue(record({ withdrawal: { id: 'w1' } }));
    await service.withdrawConsent({ consentRecordId: 'cr-1', actorAccountId: 'granter' }, NOW);
    expect(client.consent_withdrawal.create).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('treats a concurrent-withdrawal unique violation as already done', async () => {
    const { client, service } = makeFakes();
    client.consent_record.findUnique.mockResolvedValue(record());
    client.consent_withdrawal.create.mockRejectedValue(
      Object.assign(new Error('unique'), { code: 'P2002' }),
    );
    await expect(
      service.withdrawConsent({ consentRecordId: 'cr-1', actorAccountId: 'granter' }, NOW),
    ).resolves.toBeUndefined();
  });

  it('does not swallow other errors', async () => {
    const { client, service } = makeFakes();
    client.consent_record.findUnique.mockResolvedValue(record());
    client.consent_withdrawal.create.mockRejectedValue(new Error('db down'));
    await expect(
      service.withdrawConsent({ consentRecordId: 'cr-1', actorAccountId: 'granter' }, NOW),
    ).rejects.toThrow('db down');
  });
});

describe('PrivacyService.evaluateProcessingForStudent', () => {
  const selfRecord = {
    id: 'cr-1',
    capacity: 'SELF',
    guardian_authority_id: null,
    granted_at: new Date('2026-09-01'),
    withdrawal: null,
    authority: null,
  };

  it('denies when nothing has been granted', async () => {
    const { client, service } = makeFakes();
    client.age_classification.findFirst.mockResolvedValue({ requires_guardian_consent: false });
    client.consent_record.findMany.mockResolvedValue([]);
    expect(await service.evaluateProcessingForStudent(STUDENT, 'CORE_ASSESSMENT', NOW)).toEqual({
      allowed: false,
      reason: 'NO_CONSENT',
    });
  });

  it('treats a student with NO age classification as requiring guardian consent (fail closed)', async () => {
    const { client, service } = makeFakes();
    client.age_classification.findFirst.mockResolvedValue(null);
    client.consent_record.findMany.mockResolvedValue([selfRecord]);
    expect(await service.evaluateProcessingForStudent(STUDENT, 'CORE_ASSESSMENT', NOW)).toEqual({
      allowed: false,
      reason: 'GUARDIAN_CONSENT_REQUIRED',
    });
  });

  it('allows own consent when the classification does not require a guardian', async () => {
    const { client, service } = makeFakes();
    client.age_classification.findFirst.mockResolvedValue({ requires_guardian_consent: false });
    client.consent_record.findMany.mockResolvedValue([selfRecord]);
    expect(await service.evaluateProcessingForStudent(STUDENT, 'CORE_ASSESSMENT', NOW)).toEqual({
      allowed: true,
      grantId: 'cr-1',
    });
  });

  it('allows a valid guardian grant for a minor, and denies it once the verification lapses', async () => {
    const { client, service } = makeFakes();
    client.age_classification.findFirst.mockResolvedValue({ requires_guardian_consent: true });
    const guardianRecord = (expires: Date | null) => ({
      id: 'cr-2',
      capacity: 'GUARDIAN',
      guardian_authority_id: 'auth-1',
      granted_at: new Date('2026-09-01'),
      withdrawal: null,
      authority: {
        id: 'auth-1',
        revoked_at: null,
        guardian_verification: { status: 'VERIFIED', expires_at: expires },
      },
    });

    client.consent_record.findMany.mockResolvedValue([guardianRecord(null)]);
    expect(await service.evaluateProcessingForStudent(STUDENT, 'CORE_ASSESSMENT', NOW)).toEqual({
      allowed: true,
      grantId: 'cr-2',
    });

    client.consent_record.findMany.mockResolvedValue([guardianRecord(new Date('2026-10-01'))]);
    expect(await service.evaluateProcessingForStudent(STUDENT, 'CORE_ASSESSMENT', NOW)).toEqual({
      allowed: false,
      reason: 'GUARDIAN_AUTHORITY_INVALID',
    });
  });
});

describe('PrivacyService.createJurisdictionPolicyDraft', () => {
  it('creates version 1 as an UNREVIEWED DRAFT when none exists', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue(null);
    client.jurisdiction_policy.create.mockResolvedValue({ id: 'p1' });
    const out = await service.createJurisdictionPolicyDraft(
      { jurisdictionCode: 'AE', config: completeConfig },
      null,
      'cli',
    );
    expect(out).toEqual({ id: 'p1', version: 1 });
    const data = client.jurisdiction_policy.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: 'DRAFT', legal_review: 'UNREVIEWED', version: 1 });
    expect(data.legal_review_reference).toBeUndefined();
  });

  it('increments the version past the latest', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue({ version: 3 });
    client.jurisdiction_policy.create.mockResolvedValue({ id: 'p4' });
    const out = await service.createJurisdictionPolicyDraft(
      { jurisdictionCode: 'AE', config: completeConfig },
      null,
    );
    expect(out.version).toBe(4);
  });

  it('accepts an empty (null-threshold) config as a draft; it simply cannot be activated', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findFirst.mockResolvedValue(null);
    client.jurisdiction_policy.create.mockResolvedValue({ id: 'p1' });
    await expect(
      service.createJurisdictionPolicyDraft(
        {
          jurisdictionCode: 'AE',
          config: {
            minorAgeThreshold: null,
            guardianConsentAgeThreshold: null,
            acceptedDobEvidenceMethods: [],
            acceptedGuardianVerificationMethods: [],
          },
        },
        null,
      ),
    ).resolves.toBeDefined();
  });

  it.each([['ae'], ['UAE'], ['']])('rejects jurisdiction code %p', async (code) => {
    const { client, service } = makeFakes();
    await expect(
      service.createJurisdictionPolicyDraft({ jurisdictionCode: code, config: completeConfig }, null),
    ).rejects.toBeInstanceOf(PolicyConfigError);
    expect(client.jurisdiction_policy.create).not.toHaveBeenCalled();
  });

  it('rejects a malformed config before touching the database', async () => {
    const { client, service } = makeFakes();
    await expect(
      service.createJurisdictionPolicyDraft(
        { jurisdictionCode: 'AE', config: { ...completeConfig, minorAgeThreshhold: 18 } },
        null,
      ),
    ).rejects.toBeInstanceOf(PolicyConfigError);
    expect(client.$transaction).not.toHaveBeenCalled();
  });
});

describe('PrivacyService.markPolicyCounselReviewed', () => {
  it('marks a DRAFT reviewed with a trimmed reference, and does not activate', async () => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findUnique.mockResolvedValue({ id: 'p1', status: 'DRAFT' });
    await service.markPolicyCounselReviewed('p1', '  memo-9 ', null);
    expect(client.jurisdiction_policy.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { legal_review: 'COUNSEL_REVIEWED', legal_review_reference: 'memo-9' },
    });
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });

  it.each([[''], ['   ']])('refuses a blank reference %p', async (ref) => {
    const { client, service } = makeFakes();
    await expect(service.markPolicyCounselReviewed('p1', ref, null)).rejects.toBeInstanceOf(
      PolicyActivationError,
    );
    expect(client.jurisdiction_policy.update).not.toHaveBeenCalled();
  });

  it.each([['ACTIVE'], ['RETIRED']])('refuses a %s policy', async (status) => {
    const { client, service } = makeFakes();
    client.jurisdiction_policy.findUnique.mockResolvedValue({ id: 'p1', status });
    await expect(service.markPolicyCounselReviewed('p1', 'memo', null)).rejects.toBeInstanceOf(
      PolicyActivationError,
    );
  });
});
