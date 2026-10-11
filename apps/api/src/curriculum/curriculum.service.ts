import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  CurriculumConflictError,
  CurriculumForbiddenError,
  CurriculumNotFoundError,
} from './curriculum.errors';
import {
  CurriculumTransitionError,
  assertTransition,
  isValidActor,
  stateAfterEdit,
  type CurriculumActor,
  type CurriculumState,
} from './curriculum-state';
import {
  hasErrors,
  validateCurriculumTree,
  type CurriculumTree,
  type ValidationFinding,
} from './curriculum-validation';

/** Transitions that have a dedicated method with extra guards; `transition()` refuses them. */
const DEDICATED: CurriculumState[] = ['VALIDATED', 'APPROVED', 'ACTIVE', 'SUPERSEDED'];
const OPEN_STATES: CurriculumState[] = [
  'DISCOVERED',
  'EVIDENCE_COLLECTION',
  'DRAFT',
  'AI_STRUCTURED',
  'VALIDATION_PENDING',
  'VALIDATED',
  'ADMIN_REVIEW',
  'CHANGES_REQUIRED',
  'APPROVED',
];
const LIVE_STATES: CurriculumState[] = ['ACTIVE', 'ACTIVE_WITH_REVIEW', 'SUSPENDED'];

export interface SubjectVersionKey {
  curriculumCode: string;
  curriculumName: string;
  versionLabel: string;
  gradeCode: string;
  subjectCode: string;
  subjectName: string;
}

/**
 * Domain 03 — Curriculum Governance machinery (Build Sequence step 4).
 * Holds no syllabus content. Not exposed over HTTP in this block: the authorization
 * layer (01c) is not wired to HTTP yet, so roles arrive as an explicit CurriculumActor
 * from trusted in-process callers, and are enforced here by assertTransition.
 */
