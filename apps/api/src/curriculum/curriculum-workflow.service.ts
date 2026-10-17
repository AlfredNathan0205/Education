import { Injectable } from '@nestjs/common';
import { AuthzService } from '../authz/authz.service';
import { DatabaseService } from '../database/database.service';
import { CurriculumAdminService } from './curriculum-admin.service';
import { CurriculumConflictError, CurriculumForbiddenError, CurriculumNotFoundError } from './curriculum.errors';
import { CurriculumService, type SubjectVersionKey, type UnitSummary } from './curriculum.service';
import type { CurriculumRole, CurriculumState } from './curriculum-state';
import { EDIT_EVENTS, MIN_NOTE, workflowActions, type ActionVerdict, type WorkflowAction } from './curriculum-workflow-domain';

type Db = any;
const CODE = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

export interface CurriculumDetail {
  unit: UnitSummary & { supersedesId: string | null; activatedAt: string | null };
  evidence: {
    status: 'NONE' | 'DRAFT' | 'VERIFIED';
    verifiedAt: string | null;
    verifiedBy: string | null;
    note: string | null;
    references: Array<{ number: number; title: string; url: string | null; locator: string | null; retrievedAt: string | null }>;
  };
  content: { chapters: number; topics: number; concepts: number; objectives: number; chapterList: Array<{ code: string; title: string; objectives: number }> };
  validation: null | { status: string; at: string; errors: number; warnings: number; findings: Array<{ severity: string; rule: string; path: string; message: string }> };
  revisions: Array<{ id: string; revision: number; state: string }>;
  editors: string[];
  history: Array<{ type: string; from: string | null; to: string | null; actor: string | null; actorKind: string; note: string | null; at: string }>;
  actions: Record<WorkflowAction, ActionVerdict>;
}

/**
 * Step 22: the curriculum workflow behind the admin page, end to end: create a subject, add and verify syllabus
 * evidence, upload content (the existing import), validate, review, approve, activate, suspend, resume, and correct a
 * live curriculum with a new revision. Every step goes through CurriculumAdminService (roles from the database, the
 * state machine); this adds the one rule the page needs on top: whoever edited a revision cannot activate it.
 */
@Injectable()
export class CurriculumWorkflowService {
  constructor(
    private readonly db: DatabaseService,
    private readonly curriculum: CurriculumService,
    private readonly admin: CurriculumAdminService,
    private readonly authz: AuthzService,
  ) {}

