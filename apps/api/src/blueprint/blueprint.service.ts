import { randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import {
  InsufficientBankError,
  assemble,
  chapterOf,
  type AssemblyReport,
  type Cognitive,
  type Difficulty,
  type DecisionRequirement,
} from '../assembly/assembly-engine';
import { loadServablePool } from '../assembly/pool';
import { pickRole } from '../authz/roles';
import { AuthzService } from '../authz/authz.service';
import type { CurriculumRole } from '../curriculum/curriculum-state';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import {
  BLUEPRINT_EDIT_ROLES,
  BLUEPRINT_PUBLISH_ROLES,
  BLUEPRINT_READ_ROLES,
  BlueprintInputError,
  appliesTo,
  designOf,
  draftOf,
  draftProblems,
  parseDraft,
  parseHeader,
  resolveScope,
  type BlueprintDraft,
  type SubjectBinding,
} from './blueprint-domain';
import { BlueprintConflictError, BlueprintForbiddenError, BlueprintNotFoundError } from './blueprint.errors';
import { VERSION_PARTS } from './blueprint-store';

type Tx = Prisma.TransactionClient;
type VersionStatus = 'DRAFT' | 'PUBLISHED' | 'RETIRED';

export interface BlueprintSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  enabled: boolean;
  subject: SubjectBinding | null;
  published: { versionId: string; version: number; totalQuestions: number; publishedAt: string | null } | null;
  draft: { versionId: string; version: number } | null;
}

export interface BlueprintVersionView {
  versionId: string;
  version: number;
  status: VersionStatus;
  design: BlueprintDraft;
  createdAt: string;
  publishedAt: string | null;
  retiredAt: string | null;
  testsBuilt: number;
}

export interface BlueprintDetail extends BlueprintSummary {
  versions: BlueprintVersionView[];
}

export interface PreviewItem {
  position: number;
  code: string;
  stem: string;
  chapter: string;
  objectivePath: string;
  difficulty: Difficulty;
  cognitive: Cognitive | null;
  health: string;
  requirement: DecisionRequirement;
  reasons: string[];
  candidates: number;
}

export type PreviewResult =
  | { ok: true; blueprint: string; version: number; status: VersionStatus; unitId: string; seed: string; note: string | null; report: AssemblyReport; items: PreviewItem[] }
  | { ok: false; blueprint: string; version: number; status: VersionStatus; unitId: string; seed: string; note: string | null; available: number; needed: number };

const SEED = /^[A-Za-z0-9_-]{1,64}$/;
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);

/**
 * Assessment blueprints (Step 10). Roles are read from the database on every call. A published version is never
 * edited: a change is a new draft, and publishing it retires the version before. Switching a blueprint on is what
 * lets students be given it; the preview never writes anything and never needs a student.
 */
