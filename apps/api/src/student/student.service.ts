import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';

export class StudentNotFoundError extends Error {
  constructor() {
    super('No student profile for this account');
    this.name = 'StudentNotFoundError';
  }
}
/** Display name is not collected until the student's age status allows it. */
export class GuardianConsentRequiredError extends Error {
  constructor() {
    super('Guardian consent is required before this can be collected');
    this.name = 'GuardianConsentRequiredError';
  }
}
export class InvalidProfileInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidProfileInputError';
  }
}

export interface StudentProfileView {
  studentId: string;
  displayName: string | null;
  ageClassified: boolean;
  requiresGuardianConsent: boolean;
}

export const DEFAULT_JURISDICTION = process.env.DEFAULT_JURISDICTION ?? 'AE';
const DOB_METHOD = 'SELF_DECLARED';
const NAME = /^[\p{L}\p{M}][\p{L}\p{M} .'-]{0,59}$/u;

/**
 * Domain 02 (Student Profile) — the minimal slice the web onboarding needs.
 * A login account acts for its own student only through account_student_access.
 * Date of birth goes straight to PrivacyService and is never returned.
 */
@Injectable()
export class StudentService {
  constructor(
    private readonly db: DatabaseService,
    private readonly privacy: PrivacyService,
    private readonly outbox: OutboxService,
  ) {}

  /** Idempotent: an account gets at most one SELF student. */
  async createOwnProfile(accountId: string): Promise<StudentProfileView> {
    const studentId = await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.account_student_access.findFirst({
        where: { account_id: accountId, access_kind: 'SELF', revoked_at: null },
      });
      if (existing) return existing.student_id as string;
      const student = await tx.student.create({ data: {} });
      await tx.account_student_access.create({
        data: { account_id: accountId, student_id: student.id, access_kind: 'SELF' },
      });
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: student.id,
        eventType: 'student.created.v1',
        payload: { studentId: student.id },
        idempotencyKey: `student-created:${student.id}`,
      });
      return student.id as string;
    });
    return this.view(studentId);
  }

  async getOwnProfile(accountId: string): Promise<StudentProfileView> {
    return this.view(await this.ownStudentId(accountId));
  }

  async setDateOfBirth(
    accountId: string,
    dateOfBirth: Date,
    jurisdictionCode: string = DEFAULT_JURISDICTION,
  ): Promise<StudentProfileView> {
    const studentId = await this.ownStudentId(accountId);
    await this.privacy.recordAgeClassification({
      studentId,
      dateOfBirth,
      jurisdictionCode,
      dobEvidenceMethod: DOB_METHOD,
      actorAccountId: accountId,
    });
    return this.view(studentId);
  }

  /** Only after age classification says guardian consent is NOT required. */
  async setDisplayName(accountId: string, rawName: string): Promise<StudentProfileView> {
    const name = rawName.trim().replace(/\s+/g, ' ');
    if (!NAME.test(name)) throw new InvalidProfileInputError('Enter a name of up to 60 letters');
    const studentId = await this.ownStudentId(accountId);
    const summary = await this.privacy.getClassificationSummary(studentId);
    if (summary.requiresGuardianConsent) throw new GuardianConsentRequiredError();
    await this.db.client.student.update({ where: { id: studentId }, data: { display_name: name } });
    return this.view(studentId);
  }

  private async ownStudentId(accountId: string): Promise<string> {
    const access = await this.db.client.account_student_access.findFirst({
      where: { account_id: accountId, access_kind: 'SELF', revoked_at: null },
    });
    if (!access) throw new StudentNotFoundError();
    return access.student_id as string;
  }

  private async view(studentId: string): Promise<StudentProfileView> {
    // If the student was classified when no policy existed, and a policy is
    // now active, re-classify automatically so the user is not stuck on the
    // guardian-needed screen. The DOB stays inside PrivacyService.
    await this.privacy.reclassifyIfStale(studentId, DEFAULT_JURISDICTION);

    const student = await this.db.client.student.findUnique({
      where: { id: studentId },
      select: { display_name: true },
    });
    const summary = await this.privacy.getClassificationSummary(studentId);
    return {
      studentId,
      displayName: (student?.display_name ?? null) as string | null,
      ageClassified: summary.classified,
      requiresGuardianConsent: summary.requiresGuardianConsent,
    };
  }
}