  async detail(accountId: string, id: string): Promise<CurriculumDetail> {
    const roles = await this.requireAnyRole(accountId);
    const db = this.db.client as Db;
    const sv = await db.curriculum_subject_version.findUnique({
      where: { id },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    if (!sv) throw new CurriculumNotFoundError('subject version');
    const [pack, chapters, run, events, siblings] = await Promise.all([
      db.curriculum_evidence_pack.findFirst({ where: { subject_version_id: id }, orderBy: { created_at: 'asc' }, include: { references: { orderBy: [{ created_at: 'asc' }, { id: 'asc' }] } } }),
      db.chapter.findMany({ where: { subject_version_id: id }, orderBy: { position: 'asc' }, select: { code: true, title: true, topics: { select: { micro_concepts: { select: { learning_objectives: { select: { id: true } } } } } } } }),
      db.curriculum_validation_run.findFirst({ where: { subject_version_id: id }, orderBy: { created_at: 'desc' }, include: { results: true } }),
      db.curriculum_event_log.findMany({ where: { subject_version_id: id }, orderBy: { occurred_at: 'desc' }, take: 100 }),
      db.curriculum_subject_version.findMany({ where: { curriculum_version_id: sv.curriculum_version_id, grade_id: sv.grade_id, subject_id: sv.subject_id }, orderBy: { revision: 'desc' }, select: { id: true, revision: true, state: true } }),
    ]);
    const editorIds = await this.editorsOf(db, id, sv.last_edited_by);
    const people = await this.emails(db, [...editorIds, ...events.map((e: any) => e.actor_account_id), pack?.verified_by].filter(Boolean));
    let topics = 0;
    let concepts = 0;
    let objectives = 0;
    const chapterList = chapters.map((c: any) => {
      let n = 0;
      topics += c.topics.length;
      for (const t of c.topics) {
        concepts += t.micro_concepts.length;
        for (const m of t.micro_concepts) n += m.learning_objectives.length;
      }
      objectives += n;
      return { code: c.code, title: c.title, objectives: n };
    });
    const open = siblings.some((s: any) => s.id !== id && ['DISCOVERED', 'EVIDENCE_COLLECTION', 'DRAFT', 'AI_STRUCTURED', 'VALIDATION_PENDING', 'VALIDATED', 'ADMIN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED'].includes(s.state));
    const references = pack?.references ?? [];
    return {
      unit: {
        id: sv.id,
        curriculumCode: sv.curriculum_version.curriculum.code,
        versionLabel: sv.curriculum_version.label,
        gradeCode: sv.grade.code,
        subjectCode: sv.subject.code,
        subjectName: sv.subject.name,
        revision: sv.revision,
        state: sv.state,
        supersedesId: sv.supersedes_id ?? null,
        activatedAt: sv.activated_at ? sv.activated_at.toISOString() : null,
      },
      evidence: {
        status: pack ? pack.status : 'NONE',
        verifiedAt: pack?.verified_at ? pack.verified_at.toISOString() : null,
        verifiedBy: pack?.verified_by ? (people.get(pack.verified_by) ?? null) : null,
        note: pack?.verification_note ?? null,
        references: references.map((r: any, i: number) => ({ number: i + 1, title: r.source_title, url: r.source_url ?? null, locator: r.locator ?? null, retrievedAt: r.retrieved_at ? r.retrieved_at.toISOString() : null })),
      },
      content: { chapters: chapters.length, topics, concepts, objectives, chapterList },
      validation: run
        ? {
            status: run.status,
            at: run.created_at.toISOString(),
            errors: run.error_count,
            warnings: run.warning_count,
            findings: (run.results as any[]).slice(0, 50).map((r) => ({ severity: r.severity, rule: r.rule, path: r.path, message: r.message })),
          }
        : null,
      revisions: siblings.map((s: any) => ({ id: s.id, revision: s.revision, state: s.state })),
      editors: [...editorIds].map((a) => people.get(a) ?? a),
      history: events.map((e: any) => ({ type: e.event_type, from: e.from_state ?? null, to: e.to_state ?? null, actor: e.actor_account_id ? (people.get(e.actor_account_id) ?? null) : null, actorKind: e.actor_kind, note: e.note ?? null, at: e.occurred_at.toISOString() })),
      actions: workflowActions({
        state: sv.state as CurriculumState,
        roles,
        isEditor: editorIds.has(accountId),
        evidenceCount: references.length,
        evidenceVerified: pack?.status === 'VERIFIED',
        chapters: chapters.length,
        openSibling: open,
      }),
    };
  }

  // ── each step ───────────────────────────────────────────────────────────────

  async create(accountId: string, raw: unknown): Promise<{ id: string; revision: number }> {
    const b = obj(raw);
    const key: SubjectVersionKey = {
      curriculumCode: code(b.curriculumCode, 'Curriculum code'),
      curriculumName: name(b.curriculumName, 'Curriculum name'),
      versionLabel: label(b.versionLabel),
      gradeCode: code(b.gradeCode, 'Grade code'),
      subjectCode: code(b.subjectCode, 'Subject code'),
      subjectName: name(b.subjectName, 'Subject name'),
    };
    return this.admin.createSubjectVersion(accountId, key);
  }

  async addEvidence(accountId: string, id: string, raw: unknown): Promise<{ referenceId: string }> {
    const b = obj(raw);
    const title = typeof b.title === 'string' ? b.title.trim() : '';
    if (title.length < 3 || title.length > 500) throw new CurriculumConflictError('Give the source a title of 3 to 500 characters');
    const url = optional(b.url, 2000, 'Link');
    if (url && !/^https?:\/\//i.test(url)) throw new CurriculumConflictError('The link must start with http:// or https://');
    const retrieved = optional(b.retrievedAt, 30, 'Retrieved date');
    const retrievedAt = retrieved ? new Date(retrieved) : null;
    if (retrievedAt && Number.isNaN(retrievedAt.getTime())) throw new CurriculumConflictError('The retrieved date is not a date');
    return this.admin.addEvidenceReference(accountId, id, { sourceTitle: title, sourceUrl: url, locator: optional(b.locator, 255, 'Where in the source'), retrievedAt });
  }

  async verifyEvidence(accountId: string, id: string, raw: unknown): Promise<{ verified: true }> {
    await this.admin.verifyEvidencePack(accountId, id, note(raw, 'Say what you checked'));
    return { verified: true };
  }

  async submit(accountId: string, id: string) {
    return this.admin.submitForValidation(accountId, id);
  }

  async sendToReview(accountId: string, id: string): Promise<{ state: CurriculumState }> {
    await this.admin.transition(accountId, id, 'ADMIN_REVIEW');
    return { state: await this.curriculum.getState(id) };
  }

  async requestChanges(accountId: string, id: string, raw: unknown): Promise<{ state: CurriculumState }> {
    await this.admin.transition(accountId, id, 'CHANGES_REQUIRED', note(raw, 'Say what needs changing'));
    return { state: await this.curriculum.getState(id) };
  }

  async approve(accountId: string, id: string, raw: unknown): Promise<{ state: CurriculumState }> {
    await this.admin.approve(accountId, id, note(raw, 'Say what you checked'));
    return { state: await this.curriculum.getState(id) };
  }

  /** First activation of an approved revision (or a correction, which replaces the live one). Not by its editors. */
  async activate(accountId: string, id: string, raw: unknown): Promise<{ state: CurriculumState }> {
    const n = note(raw, 'Write an activation note');
    await this.notAnEditor(accountId, id);
    if ((await this.curriculum.getState(id)) !== 'APPROVED') throw new CurriculumConflictError('Only an approved curriculum can be activated');
    await this.admin.activate(accountId, id);
    await this.audit(accountId, 'curriculum.activated', id, n);
    return { state: await this.curriculum.getState(id) };
  }

  async suspend(accountId: string, id: string, raw: unknown): Promise<{ state: CurriculumState }> {
    const n = note(raw, 'Say why it is suspended');
    await this.admin.transition(accountId, id, 'SUSPENDED', n);
    await this.audit(accountId, 'curriculum.suspended', id, n);
    return { state: await this.curriculum.getState(id) };
  }

  /** Back to ACTIVE from SUSPENDED: an activation, so the same rule applies (not by its editors, evidence verified). */
  async resume(accountId: string, id: string, raw: unknown): Promise<{ state: CurriculumState }> {
    const n = note(raw, 'Say why it can be resumed');
    await this.notAnEditor(accountId, id);
    if ((await this.curriculum.getState(id)) !== 'SUSPENDED') throw new CurriculumConflictError('Only a suspended curriculum can be resumed');
    await this.admin.activate(accountId, id);
    await this.audit(accountId, 'curriculum.resumed', id, n);
    return { state: await this.curriculum.getState(id) };
  }

  async startCorrection(accountId: string, id: string): Promise<{ id: string; revision: number }> {
    return this.admin.createCorrectionRevision(accountId, id);
  }

  async withdraw(accountId: string, id: string, raw: unknown): Promise<{ state: CurriculumState }> {
    await this.admin.transition(accountId, id, 'WITHDRAWN', note(raw, 'Say why it is withdrawn'));
    return { state: await this.curriculum.getState(id) };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private async notAnEditor(accountId: string, id: string): Promise<void> {
    const db = this.db.client as Db;
    const sv = await db.curriculum_subject_version.findUnique({ where: { id }, select: { last_edited_by: true } });
    if (!sv) throw new CurriculumNotFoundError('subject version');
    if ((await this.editorsOf(db, id, sv.last_edited_by)).has(accountId)) {
      throw new CurriculumForbiddenError('you edited this revision; an approver who did not edit it must activate it');
    }
  }

  private async editorsOf(db: Db, id: string, lastEditedBy: string | null): Promise<Set<string>> {
    const rows: any[] = await db.curriculum_event_log.findMany({
      where: { subject_version_id: id, actor_kind: 'HUMAN', event_type: { in: EDIT_EVENTS }, actor_account_id: { not: null } },
      select: { actor_account_id: true },
    });
    const out = new Set<string>(rows.map((r) => r.actor_account_id as string));
    if (lastEditedBy) out.add(lastEditedBy);
    return out;
  }

  private async emails(db: Db, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (!unique.length) return new Map();
    const rows: any[] = await db.authentication_identity.findMany({ where: { account_id: { in: unique }, kind: 'EMAIL' }, select: { account_id: true, identifier_normalized: true } });
    return new Map(rows.map((r) => [r.account_id, r.identifier_normalized]));
  }

  private async audit(accountId: string, action: string, id: string, n: string): Promise<void> {
    await (this.db.client as Db).audit_event.create({ data: { actor_account_id: accountId, action, subject_type: 'curriculum_subject_version', subject_id: id, metadata: { note: n } } });
  }

  private async requireAnyRole(accountId: string): Promise<CurriculumRole[]> {
    const roles = await this.authz.curriculumRolesFor(accountId);
    if (!roles.length) throw new CurriculumForbiddenError('your account does not hold a curriculum role');
    return roles;
  }
}

function obj(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new CurriculumConflictError('Request body must be a JSON object');
  return raw as Record<string, unknown>;
}
function code(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim().toUpperCase() : '';
  if (!CODE.test(s)) throw new CurriculumConflictError(`${what}: capital letters, digits, - and _ only (for example ICSE, GRADE_8, CHEMISTRY)`);
  return s;
}
function name(v: unknown, what: string): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 2 || s.length > 255) throw new CurriculumConflictError(`${what}: 2 to 255 characters`);
  return s;
}
function label(v: unknown): string {
  const s = typeof v === 'string' ? v.trim() : '';
  if (s.length < 2 || s.length > 32) throw new CurriculumConflictError('Version label: 2 to 32 characters (for example 2026-27)');
  return s;
}
function optional(v: unknown, max: number, what: string): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || v.trim().length > max) throw new CurriculumConflictError(`${what}: at most ${max} characters`);
  return v.trim() || null;
}
function note(raw: unknown, what: string): string {
  const n = typeof (raw as any)?.note === 'string' ? ((raw as any).note as string).trim() : '';
  if (n.length < MIN_NOTE || n.length > 1000) throw new CurriculumConflictError(`${what} (${MIN_NOTE} to 1000 characters)`);
  return n;
}