@Injectable()
export class CurriculumService {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
  ) {}

  /** First revision of a Curriculum + Version + Grade + Subject unit, in DRAFT. */
  async createSubjectVersion(
    key: SubjectVersionKey,
    actor: CurriculumActor,
  ): Promise<{ id: string; revision: number }> {
    this.assertMayEdit(actor);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const curriculum = await tx.curriculum.upsert({
        where: { code: key.curriculumCode },
        update: {},
        create: { code: key.curriculumCode, name: key.curriculumName },
      });
      const version = await tx.curriculum_version.upsert({
        where: { curriculum_id_label: { curriculum_id: curriculum.id, label: key.versionLabel } },
        update: {},
        create: { curriculum_id: curriculum.id, label: key.versionLabel },
      });
      const grade = await tx.grade.upsert({
        where: { code: key.gradeCode },
        update: {},
        create: { code: key.gradeCode, sort_order: gradeOrder(key.gradeCode) },
      });
      const subject = await tx.subject.upsert({
        where: { code: key.subjectCode },
        update: {},
        create: { code: key.subjectCode, name: key.subjectName },
      });

      const existing = await tx.curriculum_subject_version.findFirst({
        where: { curriculum_version_id: version.id, grade_id: grade.id, subject_id: subject.id },
      });
      if (existing) {
        throw new CurriculumConflictError(
          'this unit already has a revision; create a correction revision instead',
        );
      }
      const created = await tx.curriculum_subject_version.create({
        data: {
          curriculum_version_id: version.id,
          grade_id: grade.id,
          subject_id: subject.id,
          revision: 1,
          state: 'DRAFT',
          last_edited_by: actor.accountId,
        },
      });
      await this.log(tx, created.id, 'created', null, 'DRAFT', actor, null);
      return { id: created.id as string, revision: 1 };
    });
  }

  /**
   * A correction to an activated unit is a NEW revision; the activated one is never
   * edited. Content and evidence are copied; the new evidence pack must be verified again.
   */
  async createCorrectionRevision(
    sourceId: string,
    actor: CurriculumActor,
  ): Promise<{ id: string; revision: number }> {
    this.assertMayEdit(actor);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      await this.lock(tx, sourceId);
      const source = await tx.curriculum_subject_version.findUnique({
        where: { id: sourceId },
        include: {
          evidence_packs: { include: { references: true } },
          chapters: {
            orderBy: { position: 'asc' },
            include: {
              topics: {
                orderBy: { position: 'asc' },
                include: {
                  micro_concepts: {
                    orderBy: { position: 'asc' },
                    include: { learning_objectives: { orderBy: { position: 'asc' } } },
                  },
                },
              },
            },
          },
        },
      });
      if (!source) throw new CurriculumNotFoundError('subject version');
      if (!LIVE_STATES.includes(source.state)) {
        throw new CurriculumConflictError(
          `only an activated revision can be corrected (is ${source.state})`,
        );
      }
      const siblings = await tx.curriculum_subject_version.findMany({
        where: {
          curriculum_version_id: source.curriculum_version_id,
          grade_id: source.grade_id,
          subject_id: source.subject_id,
        },
      });
      if (siblings.some((s: { state: CurriculumState }) => OPEN_STATES.includes(s.state))) {
        throw new CurriculumConflictError('an open revision already exists for this unit');
      }
      const revision = Math.max(...siblings.map((s: { revision: number }) => s.revision)) + 1;

      const created = await tx.curriculum_subject_version.create({
        data: {
          curriculum_version_id: source.curriculum_version_id,
          grade_id: source.grade_id,
          subject_id: source.subject_id,
          revision,
          state: 'DRAFT',
          supersedes_id: source.id,
          last_edited_by: actor.accountId,
        },
      });

      // Copy evidence (unverified), remembering old -> new reference ids.
      const refMap = new Map<string, string>();
      const pack = source.evidence_packs[0];
      if (pack) {
        const newPack = await tx.curriculum_evidence_pack.create({
          data: { subject_version_id: created.id, status: 'DRAFT' },
        });
        for (const r of pack.references) {
          const nr = await tx.curriculum_evidence_reference.create({
            data: {
              pack_id: newPack.id,
              source_title: r.source_title,
              source_url: r.source_url,
              locator: r.locator,
              retrieved_at: r.retrieved_at,
            },
          });
          refMap.set(r.id, nr.id);
        }
      }
      const mapRef = (id: string | null) => (id ? (refMap.get(id) ?? id) : null);
      await this.writeTree(tx, created.id, treeFromRows(source.chapters, mapRef));

      await this.log(tx, created.id, 'correction_revision_created', null, 'DRAFT', actor, `of revision ${source.revision}`);
      return { id: created.id as string, revision };
    });
  }

  /** Add an official-source pointer. Evidence changes are material: validation reopens and the pack is unverified. */
  async addEvidenceReference(
    subjectVersionId: string,
    ref: { sourceTitle: string; sourceUrl?: string | null; locator?: string | null; retrievedAt?: Date | null },
    actor: CurriculumActor,
  ): Promise<{ referenceId: string }> {
    this.assertMayEdit(actor);
    if (ref.sourceTitle.trim() === '') throw new CurriculumConflictError('source title is required');
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      const next = stateAfterEdit(sv.state);
      let pack = await tx.curriculum_evidence_pack.findFirst({ where: { subject_version_id: sv.id } });
      if (!pack) {
        pack = await tx.curriculum_evidence_pack.create({ data: { subject_version_id: sv.id } });
      } else if (pack.status === 'VERIFIED') {
        await tx.curriculum_evidence_pack.update({
          where: { id: pack.id },
          data: { status: 'DRAFT', verified_by: null, verification_note: null, verified_at: null },
        });
      }
      const created = await tx.curriculum_evidence_reference.create({
        data: {
          pack_id: pack.id,
          source_title: ref.sourceTitle.trim(),
          source_url: ref.sourceUrl ?? null,
          locator: ref.locator ?? null,
          retrieved_at: ref.retrievedAt ?? null,
        },
      });
      await this.afterEdit(tx, sv, next, actor, 'evidence_added');
      return { referenceId: created.id as string };
    });
  }

  /** A human attests that the pack's sources are the genuine official ones. Required before activation. */
  async verifyEvidencePack(
    subjectVersionId: string,
    note: string,
    actor: CurriculumActor,
  ): Promise<void> {
    if (!isValidActor(actor) || actor.kind !== 'HUMAN' || !['REVIEWER', 'APPROVER', 'SUPER_ADMIN'].includes(actor.role ?? '')) {
      throw new CurriculumForbiddenError('only a human reviewer, approver or super admin can verify evidence');
    }
    if (note.trim() === '') throw new CurriculumConflictError('a verification note is required');
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      const pack = await tx.curriculum_evidence_pack.findFirst({
        where: { subject_version_id: sv.id },
        include: { references: true },
      });
      if (!pack || pack.references.length === 0) {
        throw new CurriculumConflictError('the evidence pack has no references to verify');
      }
      await tx.curriculum_evidence_pack.update({
        where: { id: pack.id },
        data: {
          status: 'VERIFIED',
          verified_by: actor.accountId,
          verification_note: note.trim(),
          verified_at: new Date(),
        },
      });
      await this.log(tx, sv.id, 'evidence_verified', sv.state, sv.state, actor, note.trim());
    });
  }

  /** Replace the whole content tree. A material edit: validation reopens if it had passed. */
  async replaceContent(
    subjectVersionId: string,
    tree: CurriculumTree,
    actor: CurriculumActor,
  ): Promise<{ state: CurriculumState }> {
    this.assertMayEdit(actor);
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      const next = stateAfterEdit(sv.state); // throws if ACTIVE or later
      await tx.chapter.deleteMany({ where: { subject_version_id: sv.id } });
      await this.writeTree(tx, sv.id, tree);
      await this.afterEdit(tx, sv, next, actor, 'content_replaced');
      return { state: next };
    });
  }

  /** Human/AI workflow steps that need no extra guard beyond the state machine. */
  async transition(
    subjectVersionId: string,
    to: CurriculumState,
    actor: CurriculumActor,
    note: string | null = null,
  ): Promise<void> {
    if (DEDICATED.includes(to)) {
      throw new CurriculumTransitionError(`use the dedicated operation to reach ${to}`);
    }
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      if (to === 'VALIDATION_PENDING' && !(await this.hasEvidenceAndContent(tx, sv.id))) {
        throw new CurriculumConflictError('add evidence and content before requesting validation');
      }
      await this.move(tx, sv, to, actor, note);
    });
  }

  /** Automated validation (SYSTEM). Records the run and moves to VALIDATED or CHANGES_REQUIRED. */
  async runValidation(subjectVersionId: string): Promise<{ passed: boolean; findings: ValidationFinding[] }> {
    const system: CurriculumActor = { kind: 'SYSTEM', accountId: null, role: null };
    return this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      if (sv.state !== 'VALIDATION_PENDING') {
        throw new CurriculumConflictError(`validation runs only in VALIDATION_PENDING (is ${sv.state})`);
      }
      const packRefs = await tx.curriculum_evidence_reference.findMany({
        where: { pack: { subject_version_id: sv.id } },
        select: { id: true },
      });
      const rows = await this.readChapters(tx, sv.id);
      const findings = validateCurriculumTree(treeFromRows(rows, (x) => x), {
        referenceIds: new Set(packRefs.map((r: { id: string }) => r.id)),
      });
      const errors = findings.filter((f) => f.severity === 'ERROR').length;
      const passed = !hasErrors(findings);

      await tx.curriculum_validation_run.create({
        data: {
          subject_version_id: sv.id,
          status: passed ? 'PASSED' : 'FAILED',
          error_count: errors,
          warning_count: findings.length - errors,
          results: {
            create: findings.map((f) => ({
              severity: f.severity,
              rule: f.rule,
              path: f.path.slice(0, 500),
              message: f.message.slice(0, 1000),
            })),
          },
        },
      });
      await this.move(tx, sv, passed ? 'VALIDATED' : 'CHANGES_REQUIRED', system, null);
      return { passed, findings };
    });
  }

  /** ADMIN_REVIEW -> APPROVED. Approval is not activation. */
  async approve(subjectVersionId: string, actor: CurriculumActor, note: string | null = null): Promise<void> {
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      assertTransition(sv.state, 'APPROVED', actor);
      await tx.curriculum_approval_record.create({
        data: {
          subject_version_id: sv.id,
          decision: 'APPROVED',
          actor_account_id: actor.accountId as string,
          note,
        },
      });
      await this.move(tx, sv, 'APPROVED', actor, note);
    });
  }

  /**
   * APPROVED -> ACTIVE: its own authorized-human act. Requires a verified evidence pack.
   * Any previously live revision of the same unit becomes SUPERSEDED in the same transaction.
   */
  async activate(subjectVersionId: string, actor: CurriculumActor): Promise<void> {
    await this.db.client.$transaction(async (tx: Prisma.TransactionClient) => {
      const sv = await this.load(tx, subjectVersionId);
      assertTransition(sv.state, 'ACTIVE', actor); // human + APPROVER/SUPER_ADMIN, from APPROVED only

      const pack = await tx.curriculum_evidence_pack.findFirst({ where: { subject_version_id: sv.id } });
      if (!pack || pack.status !== 'VERIFIED') {
        throw new CurriculumConflictError('the evidence pack must be VERIFIED before activation');
      }

      const system: CurriculumActor = { kind: 'SYSTEM', accountId: null, role: null };
      const live = await tx.curriculum_subject_version.findMany({
        where: {
          curriculum_version_id: sv.curriculum_version_id,
          grade_id: sv.grade_id,
          subject_id: sv.subject_id,
          state: { in: LIVE_STATES },
          NOT: { id: sv.id },
        },
      });
      for (const old of live) {
        await this.lock(tx, old.id);
        await this.move(tx, old, 'SUPERSEDED', system, `superseded by revision ${sv.revision}`);
      }

      await tx.curriculum_activation_record.create({
        data: { subject_version_id: sv.id, actor_account_id: actor.accountId as string },
      });
      await tx.curriculum_subject_version.update({
        where: { id: sv.id },
        data: { activated_at: new Date() },
      });
      await this.move(tx, sv, 'ACTIVE', actor, null);
    });
  }

  /**
   * The only read other domains (e.g. school plans) may use: strictly ACTIVE content.
   * Returns null if the unit has no ACTIVE revision, so callers cannot reference drafts.
   */
  async getActiveTree(key: {
    curriculumCode: string;
    versionLabel: string;
    gradeCode: string;
    subjectCode: string;
  }): Promise<{ subjectVersionId: string; revision: number; tree: CurriculumTree } | null> {
    const sv = await this.db.client.curriculum_subject_version.findFirst({
      where: {
        state: 'ACTIVE',
        grade: { code: key.gradeCode },
        subject: { code: key.subjectCode },
        curriculum_version: { label: key.versionLabel, curriculum: { code: key.curriculumCode } },
      },
    });
    if (!sv) return null;
    const rows = await this.readChapters(this.db.client, sv.id);
    return { subjectVersionId: sv.id, revision: sv.revision, tree: treeFromRows(rows, (x) => x) };
  }

  // ---------------------------------------------------------------- internals

  private assertMayEdit(actor: CurriculumActor): void {
    const ok =
      isValidActor(actor) &&
      ((actor.kind === 'HUMAN' && (actor.role === 'EDITOR' || actor.role === 'SUPER_ADMIN')) ||
        actor.kind === 'AI');
    if (!ok) throw new CurriculumForbiddenError('actor may not edit curriculum content');
  }

  private async lock(tx: Prisma.TransactionClient, id: string): Promise<void> {
    await tx.$queryRaw`SELECT id FROM curriculum_subject_version WHERE id = ${id}::uuid FOR UPDATE`;
  }

  private async load(tx: Prisma.TransactionClient, id: string) {
    await this.lock(tx, id);
    const sv = await tx.curriculum_subject_version.findUnique({ where: { id } });
    if (!sv) throw new CurriculumNotFoundError('subject version');
    return sv as {
      id: string;
      state: CurriculumState;
      revision: number;
      curriculum_version_id: string;
      grade_id: string;
      subject_id: string;
    };
  }

  private async hasEvidenceAndContent(tx: Prisma.TransactionClient, id: string): Promise<boolean> {
    const refs = await tx.curriculum_evidence_reference.count({ where: { pack: { subject_version_id: id } } });
    const chapters = await tx.chapter.count({ where: { subject_version_id: id } });
    return refs > 0 && chapters > 0;
  }

  /** Apply a state change: assert, update, append to the event log, emit an outbox event. */
  private async move(
    tx: Prisma.TransactionClient,
    sv: { id: string; state: CurriculumState },
    to: CurriculumState,
    actor: CurriculumActor,
    note: string | null,
  ): Promise<void> {
    assertTransition(sv.state, to, actor);
    await tx.curriculum_subject_version.update({ where: { id: sv.id }, data: { state: to } });
    const logId = await this.log(tx, sv.id, 'state_changed', sv.state, to, actor, note);
    await this.outbox.publish(tx, {
      aggregateType: 'curriculum_subject_version',
      aggregateId: sv.id,
      eventType: 'curriculum.subject_version.state_changed.v1',
      payload: { subjectVersionId: sv.id, from: sv.state, to },
      idempotencyKey: `curriculum-sv-state:${logId}`,
    });
  }

  /** Persist the result of a content edit: state (possibly reopened), editor, log. */
  private async afterEdit(
    tx: Prisma.TransactionClient,
    sv: { id: string; state: CurriculumState },
    next: CurriculumState,
    actor: CurriculumActor,
    eventType: string,
  ): Promise<void> {
    await tx.curriculum_subject_version.update({
      where: { id: sv.id },
      data: { state: next, last_edited_by: actor.accountId },
    });
    await this.log(tx, sv.id, eventType, sv.state, next, actor, next !== sv.state ? 'validation reopened' : null);
  }

  private async log(
    tx: Prisma.TransactionClient,
    subjectVersionId: string,
    eventType: string,
    from: CurriculumState | null,
    to: CurriculumState | null,
    actor: CurriculumActor,
    note: string | null,
  ): Promise<string> {
    const row = await tx.curriculum_event_log.create({
      data: {
        subject_version_id: subjectVersionId,
        event_type: eventType,
        from_state: from,
        to_state: to,
        actor_kind: actor.kind,
        actor_account_id: actor.accountId,
        note,
      },
    });
    return row.id as string;
  }

  private readChapters(tx: Prisma.TransactionClient | DatabaseService['client'], subjectVersionId: string) {
    return tx.chapter.findMany({
      where: { subject_version_id: subjectVersionId },
      orderBy: { position: 'asc' },
      include: {
        topics: {
          orderBy: { position: 'asc' },
          include: {
            micro_concepts: {
              orderBy: { position: 'asc' },
              include: { learning_objectives: { orderBy: { position: 'asc' } } },
            },
          },
        },
      },
    });
  }

  private async writeTree(tx: Prisma.TransactionClient, subjectVersionId: string, tree: CurriculumTree) {
    for (const ch of tree.chapters) {
      await tx.chapter.create({
        data: {
          subject_version_id: subjectVersionId,
          code: ch.code,
          title: ch.title,
          position: ch.position,
          provenance: ch.provenance,
          evidence_reference_id: ch.evidenceReferenceId,
          rationale: ch.rationale,
          topics: {
            create: ch.topics.map((tp) => ({
              code: tp.code,
              title: tp.title,
              position: tp.position,
              provenance: tp.provenance,
              evidence_reference_id: tp.evidenceReferenceId,
              rationale: tp.rationale,
              micro_concepts: {
                create: tp.microConcepts.map((mc) => ({
                  code: mc.code,
                  title: mc.title,
                  position: mc.position,
                  provenance: mc.provenance,
                  evidence_reference_id: mc.evidenceReferenceId,
                  rationale: mc.rationale,
                  learning_objectives: {
                    create: mc.learningObjectives.map((lo) => ({
                      code: lo.code,
                      statement: lo.statement,
                      position: lo.position,
                      provenance: lo.provenance,
                      evidence_reference_id: lo.evidenceReferenceId,
                      rationale: lo.rationale,
                    })),
                  },
                })),
              },
            })),
          },
        },
      });
    }
  }
}

function gradeOrder(code: string): number {
  const m = /(\d+)/.exec(code);
  return m ? Number(m[1]) : 0;
}

type Mapper = (id: string | null) => string | null;
/* eslint-disable @typescript-eslint/no-explicit-any */
function treeFromRows(chapters: any[], mapRef: Mapper): CurriculumTree {
  const base = (r: any) => ({
    code: r.code as string,
    position: r.position as number,
    provenance: r.provenance,
    evidenceReferenceId: mapRef(r.evidence_reference_id ?? null),
    rationale: (r.rationale ?? null) as string | null,
  });
  return {
    chapters: chapters.map((c: any) => ({
      ...base(c),
      title: c.title,
      topics: c.topics.map((t: any) => ({
        ...base(t),
        title: t.title,
        microConcepts: t.micro_concepts.map((m: any) => ({
          ...base(m),
          title: m.title,
          learningObjectives: m.learning_objectives.map((l: any) => ({
            ...base(l),
            statement: l.statement,
          })),
        })),
      })),
    })),
  };
}