@Injectable()
export class BlueprintService {
  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly outbox: OutboxService,
  ) {}

  async list(accountId: string): Promise<BlueprintSummary[]> {
    await this.require(accountId, BLUEPRINT_READ_ROLES, 'only people with a curriculum role may see test designs');
    const rows: any[] = await this.db.client.assessment_blueprint.findMany({
      orderBy: { code: 'asc' },
      include: { versions: { where: { status: { in: ['DRAFT', 'PUBLISHED'] } } } },
    });
    return rows.map((b) => this.summary(b));
  }

  async detail(accountId: string, blueprintId: string): Promise<BlueprintDetail> {
    await this.require(accountId, BLUEPRINT_READ_ROLES, 'only people with a curriculum role may see test designs');
    return this.load(this.db.client as unknown as Tx, blueprintId);
  }

  /** A new blueprint, switched off, with its first draft. */
  async create(accountId: string, raw: unknown): Promise<BlueprintDetail> {
    const header = parseHeader(raw);
    const draft = parseDraft((raw as Record<string, unknown>).design);
    await this.require(accountId, BLUEPRINT_EDIT_ROLES, 'only people with a curriculum role may design tests');
    return this.db.client.$transaction(async (tx: Tx) => {
      await this.check(tx, draft, header.subject);
      if (await tx.assessment_blueprint.findUnique({ where: { code: header.code } })) {
        throw new BlueprintConflictError(`a blueprint with code ${header.code} already exists`);
      }
      const b = await tx.assessment_blueprint.create({
        data: {
          code: header.code,
          name: header.name,
          description: header.description,
          enabled: false,
          curriculum_code: header.subject?.curriculumCode ?? null,
          grade_code: header.subject?.gradeCode ?? null,
          subject_code: header.subject?.subjectCode ?? null,
          created_by: accountId,
        },
        select: { id: true },
      });
      await this.writeVersion(tx, b.id, 1, draft, accountId);
      await this.audit(tx, accountId, 'blueprint.created', b.id, { code: header.code });
      return this.load(tx, b.id);
    });
  }

  /** Saves the draft: replaces the open draft, or opens a new one numbered after the newest version. */
  async saveDraft(accountId: string, blueprintId: string, raw: unknown): Promise<BlueprintDetail> {
    const draft = parseDraft(raw);
    await this.require(accountId, BLUEPRINT_EDIT_ROLES, 'only people with a curriculum role may design tests');
    return this.db.client.$transaction(async (tx: Tx) => {
      const b = await this.lockBlueprint(tx, blueprintId);
      await this.check(tx, draft, this.binding(b));
      const versions: any[] = await tx.assessment_blueprint_version.findMany({ where: { blueprint_id: b.id }, select: { id: true, version: true, status: true } });
      const open = versions.find((v) => v.status === 'DRAFT');
      if (open) {
        await tx.assessment_blueprint_version.delete({ where: { id: open.id } });
        await this.writeVersion(tx, b.id, open.version, draft, accountId);
      } else {
        await this.writeVersion(tx, b.id, Math.max(0, ...versions.map((v) => v.version)) + 1, draft, accountId);
      }
      await this.audit(tx, accountId, 'blueprint.draft_saved', b.id, { code: b.code });
      return this.load(tx, b.id);
    });
  }

  async discardDraft(accountId: string, blueprintId: string): Promise<BlueprintDetail> {
    await this.require(accountId, BLUEPRINT_EDIT_ROLES, 'only people with a curriculum role may design tests');
    return this.db.client.$transaction(async (tx: Tx) => {
      const b = await this.lockBlueprint(tx, blueprintId);
      const draft = await tx.assessment_blueprint_version.findFirst({ where: { blueprint_id: b.id, status: 'DRAFT' }, select: { id: true, version: true } });
      if (!draft) throw new BlueprintConflictError('there is no draft to discard');
      await tx.assessment_blueprint_version.delete({ where: { id: draft.id } });
      await this.audit(tx, accountId, 'blueprint.draft_discarded', b.id, { code: b.code, version: draft.version });
      return this.load(tx, b.id);
    });
  }

  /** The draft becomes the published version; the version it replaces is retired. Tests already built keep theirs. */
  async publishDraft(accountId: string, blueprintId: string): Promise<BlueprintDetail> {
    await this.require(accountId, BLUEPRINT_PUBLISH_ROLES, 'only an approver may publish a test design');
    return this.db.client.$transaction(async (tx: Tx) => {
      const b = await this.lockBlueprint(tx, blueprintId);
      const draft: any = await tx.assessment_blueprint_version.findFirst({ where: { blueprint_id: b.id, status: 'DRAFT' }, include: VERSION_PARTS });
      if (!draft) throw new BlueprintConflictError('there is no draft to publish');
      // The rules may have changed, or the curriculum may have lost a chapter, since the draft was saved.
      await this.check(tx, draftOf(draft), this.binding(b));
      const now = new Date();
      const old = await tx.assessment_blueprint_version.findFirst({ where: { blueprint_id: b.id, status: 'PUBLISHED' }, select: { id: true, version: true } });
      if (old) await tx.assessment_blueprint_version.update({ where: { id: old.id }, data: { status: 'RETIRED', retired_at: now } });
      await tx.assessment_blueprint_version.update({ where: { id: draft.id }, data: { status: 'PUBLISHED', published_by: accountId, published_at: now } });
      await this.audit(tx, accountId, 'blueprint.version_published', b.id, { code: b.code, version: draft.version, retired: old?.version ?? null });
      await this.outbox.publish(tx, {
        aggregateType: 'assessment_blueprint',
        aggregateId: b.id,
        eventType: 'blueprint.version_published.v1',
        payload: { blueprintId: b.id, code: b.code, version: draft.version, retiredVersion: old?.version ?? null },
        idempotencyKey: `blueprint.version_published.v1:${draft.id}`,
      });
      return this.load(tx, b.id);
    });
  }

  /** Switching on needs a published version. Switching off stops new tests at once; tests already open carry on. */
  async setEnabled(accountId: string, blueprintId: string, enabled: boolean): Promise<BlueprintDetail> {
    await this.require(accountId, BLUEPRINT_PUBLISH_ROLES, 'only an approver may switch a test design on or off');
    return this.db.client.$transaction(async (tx: Tx) => {
      const b = await this.lockBlueprint(tx, blueprintId);
      if (enabled) {
        const published = await tx.assessment_blueprint_version.findFirst({ where: { blueprint_id: b.id, status: 'PUBLISHED' }, select: { id: true } });
        if (!published) throw new BlueprintConflictError('publish a version before switching this test on');
      }
      if (b.enabled !== enabled) {
        await tx.assessment_blueprint.update({ where: { id: b.id }, data: { enabled } });
        await this.audit(tx, accountId, enabled ? 'blueprint.enabled' : 'blueprint.disabled', b.id, { code: b.code });
      }
      return this.load(tx, b.id);
    });
  }

  /** What this version would build for this subject now, for a student who has seen nothing. Writes nothing. */
  async preview(accountId: string, versionId: string, unitId: string, seedRaw?: string): Promise<PreviewResult> {
    if (seedRaw !== undefined && !SEED.test(seedRaw)) throw new BlueprintInputError(['seed must be 1 to 64 letters, digits, _ or -']);
    await this.require(accountId, BLUEPRINT_READ_ROLES, 'only people with a curriculum role may preview a test design');
    const db = this.db.client as unknown as Tx;
    const v: any = await db.assessment_blueprint_version.findUnique({ where: { id: versionId }, include: { ...VERSION_PARTS, blueprint: true } });
    if (!v) throw new BlueprintNotFoundError('blueprint version');
    const unit: any = await db.curriculum_subject_version.findUnique({
      where: { id: unitId },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    if (!unit) throw new BlueprintNotFoundError('subject');
    const codes = { curriculumCode: unit.curriculum_version.curriculum.code, gradeCode: unit.grade.code, subjectCode: unit.subject.code };
    if (!appliesTo(v.blueprint, codes)) throw new BlueprintConflictError(`this design is for ${v.blueprint.subject_code}, not ${codes.subjectCode}`);

    const seed = seedRaw ?? `preview-${randomBytes(6).toString('hex')}`;
    const note = v.scope_mode === 'STUDENT_FOCUS' ? "A preview has no student, so it uses the whole subject; a student's test uses the chapters they chose." : null;
    const head = { blueprint: v.blueprint.code as string, version: v.version as number, status: v.status as VersionStatus, unitId, seed, note };
    const pool = await loadServablePool(db, unit, null, true);
    try {
      const r = assemble(pool.items, designOf(v.blueprint.code, v), seed, resolveScope(v, null));
      const items: PreviewItem[] = r.items.map((i, k) => {
        const d = r.decisions[k];
        const t = pool.text.get(i.revisionId);
        return {
          position: i.position,
          code: t?.code ?? '',
          stem: (t?.stem ?? '').slice(0, 160),
          chapter: chapterOf(i.objectivePath),
          objectivePath: i.objectivePath,
          difficulty: i.difficulty,
          cognitive: i.cognitive ?? null,
          health: i.health ?? 'NEW',
          requirement: d.requirement,
          reasons: d.reasons,
          candidates: d.candidates,
        };
      });
      return { ok: true, ...head, report: r.report, items };
    } catch (e) {
      if (e instanceof InsufficientBankError) return { ok: false, ...head, available: e.available, needed: e.needed };
      throw e;
    }
  }

  // ── internals ──────────────────────────────────────────────────────────

  private async require(accountId: string, allowed: readonly CurriculumRole[], deny: string): Promise<CurriculumRole> {
    const role = pickRole(await this.authz.curriculumRolesFor(accountId), allowed);
    if (!role) throw new BlueprintForbiddenError(deny);
    return role;
  }

  private async lockBlueprint(tx: Tx, blueprintId: string): Promise<any> {
    await tx.$queryRaw`SELECT id FROM assessment_blueprint WHERE id = ${blueprintId}::uuid FOR UPDATE`;
    const b = await tx.assessment_blueprint.findUnique({ where: { id: blueprintId } });
    if (!b) throw new BlueprintNotFoundError('blueprint');
    return b;
  }

  private binding(b: any): SubjectBinding | null {
    return b.subject_code ? { curriculumCode: b.curriculum_code, gradeCode: b.grade_code, subjectCode: b.subject_code } : null;
  }

  /** Rule problems, and chapters that do not exist in any revision of the bound subject. */
  private async check(tx: Tx, draft: BlueprintDraft, subject: SubjectBinding | null): Promise<void> {
    const problems = draftProblems(draft, subject);
    const named = [...new Set([...draft.scope.chapters, ...draft.cells.map((c) => c.chapterCode).filter((c): c is string => c !== null)])];
    if (subject && named.length) {
      const rows: any[] = await tx.chapter.findMany({
        where: {
          code: { in: named },
          subject_version: {
            curriculum_version: { curriculum: { code: subject.curriculumCode } },
            grade: { code: subject.gradeCode },
            subject: { code: subject.subjectCode },
          },
        },
        select: { code: true },
      });
      const known = new Set(rows.map((r) => r.code));
      for (const c of named) if (!known.has(c)) problems.push(`chapter ${c} is not in ${subject.subjectCode}`);
    }
    if (problems.length) throw new BlueprintInputError(problems);
  }

  private async writeVersion(tx: Tx, blueprintId: string, version: number, d: BlueprintDraft, accountId: string): Promise<void> {
    await tx.assessment_blueprint_version.create({
      data: {
        blueprint_id: blueprintId,
        version,
        status: 'DRAFT',
        total_questions: d.totalQuestions,
        scope_mode: d.scope.mode,
        scope_strict: d.scope.strict,
        prefer_unseen: d.preferUnseen,
        opening_difficulty: d.openingDifficulty,
        notes: d.notes,
        created_by: accountId,
        difficulties: { create: (['EASY', 'MEDIUM', 'HARD'] as const).map((k) => ({ difficulty: k, count: d.difficulty[k] })) },
        types: { create: d.types.map((t) => ({ question_type: t.type, count: t.count })) },
        cells: {
          create: d.cells.map((c, i) => ({ position: i + 1, chapter_code: c.chapterCode, difficulty: c.difficulty, cognitive: c.cognitive, min_count: c.minCount })),
        },
        scopes: { create: d.scope.chapters.map((c) => ({ chapter_code: c })) },
      },
    });
  }

  private async load(tx: Tx, blueprintId: string): Promise<BlueprintDetail> {
    const b: any = await tx.assessment_blueprint.findUnique({
      where: { id: blueprintId },
      include: { versions: { orderBy: { version: 'desc' }, include: { ...VERSION_PARTS, _count: { select: { runs: true } } } } },
    });
    if (!b) throw new BlueprintNotFoundError('blueprint');
    return {
      ...this.summary(b),
      versions: b.versions.map((v: any) => ({
        versionId: v.id,
        version: v.version,
        status: v.status,
        design: draftOf(v),
        createdAt: v.created_at.toISOString(),
        publishedAt: iso(v.published_at),
        retiredAt: iso(v.retired_at),
        testsBuilt: v._count?.runs ?? 0,
      })),
    };
  }

  private summary(b: any): BlueprintSummary {
    const published = b.versions.find((v: any) => v.status === 'PUBLISHED');
    const draft = b.versions.find((v: any) => v.status === 'DRAFT');
    return {
      id: b.id,
      code: b.code,
      name: b.name,
      description: b.description ?? null,
      enabled: b.enabled,
      subject: this.binding(b),
      published: published ? { versionId: published.id, version: published.version, totalQuestions: published.total_questions, publishedAt: iso(published.published_at) } : null,
      draft: draft ? { versionId: draft.id, version: draft.version } : null,
    };
  }

  private async audit(tx: Tx, accountId: string, action: string, blueprintId: string, metadata: Record<string, unknown>): Promise<void> {
    await tx.audit_event.create({
      data: { actor_account_id: accountId, action, subject_type: 'assessment_blueprint', subject_id: blueprintId, metadata: metadata as Prisma.InputJsonValue },
    });
  }
}
