import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { StudentService, DEFAULT_JURISDICTION } from '../student/student.service';
import { NotInLaunchCohortError, SchoolNotFoundError } from './school.errors';
import {
  LAUNCH_COHORT,
  isLaunchCohort,
  normalizeSchoolName,
  normalizeSearchQuery,
  stateForStudentChoice,
  type AssociationState,
} from './school-domain';

export interface AcademicView {
  cohortOptions: ReadonlyArray<{ curriculumCode: string; gradeCode: string; label: string }>;
  grade: { curriculumCode: string; gradeCode: string; label: string } | null;
  school: { state: AssociationState; name: string; branchName: string | null; awaitingReview: boolean } | null;
}

export type SchoolChoice = { schoolId: string; branchId?: string } | { schoolName: string };

export interface SchoolSearchHit {
  id: string;
  name: string;
  city: string | null;
  branches: Array<{ id: string; name: string }>;
}

/**
 * Student-facing side of Domain 04. Everything here is the student's own, unverified statement:
 * it never grants a school any access (see school-domain.ts). Collecting it is refused while
 * guardian consent is required, the same fail-closed rule as the display name.
 */
@Injectable()
export class StudentSchoolService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentService,
    private readonly outbox: OutboxService,
  ) {}

  async getAcademic(accountId: string): Promise<AcademicView> {
    const studentId = await this.students.ownStudentId(accountId);
    return this.view(this.db.client as unknown as Prisma.TransactionClient, studentId);
  }

  async setGrade(accountId: string, curriculumCode: string, gradeCode: string): Promise<AcademicView> {
    if (!isLaunchCohort(curriculumCode, gradeCode)) throw new NotInLaunchCohortError();
    const studentId = await this.students.studentIdForDataCollection(accountId);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const row = await tx.student_academic_context.upsert({
        where: { student_id: studentId },
        create: { student_id: studentId, curriculum_code: curriculumCode, grade_code: gradeCode },
        update: { curriculum_code: curriculumCode, grade_code: gradeCode },
      });
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: studentId,
        eventType: 'student.academic_context.set.v1',
        payload: { studentId, curriculumCode: row.curriculum_code, gradeCode: row.grade_code },
        idempotencyKey: `academic-context:${studentId}:${randomUUID()}`,
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: accountId,
          action: 'student.academic_context.set',
          subject_type: 'student',
          subject_id: studentId,
          metadata: { curriculumCode, gradeCode },
        },
      });
      return this.view(tx, studentId);
    });
  }

  /** Registry search. Only ACTIVE schools; the query is a bound parameter over a restricted alphabet. */
  async search(rawQuery: unknown, countryCode: string = DEFAULT_JURISDICTION): Promise<SchoolSearchHit[]> {
    const q = normalizeSearchQuery(rawQuery);
    const rows = await this.db.client.school.findMany({
      where: {
        status: 'ACTIVE',
        country_code: countryCode,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { aliases: { some: { alias: { contains: q, mode: 'insensitive' } } } },
        ],
      },
      include: { branches: { where: { status: 'ACTIVE' }, orderBy: { name: 'asc' } } },
      orderBy: { name: 'asc' },
      take: 20,
    });
    return (rows as any[]).map((s) => ({
      id: s.id,
      name: s.name,
      city: s.city,
      branches: s.branches.map((b: any) => ({ id: b.id, name: b.name })),
    }));
  }

  /**
   * The student's choice becomes the single OPEN association; any previous open one ends with reason
   * CHANGED (history is kept). A registry school is STUDENT_SELECTED; free text is stored as a
   * PENDING candidate for an admin to resolve and the association stays UNVERIFIED.
   * A student can never produce VERIFIED or SCHOOL_CONFIRMED.
   */
  async selectSchool(accountId: string, choice: SchoolChoice): Promise<AcademicView> {
    const studentId = await this.students.studentIdForDataCollection(accountId);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      let target: { schoolId: string | null; branchId: string | null; candidateId: string | null; state: AssociationState };

      if ('schoolId' in choice) {
        const school = await tx.school.findFirst({ where: { id: choice.schoolId, status: 'ACTIVE' } });
        if (!school) throw new SchoolNotFoundError();
        let branchId: string | null = null;
        if (choice.branchId) {
          const branch = await tx.school_branch.findFirst({ where: { id: choice.branchId, school_id: school.id, status: 'ACTIVE' } });
          if (!branch) throw new SchoolNotFoundError();
          branchId = branch.id as string;
        }
        target = { schoolId: school.id as string, branchId, candidateId: null, state: stateForStudentChoice('REGISTRY_SCHOOL') };
      } else {
        const name = normalizeSchoolName(choice.schoolName);
        // If the text exactly matches an ACTIVE registry school, use the registry school.
        const match = await tx.school.findFirst({
          where: { status: 'ACTIVE', country_code: DEFAULT_JURISDICTION, name: { equals: name, mode: 'insensitive' } },
        });
        if (match) {
          target = { schoolId: match.id as string, branchId: null, candidateId: null, state: stateForStudentChoice('REGISTRY_SCHOOL') };
        } else {
          const existing = await tx.school_candidate.findFirst({
            where: { status: 'PENDING', country_code: DEFAULT_JURISDICTION, name_as_entered: { equals: name, mode: 'insensitive' } },
          });
          const candidate =
            existing ?? (await tx.school_candidate.create({ data: { name_as_entered: name, country_code: DEFAULT_JURISDICTION } }));
          target = { schoolId: null, branchId: null, candidateId: candidate.id as string, state: stateForStudentChoice('FREE_TEXT') };
        }
      }

      const open = await tx.student_school_association.findFirst({ where: { student_id: studentId, ended_at: null } });
      if (
        open &&
        open.school_id === target.schoolId &&
        open.branch_id === target.branchId &&
        open.candidate_id === target.candidateId
      ) {
        return this.view(tx, studentId); // same choice again: nothing to change
      }

      const now = new Date();
      if (open) {
        await tx.student_school_association.updateMany({
          where: { student_id: studentId, ended_at: null },
          data: { ended_at: now, end_reason: 'CHANGED' },
        });
      }
      const created = await tx.student_school_association.create({
        data: {
          student_id: studentId,
          school_id: target.schoolId,
          branch_id: target.branchId,
          candidate_id: target.candidateId,
          state: target.state,
        },
      });
      await this.record(tx, accountId, studentId, created.id as string, 'student.school_association.set', target.state);
      return this.view(tx, studentId);
    });
  }

  async leaveSchool(accountId: string): Promise<AcademicView> {
    const studentId = await this.students.ownStudentId(accountId);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const open = await tx.student_school_association.findFirst({ where: { student_id: studentId, ended_at: null } });
      if (open) {
        await tx.student_school_association.update({ where: { id: open.id }, data: { ended_at: new Date(), end_reason: 'LEFT' } });
        await this.record(tx, accountId, studentId, open.id as string, 'student.school_association.ended', open.state as AssociationState);
      }
      return this.view(tx, studentId);
    });
  }

  /** Event and audit carry ids and a state only: never a school name or any free text. */
  private async record(
    tx: Prisma.TransactionClient,
    accountId: string,
    studentId: string,
    associationId: string,
    action: string,
    state: AssociationState,
  ): Promise<void> {
    await this.outbox.publish(tx, {
      aggregateType: 'student',
      aggregateId: studentId,
      eventType: `${action}.v1`,
      payload: { studentId, associationId, state },
      idempotencyKey: `${action}:${associationId}`,
    });
    await tx.audit_event.create({
      data: {
        actor_account_id: accountId,
        action,
        subject_type: 'student_school_association',
        subject_id: associationId,
        metadata: { state },
      },
    });
  }

  private async view(tx: Prisma.TransactionClient, studentId: string): Promise<AcademicView> {
    const ctx = await tx.student_academic_context.findUnique({ where: { student_id: studentId } });
    const open = await tx.student_school_association.findFirst({
      where: { student_id: studentId, ended_at: null },
      include: { school: true, branch: true, candidate: true },
    });
    const label = (c: string, g: string) => LAUNCH_COHORT.find((x) => x.curriculumCode === c && x.gradeCode === g)?.label ?? `${c} · ${g}`;
    return {
      cohortOptions: LAUNCH_COHORT,
      grade: ctx
        ? { curriculumCode: ctx.curriculum_code, gradeCode: ctx.grade_code, label: label(ctx.curriculum_code, ctx.grade_code) }
        : null,
      school: open
        ? {
            state: open.state as AssociationState,
            name: (open.school?.name ?? open.candidate?.name_as_entered ?? '') as string,
            branchName: (open.branch?.name ?? null) as string | null,
            awaitingReview: open.candidate_id !== null,
          }
        : null,
    };
  }
}
