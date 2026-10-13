import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { StudentService } from '../student/student.service';
import { ChapterCatalogueService } from './chapter-catalogue.service';
import { parseSelection, type ChapterRef } from './plan-domain';
import { ChapterNotFoundError, GradeNotSetError } from './plan.errors';

export interface ChaptersView {
  subjects: Array<{
    subjectCode: string;
    subjectName: string;
    chapters: Array<{ code: string; title: string; selected: boolean; suggested: boolean }>;
  }>;
  /** A suggestion only. It never selects anything and never limits what the student may choose. */
  schoolPlan: null | {
    schoolName: string;
    academicYear: string;
    groups: Array<{ termLabel: string; assessmentLabel: string; chapters: ChapterRef[] }>;
  };
}

/**
 * The student's own chapter focus (Domain 04). Fail-closed like every other collection of student data:
 * refused while guardian consent is required and not given. A school's plan, when one exists for the
 * school the student selected, is shown as a suggestion; it is never applied automatically, and the
 * student's school association (unverified) grants the school nothing.
 */
@Injectable()
export class StudentChaptersService {
  constructor(
    private readonly db: DatabaseService,
    private readonly students: StudentService,
    private readonly catalogue: ChapterCatalogueService,
    private readonly outbox: OutboxService,
  ) {}

  async view(accountId: string): Promise<ChaptersView> {
    const studentId = await this.students.studentIdForDataCollection(accountId);
    return this.build(this.db.client as unknown as Prisma.TransactionClient, studentId);
  }

  /** Replaces the whole selection. Every chapter must exist in the student's own curriculum and grade. */
  async setSelection(accountId: string, raw: unknown): Promise<ChaptersView> {
    const refs = parseSelection(raw);
    const studentId = await this.students.studentIdForDataCollection(accountId);
    const ctx = await this.context(this.db.client as unknown as Prisma.TransactionClient, studentId);
    const cat = await this.catalogue.forCohort(ctx.curriculum_code, ctx.grade_code);
    for (const r of refs) {
      const ok = cat.some((s) => s.subjectCode === r.subjectCode && s.chapters.some((c) => c.code === r.chapterCode));
      if (!ok) throw new ChapterNotFoundError(r.subjectCode, r.chapterCode);
    }
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await tx.student_chapter_selection.deleteMany({ where: { student_id: studentId } });
      if (refs.length) {
        await tx.student_chapter_selection.createMany({
          data: refs.map((r) => ({ student_id: studentId, subject_code: r.subjectCode, chapter_code: r.chapterCode })),
        });
      }
      await this.outbox.publish(tx, {
        aggregateType: 'student',
        aggregateId: studentId,
        eventType: 'student.chapter_selection.set.v1',
        payload: { studentId, count: refs.length },
        idempotencyKey: `chapter-selection:${studentId}:${randomUUID()}`,
      });
      await tx.audit_event.create({
        data: { actor_account_id: accountId, action: 'student.chapter_selection.set', subject_type: 'student', subject_id: studentId, metadata: { count: refs.length } },
      });
      return this.build(tx, studentId);
    });
  }

  private async context(tx: Prisma.TransactionClient, studentId: string) {
    const ctx = await tx.student_academic_context.findUnique({ where: { student_id: studentId } });
    if (!ctx) throw new GradeNotSetError();
    return ctx;
  }

  private async build(tx: Prisma.TransactionClient, studentId: string): Promise<ChaptersView> {
    const ctx = await this.context(tx, studentId);
    const [cat, picked, assoc] = await Promise.all([
      this.catalogue.forCohort(ctx.curriculum_code, ctx.grade_code),
      tx.student_chapter_selection.findMany({ where: { student_id: studentId } }),
      tx.student_school_association.findFirst({ where: { student_id: studentId, ended_at: null }, include: { school: true } }),
    ]);

    let schoolPlan: ChaptersView['schoolPlan'] = null;
    if (assoc?.school_id) {
      const plan = await tx.school_academic_plan.findFirst({
        where: { school_id: assoc.school_id, curriculum_code: ctx.curriculum_code, grade_code: ctx.grade_code, status: 'PUBLISHED' },
        orderBy: { academic_year: 'desc' },
        include: { entries: { orderBy: { position: 'asc' } } },
      });
      if (plan) {
        const groups = new Map<string, { termLabel: string; assessmentLabel: string; chapters: ChapterRef[] }>();
        for (const e of plan.entries as any[]) {
          const key = `${e.term_label}|${e.assessment_label}`;
          if (!groups.has(key)) groups.set(key, { termLabel: e.term_label, assessmentLabel: e.assessment_label, chapters: [] });
          groups.get(key)!.chapters.push({ subjectCode: e.subject_code, chapterCode: e.chapter_code });
        }
        schoolPlan = { schoolName: assoc.school.name, academicYear: plan.academic_year, groups: [...groups.values()] };
      }
    }

    const selected = new Set((picked as any[]).map((p) => `${p.subject_code}|${p.chapter_code}`));
    const suggested = new Set((schoolPlan?.groups ?? []).flatMap((g) => g.chapters.map((c) => `${c.subjectCode}|${c.chapterCode}`)));
    return {
      subjects: cat.map((s) => ({
        subjectCode: s.subjectCode,
        subjectName: s.subjectName,
        chapters: s.chapters.map((c) => ({
          code: c.code,
          title: c.title,
          selected: selected.has(`${s.subjectCode}|${c.code}`),
          suggested: suggested.has(`${s.subjectCode}|${c.code}`),
        })),
      })),
      schoolPlan,
    };
  }
}
