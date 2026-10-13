import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { CandidateNotPendingError, SchoolNotFoundError } from './school.errors';
import { normalizeCity, normalizeCountryCode, normalizeSchoolName } from './school-domain';

export type CandidateDecision = { action: 'accept'; schoolId: string } | { action: 'reject' };

/**
 * Operator-side registry maintenance (Domain 04). Registry facts are curated by people:
 * nothing here is invented or imported automatically, and every change is audited with
 * the operator's name. Coarse geography only.
 */
@Injectable()
export class SchoolRegistryService {
  constructor(private readonly db: DatabaseService) {}

  async addSchool(input: { name: string; countryCode: string; city?: string; operator: string }): Promise<{ id: string; created: boolean }> {
    const name = normalizeSchoolName(input.name);
    const countryCode = normalizeCountryCode(input.countryCode);
    const city = normalizeCity(input.city);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const existing = await tx.school.findFirst({ where: { country_code: countryCode, name } });
      if (existing) return { id: existing.id as string, created: false };
      const school = await tx.school.create({ data: { name, country_code: countryCode, city } });
      await this.audit(tx, 'school.registry.school_added', 'school', school.id, input.operator, { countryCode });
      return { id: school.id as string, created: true };
    });
  }

  async addAlias(input: { schoolId: string; alias: string; operator: string }): Promise<{ added: boolean }> {
    const alias = normalizeSchoolName(input.alias);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.requireSchool(tx, input.schoolId);
      const existing = await tx.school_alias.findFirst({ where: { school_id: input.schoolId, alias } });
      if (existing) return { added: false };
      await tx.school_alias.create({ data: { school_id: input.schoolId, alias } });
      await this.audit(tx, 'school.registry.alias_added', 'school', input.schoolId, input.operator, {});
      return { added: true };
    });
  }

  async addBranch(input: { schoolId: string; name: string; city?: string; operator: string }): Promise<{ id: string; created: boolean }> {
    const name = normalizeSchoolName(input.name);
    const city = normalizeCity(input.city);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.requireSchool(tx, input.schoolId);
      const existing = await tx.school_branch.findFirst({ where: { school_id: input.schoolId, name } });
      if (existing) return { id: existing.id as string, created: false };
      const branch = await tx.school_branch.create({ data: { school_id: input.schoolId, name, city } });
      await this.audit(tx, 'school.registry.branch_added', 'school_branch', branch.id, input.operator, { schoolId: input.schoolId });
      return { id: branch.id as string, created: true };
    });
  }

  /** Retiring hides a school from search; students already associated keep their history. */
  async retireSchool(input: { schoolId: string; operator: string }): Promise<{ retired: boolean }> {
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const school = await this.requireSchool(tx, input.schoolId);
      if (school.status === 'RETIRED') return { retired: false };
      await tx.school.update({ where: { id: input.schoolId }, data: { status: 'RETIRED' } });
      await this.audit(tx, 'school.registry.school_retired', 'school', input.schoolId, input.operator, {});
      return { retired: true };
    });
  }

  listSchools(): Promise<Array<{ id: string; name: string; countryCode: string; city: string | null; status: string }>> {
    return this.db.client.school
      .findMany({ orderBy: [{ country_code: 'asc' }, { name: 'asc' }] })
      .then((rows: any[]) =>
        rows.map((r) => ({ id: r.id, name: r.name, countryCode: r.country_code, city: r.city, status: r.status })),
      );
  }

  listPendingCandidates(): Promise<Array<{ id: string; nameAsEntered: string; countryCode: string; createdAt: Date }>> {
    return this.db.client.school_candidate
      .findMany({ where: { status: 'PENDING' }, orderBy: { created_at: 'asc' } })
      .then((rows: any[]) =>
        rows.map((r) => ({ id: r.id, nameAsEntered: r.name_as_entered, countryCode: r.country_code, createdAt: r.created_at })),
      );
  }

  /**
   * accept: the student's text becomes an alias of a registry school and any OPEN association
   * moves onto that school (STUDENT_SELECTED: the student's own statement, now matched).
   * reject: open associations on the candidate end, so the student can choose again.
   * Ended associations are history and are never rewritten.
   */
  async resolveCandidate(input: { candidateId: string; decision: CandidateDecision; operator: string }): Promise<void> {
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const candidate = await tx.school_candidate.findUnique({ where: { id: input.candidateId } });
      if (!candidate || candidate.status !== 'PENDING') throw new CandidateNotPendingError();
      const now = new Date();

      if (input.decision.action === 'accept') {
        const school = await this.requireSchool(tx, input.decision.schoolId);
        await tx.school_candidate.update({
          where: { id: candidate.id },
          data: { status: 'ACCEPTED', resolved_school_id: school.id, resolved_by: input.operator, resolved_at: now },
        });
        if (candidate.name_as_entered !== school.name) {
          const hasAlias = await tx.school_alias.findFirst({ where: { school_id: school.id, alias: candidate.name_as_entered } });
          if (!hasAlias) await tx.school_alias.create({ data: { school_id: school.id, alias: candidate.name_as_entered } });
        }
        await tx.student_school_association.updateMany({
          where: { candidate_id: candidate.id, ended_at: null },
          data: { school_id: school.id, candidate_id: null, state: 'STUDENT_SELECTED' },
        });
        await this.audit(tx, 'school.registry.candidate_accepted', 'school_candidate', candidate.id, input.operator, { schoolId: school.id });
      } else {
        await tx.school_candidate.update({
          where: { id: candidate.id },
          data: { status: 'REJECTED', resolved_by: input.operator, resolved_at: now },
        });
        await tx.student_school_association.updateMany({
          where: { candidate_id: candidate.id, ended_at: null },
          data: { ended_at: now, end_reason: 'CANDIDATE_REJECTED' },
        });
        await this.audit(tx, 'school.registry.candidate_rejected', 'school_candidate', candidate.id, input.operator, {});
      }
    });
  }

  private async requireSchool(tx: Prisma.TransactionClient, schoolId: string) {
    const school = await tx.school.findUnique({ where: { id: schoolId } });
    if (!school) throw new SchoolNotFoundError();
    return school;
  }

  private audit(
    tx: Prisma.TransactionClient,
    action: string,
    subjectType: string,
    subjectId: string,
    operator: string,
    metadata: Record<string, unknown>,
  ) {
    return tx.audit_event.create({
      data: { actor_account_id: null, action, subject_type: subjectType, subject_id: subjectId, metadata: { ...metadata, operator } as Prisma.InputJsonValue },
    });
  }
}
