import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { ChapterCatalogueService } from './chapter-catalogue.service';
import { normalizeAcademicYear, normalizeCode, normalizePlanLabel } from './plan-domain';
import { ChapterNotFoundError, PlanEmptyError, PlanNotEditableError, PlanNotFoundError } from './plan.errors';
import { SchoolNotFoundError, NotInLaunchCohortError } from './school.errors';
import { isLaunchCohort } from './school-domain';

export interface PlanSummary {
  id: string;
  schoolName: string;
  curriculumCode: string;
  gradeCode: string;
  academicYear: string;
  status: string;
  entries: Array<{ termLabel: string; assessmentLabel: string; subjectCode: string; chapterCode: string }>;
}

/**
 * Operator-side school plans (Domain 04). A plan is what a particular school told us for one academic year.
 * Term and assessment names are the school's own words; there is no universal Term 1 / Term 2 mapping.
 * Every chapter is checked against the canonical curriculum when it is entered. Nothing is invented.
 */
@Injectable()
export class SchoolPlanService {
  constructor(
    private readonly db: DatabaseService,
    private readonly catalogue: ChapterCatalogueService,
  ) {}

  async createPlan(input: { schoolId: string; curriculumCode: string; gradeCode: string; academicYear: string; operator: string }): Promise<{ id: string; created: boolean }> {
    const academicYear = normalizeAcademicYear(input.academicYear);
    if (!isLaunchCohort(input.curriculumCode, input.gradeCode)) throw new NotInLaunchCohortError();
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const school = await tx.school.findFirst({ where: { id: input.schoolId } });
      if (!school) throw new SchoolNotFoundError();
      const existing = await tx.school_academic_plan.findFirst({
        where: { school_id: school.id, curriculum_code: input.curriculumCode, grade_code: input.gradeCode, academic_year: academicYear },
      });
      if (existing) return { id: existing.id as string, created: false };
      const plan = await tx.school_academic_plan.create({
        data: { school_id: school.id, curriculum_code: input.curriculumCode, grade_code: input.gradeCode, academic_year: academicYear, created_by: input.operator },
      });
      await this.audit(tx, 'school.plan.created', plan.id, input.operator, { schoolId: school.id, academicYear });
      return { id: plan.id as string, created: true };
    });
  }

  async addEntry(input: { planId: string; termLabel: string; assessmentLabel?: string; subjectCode: string; chapterCode: string; operator: string }): Promise<{ added: boolean }> {
    const termLabel = normalizePlanLabel(input.termLabel, 'Term', 40, true);
    const assessmentLabel = normalizePlanLabel(input.assessmentLabel, 'Assessment', 60, false);
    const subjectCode = normalizeCode(input.subjectCode, 'subjectCode');
    const chapterCode = normalizeCode(input.chapterCode, 'chapterCode');
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const plan = await this.requireEditable(tx, input.planId);
      if (!(await this.catalogue.has(plan.curriculum_code, plan.grade_code, subjectCode, chapterCode))) {
        throw new ChapterNotFoundError(subjectCode, chapterCode);
      }
      const existing = await tx.school_plan_entry.findFirst({
        where: { plan_id: plan.id, term_label: termLabel, assessment_label: assessmentLabel, subject_code: subjectCode, chapter_code: chapterCode },
      });
      if (existing) return { added: false };
      const position = await tx.school_plan_entry.count({ where: { plan_id: plan.id } });
      await tx.school_plan_entry.create({
        data: { plan_id: plan.id, term_label: termLabel, assessment_label: assessmentLabel, subject_code: subjectCode, chapter_code: chapterCode, position },
      });
      await this.audit(tx, 'school.plan.entry_added', plan.id, input.operator, { termLabel, assessmentLabel, subjectCode, chapterCode });
      return { added: true };
    });
  }

  async removeEntry(input: { planId: string; termLabel: string; assessmentLabel?: string; subjectCode: string; chapterCode: string; operator: string }): Promise<{ removed: boolean }> {
    const termLabel = normalizePlanLabel(input.termLabel, 'Term', 40, true);
    const assessmentLabel = normalizePlanLabel(input.assessmentLabel, 'Assessment', 60, false);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const plan = await this.requireEditable(tx, input.planId);
      const r = await tx.school_plan_entry.deleteMany({
        where: { plan_id: plan.id, term_label: termLabel, assessment_label: assessmentLabel, subject_code: input.subjectCode, chapter_code: input.chapterCode },
      });
      if (r.count === 0) return { removed: false };
      await this.audit(tx, 'school.plan.entry_removed', plan.id, input.operator, { termLabel, assessmentLabel, subjectCode: input.subjectCode, chapterCode: input.chapterCode });
      return { removed: true };
    });
  }

  /** Only a published plan is ever offered to students. */
  async publish(input: { planId: string; operator: string }): Promise<{ published: boolean }> {
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const plan = await this.require(tx, input.planId);
      if (plan.status === 'PUBLISHED') return { published: false };
      const n = await tx.school_plan_entry.count({ where: { plan_id: plan.id } });
      if (n === 0) throw new PlanEmptyError();
      await tx.school_academic_plan.update({ where: { id: plan.id }, data: { status: 'PUBLISHED', published_at: new Date() } });
      await this.audit(tx, 'school.plan.published', plan.id, input.operator, { entries: n });
      return { published: true };
    });
  }

  async reopen(input: { planId: string; operator: string }): Promise<{ reopened: boolean }> {
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const plan = await this.require(tx, input.planId);
      if (plan.status === 'DRAFT') return { reopened: false };
      await tx.school_academic_plan.update({ where: { id: plan.id }, data: { status: 'DRAFT', published_at: null } });
      await this.audit(tx, 'school.plan.reopened', plan.id, input.operator, {});
      return { reopened: true };
    });
  }

  async show(planId: string): Promise<PlanSummary> {
    const plan = await (this.db.client as any).school_academic_plan.findFirst({
      where: { id: planId },
      include: { school: true, entries: { orderBy: { position: 'asc' } } },
    });
    if (!plan) throw new PlanNotFoundError();
    return {
      id: plan.id,
      schoolName: plan.school.name,
      curriculumCode: plan.curriculum_code,
      gradeCode: plan.grade_code,
      academicYear: plan.academic_year,
      status: plan.status,
      entries: plan.entries.map((e: any) => ({ termLabel: e.term_label, assessmentLabel: e.assessment_label, subjectCode: e.subject_code, chapterCode: e.chapter_code })),
    };
  }

  async list(schoolId?: string): Promise<Array<{ id: string; schoolName: string; academicYear: string; gradeCode: string; status: string; entries: number }>> {
    const rows = await (this.db.client as any).school_academic_plan.findMany({
      where: schoolId ? { school_id: schoolId } : {},
      include: { school: true, _count: { select: { entries: true } } },
      orderBy: [{ academic_year: 'desc' }],
    });
    return rows.map((r: any) => ({ id: r.id, schoolName: r.school.name, academicYear: r.academic_year, gradeCode: r.grade_code, status: r.status, entries: r._count.entries }));
  }

  /** The canonical chapter codes an operator may use. */
  chapters(curriculumCode: string, gradeCode: string) {
    return this.catalogue.forCohort(curriculumCode, gradeCode);
  }

  private async require(tx: Prisma.TransactionClient, planId: string) {
    const plan = await tx.school_academic_plan.findFirst({ where: { id: planId } });
    if (!plan) throw new PlanNotFoundError();
    return plan;
  }

  private async requireEditable(tx: Prisma.TransactionClient, planId: string) {
    const plan = await this.require(tx, planId);
    if (plan.status !== 'DRAFT') throw new PlanNotEditableError();
    return plan;
  }

  private audit(tx: Prisma.TransactionClient, action: string, subjectId: string, operator: string, metadata: Record<string, unknown>) {
    return tx.audit_event.create({
      data: { actor_account_id: null, action, subject_type: 'school_academic_plan', subject_id: subjectId, metadata: { ...metadata, operator } as Prisma.InputJsonValue },
    });
  }
}
