import { Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { loadServablePool } from '../assembly/pool';
import { AuthzService } from '../authz/authz.service';
import { appliesTo, isTargeted } from '../blueprint/blueprint-domain';
import { servableBlueprints } from '../blueprint/blueprint-store';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { loadExamConfig, servedCurriculumStates } from '../exam/exam-domain';
import { OutboxService } from '../outbox/outbox.service';
import { DIFFICULTIES, evaluateReadiness, parsePolicy, type Difficulty, type ReadinessPolicy, type ReadinessResult } from './readiness-domain';
import { RELEASE_ROLES, isTier, rank, releaseBlocks, type ReleasedTier, type Tier } from './release-domain';
import { ReleaseService } from './release.service';

type Tx = Prisma.TransactionClient;
type Db = any;

const VIEW_ROLES = ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'];

export interface PolicyView {
  code: string;
  signedOff: null | { by: string; reference: string; at: string };
  policy: ReadinessPolicy;
}

export interface ReadinessUnitRow {
  subjectVersionId: string;
  curriculumCode: string;
  versionLabel: string;
  gradeCode: string;
  subjectCode: string;
  subjectName: string;
  revision: number;
  curriculumState: string;
  tier: Tier;
  latestReport: null | { id: string; generatedAt: string; highest: Tier; policy: string; current: boolean };
  /** The subject is released further than its latest current report supports. */
  belowTier: boolean;
}

export interface ReportView {
  id: string;
  subjectVersionId: string;
  generatedAt: string;
  highest: Tier;
  policy: { code: string; signedOff: boolean };
  result: ReadinessResult;
}

/**
 * Step 21: content readiness. Checks a subject against the active readiness policy using exactly what students would be
 * served, keeps each report, and changes a subject's release tier: a promotion needs a fresh passing report, one tier
 * at a time, from an approver who signs it off with a note (audited, and recorded in an append-only history).
 */
@Injectable()
export class ReadinessService {
  /** The curriculum states students are served, exactly as the exam engine decides (ACTIVE, or the development switch). */
  private readonly served = servedCurriculumStates(loadExamConfig(process.env));

  constructor(
    private readonly db: DatabaseService,
    private readonly authz: AuthzService,
    private readonly release: ReleaseService,
    private readonly outbox: OutboxService,
  ) {}

  // ── policy ─────────────────────────────────────────────────────────────────

  async policyView(actorId: string): Promise<PolicyView> {
    await this.requireRole(actorId, VIEW_ROLES);
    return this.activePolicy(this.db.client as Db);
  }

  private async activePolicy(db: Db): Promise<PolicyView & { id: string }> {
    const row = await db.readiness_policy_version.findFirst({ where: { status: 'ACTIVE' } });
    if (!row) throw new ExamConflictError('No readiness policy is active');
    return {
      id: row.id,
      code: row.code,
      signedOff: row.signed_off_at ? { by: row.signed_off_by_name, reference: row.signed_off_reference, at: row.signed_off_at.toISOString() } : null,
      policy: parsePolicy(row.code, row.params),
    };
  }

  /** Operator tooling: a new policy version becomes the active one (PROVISIONAL until signed off). */
  async publishPolicy(input: { code: string; params: unknown; notes?: string; operator: string }, now = new Date()): Promise<{ code: string }> {
    if (!input.operator?.trim()) throw new ExamInputError('An operator name is required');
    const policy = parsePolicy(input.code, input.params);
    const db = this.db.client as Db;
    return db.$transaction(async (tx: Db) => {
      if (await tx.readiness_policy_version.findUnique({ where: { code: policy.code } })) throw new ExamConflictError(`A policy called ${policy.code} already exists`);
      await tx.readiness_policy_version.updateMany({ where: { status: 'ACTIVE' }, data: { status: 'RETIRED' } });
      const { code: _c, ...params } = policy;
      const row = await tx.readiness_policy_version.create({ data: { code: policy.code, status: 'ACTIVE', params, notes: input.notes?.slice(0, 1000) ?? null, created_at: now } });
      await tx.audit_event.create({ data: { actor_account_id: null, action: 'readiness.policy_published', subject_type: 'readiness_policy', subject_id: row.id, metadata: { code: policy.code, operator: input.operator }, occurred_at: now } });
      return { code: policy.code };
    });
  }

  /** Operator tooling: an academic lead's sign-off of the active policy, by name and a reference to their written approval. */
  async signOff(input: { code: string; approverName: string; reference: string; operator: string }, now = new Date()): Promise<{ signedOff: true }> {
    const name = input.approverName?.trim() ?? '';
    const reference = input.reference?.trim() ?? '';
    if (name.length < 3 || reference.length < 3) throw new ExamInputError("The academic lead's name and a reference to their written approval are required");
    if (!input.operator?.trim()) throw new ExamInputError('An operator name is required');
    const db = this.db.client as Db;
    const row = await db.readiness_policy_version.findUnique({ where: { code: input.code } });
    if (!row) throw new ExamNotFoundError(`No policy called ${input.code}`);
    if (row.status !== 'ACTIVE') throw new ExamConflictError('Only the active policy can be signed off');
    if (row.signed_off_at) throw new ExamConflictError(`${input.code} is already signed off`);
    await db.$transaction(async (tx: Db) => {
      await tx.readiness_policy_version.update({ where: { id: row.id }, data: { signed_off_by_name: name.slice(0, 200), signed_off_reference: reference.slice(0, 200), signed_off_at: now } });
      await tx.audit_event.create({ data: { actor_account_id: null, action: 'readiness.policy_signed_off', subject_type: 'readiness_policy', subject_id: row.id, metadata: { code: row.code, approverName: name, reference, operator: input.operator }, occurred_at: now } });
    });
    return { signedOff: true };
  }

  // ── subjects and reports ───────────────────────────────────────────────────

  async units(actorId: string, now = new Date()): Promise<ReadinessUnitRow[]> {
    await this.requireRole(actorId, VIEW_ROLES);
    const db = this.db.client as Db;
    const rows: any[] = await db.curriculum_subject_version.findMany({
      orderBy: { revision: 'desc' },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    const seen = new Set<string>();
    const out: ReadinessUnitRow[] = [];
    for (const r of rows) {
      const key = `${r.curriculum_version_id}|${r.grade_id}|${r.subject_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const served = await this.servedRevision(db, r);
      const tier = await this.release.tierOf(db, r);
      const latest = await db.readiness_report.findFirst({
        where: { curriculum_version_id: r.curriculum_version_id, grade_id: r.grade_id, subject_id: r.subject_id },
        orderBy: { generated_at: 'desc' },
        include: { policy: { select: { code: true, status: true } } },
      });
      const current = !!latest && latest.subject_version_id === served && latest.policy.status === 'ACTIVE' && now.getTime() - latest.generated_at.getTime() <= 24 * 3_600_000;
      out.push({
        subjectVersionId: served ?? r.id,
        curriculumCode: r.curriculum_version.curriculum.code,
        versionLabel: r.curriculum_version.label,
        gradeCode: r.grade.code,
        subjectCode: r.subject.code,
        subjectName: r.subject.name,
        revision: r.revision,
        curriculumState: r.state,
        tier,
        latestReport: latest ? { id: latest.id, generatedAt: latest.generated_at.toISOString(), highest: latest.highest_tier, policy: latest.policy.code, current } : null,
        belowTier: !!latest && latest.subject_version_id === served && rank(latest.highest_tier as Tier) < rank(tier),
      });
    }
    return out.sort((a, b) => `${a.curriculumCode}${a.gradeCode}${a.subjectName}`.localeCompare(`${b.curriculumCode}${b.gradeCode}${b.subjectName}`));
  }

  /** Checks a subject revision now and keeps the report. */
  async generate(actorId: string | null, subjectVersionId: string, now = new Date()): Promise<ReportView> {
    if (actorId) await this.requireRole(actorId, VIEW_ROLES);
    const db = this.db.client as Db;
    const unit = await db.curriculum_subject_version.findUnique({
      where: { id: subjectVersionId },
      include: { curriculum_version: { include: { curriculum: true } }, grade: true, subject: true },
    });
    if (!unit) throw new ExamNotFoundError('Subject not found');
    const policy = await this.activePolicy(db);
    const result = evaluateReadiness(await this.inputFor(db, unit), policy.policy);
    const row = await db.$transaction(async (tx: Db) => {
      const r = await tx.readiness_report.create({
        data: {
          policy_version_id: policy.id,
          subject_version_id: unit.id,
          curriculum_version_id: unit.curriculum_version_id,
          grade_id: unit.grade_id,
          subject_id: unit.subject_id,
          highest_tier: result.highest,
          result: result as unknown as Prisma.InputJsonValue,
          generated_by_account_id: actorId,
          generated_at: now,
        },
      });
      await tx.audit_event.create({ data: { actor_account_id: actorId, action: 'readiness.report_generated', subject_type: 'curriculum_subject_version', subject_id: unit.id, metadata: { reportId: r.id, highest: result.highest, policy: policy.code }, occurred_at: now } });
      return r;
    });
    return { id: row.id, subjectVersionId: unit.id, generatedAt: now.toISOString(), highest: result.highest, policy: { code: policy.code, signedOff: !!policy.signedOff }, result };
  }

  async report(actorId: string, reportId: string): Promise<ReportView> {
    await this.requireRole(actorId, VIEW_ROLES);
    const r = await (this.db.client as Db).readiness_report.findUnique({ where: { id: reportId }, include: { policy: true } });
    if (!r) throw new ExamNotFoundError('Report not found');
    return { id: r.id, subjectVersionId: r.subject_version_id, generatedAt: r.generated_at.toISOString(), highest: r.highest_tier, policy: { code: r.policy.code, signedOff: !!r.policy.signed_off_at }, result: r.result as ReadinessResult };
  }

  async history(actorId: string, subjectVersionId: string): Promise<Array<{ from: string; to: string; at: string; note: string; approver: string | null; reportId: string | null }>> {
    await this.requireRole(actorId, VIEW_ROLES);
    const db = this.db.client as Db;
    const unit = await db.curriculum_subject_version.findUnique({ where: { id: subjectVersionId } });
    if (!unit) throw new ExamNotFoundError('Subject not found');
    const rel = await db.subject_release.findUnique({ where: { curriculum_version_id_grade_id_subject_id: { curriculum_version_id: unit.curriculum_version_id, grade_id: unit.grade_id, subject_id: unit.subject_id } } });
    if (!rel) return [];
    const events: any[] = await db.subject_release_event.findMany({ where: { release_id: rel.id }, orderBy: { at: 'desc' } });
    const ids: any[] = events.length ? await db.authentication_identity.findMany({ where: { account_id: { in: events.map((e) => e.approver_account_id) }, kind: 'EMAIL' }, select: { account_id: true, identifier_normalized: true } }) : [];
    return events.map((e) => ({ from: e.from_tier, to: e.to_tier, at: e.at.toISOString(), note: e.note, approver: ids.find((i) => i.account_id === e.approver_account_id)?.identifier_normalized ?? null, reportId: e.readiness_report_id }));
  }

  // ── release ────────────────────────────────────────────────────────────────

  async changeTier(actorId: string, subjectVersionId: string, input: { to: unknown; reportId?: unknown; note: unknown }, now = new Date()): Promise<{ tier: Tier }> {
    if (!isTier(input.to)) throw new ExamInputError('Choose FOUNDATION_ONLY, INTERNAL, CONTROLLED or GENERAL');
    const to = input.to;
    const note = typeof input.note === 'string' ? input.note.trim() : '';
    const roles = await this.authz.curriculumRolesFor(actorId);
    const db = this.db.client as Db;
    const unit = await db.curriculum_subject_version.findUnique({ where: { id: subjectVersionId } });
    if (!unit) throw new ExamNotFoundError('Subject not found');
    const from = await this.release.tierOf(db, unit);
    const report = typeof input.reportId === 'string' ? await db.readiness_report.findUnique({ where: { id: input.reportId }, include: { policy: true } }) : null;
    const served = await this.servedRevision(db, unit);
    const blocks = releaseBlocks({
      from,
      to,
      note,
      actorMayRelease: roles.some((r) => (RELEASE_ROLES as readonly string[]).includes(r)),
      report: report
        ? {
            sameSubject: report.curriculum_version_id === unit.curriculum_version_id && report.grade_id === unit.grade_id && report.subject_id === unit.subject_id,
            forCurrentRevision: report.subject_version_id === served,
            generatedAt: report.generated_at,
            policyIsActive: report.policy.status === 'ACTIVE',
            policySignedOff: !!report.policy.signed_off_at,
            passes: (t: ReleasedTier) => (report.result as ReadinessResult).tiers?.[t]?.pass === true,
          }
        : null,
      now,
    });
    if (blocks.length) {
      if (!roles.some((r) => (RELEASE_ROLES as readonly string[]).includes(r))) throw new ExamNotPermittedError(blocks[0]);
      throw new ExamConflictError(blocks.join(' '));
    }
    const promotion = rank(to) > rank(from);
    await db.$transaction(async (tx: Db) => {
      const key = { curriculum_version_id: unit.curriculum_version_id, grade_id: unit.grade_id, subject_id: unit.subject_id };
      // The row is locked (or created) first, so two approvers cannot both move it from the same tier.
      const rel = await tx.subject_release.upsert({
        where: { curriculum_version_id_grade_id_subject_id: key },
        create: { ...key, tier: from, changed_at: now, changed_by_account_id: actorId },
        update: {},
      });
      const moved = await tx.subject_release.updateMany({ where: { id: rel.id, tier: from }, data: { tier: to, changed_at: now, changed_by_account_id: actorId } });
      if (moved.count !== 1) throw new ExamConflictError('Someone else changed this release just now. Reload and try again.');
      await tx.subject_release_event.create({ data: { release_id: rel.id, from_tier: from, to_tier: to, readiness_report_id: promotion ? report!.id : (report?.id ?? null), approver_account_id: actorId, note: note.slice(0, 1000), at: now } });
      await tx.audit_event.create({ data: { actor_account_id: actorId, action: promotion ? 'release.promoted' : 'release.demoted', subject_type: 'curriculum_subject_version', subject_id: unit.id, metadata: { from, to, reportId: report?.id ?? null }, occurred_at: now } });
      await this.outbox.publish(tx, {
        aggregateType: 'subject_release',
        aggregateId: rel.id,
        eventType: 'release.subject_tier_changed.v1',
        payload: { releaseId: rel.id, ...key, from, to },
        idempotencyKey: `release-tier:${rel.id}:${now.getTime()}:${to}`,
      });
    });
    return { tier: to };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  /** The newest served revision of the subject (ACTIVE, or any pre-active state under the development switch), or null. */
  private async servedRevision(db: Db, s: { curriculum_version_id: string; grade_id: string; subject_id: string }): Promise<string | null> {
    const row = await db.curriculum_subject_version.findFirst({
      where: { curriculum_version_id: s.curriculum_version_id, grade_id: s.grade_id, subject_id: s.subject_id, state: { in: this.served } },
      orderBy: { revision: 'desc' },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  private async inputFor(db: Db, unit: any) {
    const chapters: any[] = await db.chapter.findMany({
      where: { subject_version_id: unit.id },
      orderBy: { position: 'asc' },
      select: { code: true, title: true, topics: { select: { code: true, micro_concepts: { select: { code: true, learning_objectives: { select: { code: true } } } } } } },
    });
    const pool = await loadServablePool(db as Tx, unit, null);
    const subjectWhere = { curriculum_version_id: unit.curriculum_version_id, grade_id: unit.grade_id, subject_id: unit.subject_id };
    const [approved, quarantined, degraded, awaiting] = await Promise.all([
      db.question_revision.count({ where: { state: 'APPROVED', question: subjectWhere } }),
      db.question_revision.count({ where: { state: 'QUARANTINED', question: subjectWhere } }),
      db.question_revision.count({ where: { state: 'APPROVED', question: { ...subjectWhere, bank_state: { is: { health: 'DEGRADED' } } } } }),
      db.question_revision.count({ where: { state: 'APPROVED', question: subjectWhere, NOT: { publication: { is: { state: 'PUBLISHED' } } } } }),
    ]);
    const codes = { curriculumCode: unit.curriculum_version.curriculum.code, gradeCode: unit.grade.code, subjectCode: unit.subject.code };
    const designs = (await servableBlueprints(db as Tx))
      .filter((b) => appliesTo(b, codes) && !isTargeted(b.published!.scope_mode))
      .map((b) => {
        const difficulty = Object.fromEntries(DIFFICULTIES.map((d) => [d, 0])) as Record<Difficulty, number>;
        for (const d of b.published!.difficulties) difficulty[d.difficulty as Difficulty] = d.count;
        return { code: b.code, name: b.name, total: b.published!.total_questions, difficulty };
      });
    return {
      curriculumState: unit.state,
      servedUnactivated: unit.state !== 'ACTIVE' && this.served.includes(unit.state),
      chapters: chapters.map((c) => ({
        code: c.code,
        title: c.title,
        objectives: c.topics.flatMap((t: any) => t.micro_concepts.flatMap((m: any) => m.learning_objectives.map((o: any) => `${c.code}/${t.code}/${m.code}/${o.code}`))),
      })),
      items: pool.items.map((i) => ({ questionId: i.questionId, objectivePath: i.objectivePath, difficulty: i.difficulty as Difficulty, cognitive: i.cognitive ?? null, stemHash: i.stemHash })),
      awaitingPublication: awaiting,
      quality: { approved, quarantined, degraded },
      designs,
    };
  }

  private async requireRole(accountId: string, allowed: string[]): Promise<void> {
    const roles = await this.authz.curriculumRolesFor(accountId);
    if (!roles.some((r) => allowed.includes(r))) throw new ExamNotPermittedError('Only curriculum staff may see content readiness');
  }
}
