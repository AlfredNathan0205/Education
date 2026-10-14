import type { Prisma } from '@exam-app/database';
import type { AssemblyDecision, AssemblyResult } from '../assembly/assembly-engine';
import type { VersionRow } from './blueprint-domain';

type Tx = Prisma.TransactionClient;

/** Everything a version needs to become an engine design. */
export const VERSION_PARTS = { difficulties: true, types: true, cells: true, scopes: true } as const;

/** The code students get when they do not ask for a particular test. */
export const DEFAULT_BLUEPRINT_CODE = 'QUICK10';

export interface ServableBlueprint {
  id: string;
  code: string;
  name: string;
  enabled: boolean;
  curriculum_code: string | null;
  grade_code: string | null;
  subject_code: string | null;
  /** The PUBLISHED version, or null when there is none. */
  published: (VersionRow & { id: string }) | null;
}

function shape(b: any): ServableBlueprint {
  return {
    id: b.id,
    code: b.code,
    name: b.name,
    enabled: b.enabled,
    curriculum_code: b.curriculum_code ?? null,
    grade_code: b.grade_code ?? null,
    subject_code: b.subject_code ?? null,
    published: (b.versions ?? [])[0] ?? null,
  };
}

/** One blueprint by code with its published version (if any). */
export async function blueprintByCode(db: Tx, code: string): Promise<ServableBlueprint | null> {
  const b = await db.assessment_blueprint.findUnique({
    where: { code },
    include: { versions: { where: { status: 'PUBLISHED' }, include: VERSION_PARTS } },
  });
  return b ? shape(b) : null;
}

/** Every switched-on blueprint that has a published version: what students may be given. */
export async function servableBlueprints(db: Tx): Promise<ServableBlueprint[]> {
  const rows = await db.assessment_blueprint.findMany({
    where: { enabled: true },
    include: { versions: { where: { status: 'PUBLISHED' }, include: VERSION_PARTS } },
    orderBy: { code: 'asc' },
  });
  return rows.map(shape).filter((b: ServableBlueprint) => b.published !== null);
}

/** Records how an instance was assembled: the run, and one decision per question. */
export async function recordAssemblyRun(
  db: Tx,
  input: { instanceId: string; versionId: string; seed: string; mode: 'TEST' | 'PRACTICE'; result: AssemblyResult },
): Promise<void> {
  const { report, decisions } = input.result;
  await db.assessment_assembly_run.create({
    data: {
      instance_id: input.instanceId,
      blueprint_version_id: input.versionId,
      engine_version: report.engine,
      seed: input.seed,
      mode: input.mode,
      eligible_count: report.pool.eligible,
      requested: report.requested as unknown as Prisma.InputJsonValue,
      delivered: report.delivered as unknown as Prisma.InputJsonValue,
      relaxations: report.relaxations as unknown as Prisma.InputJsonValue,
      relaxed: report.relaxations.length > 0,
      decisions: { create: decisions.map(decisionRow) },
    },
  });
}

function decisionRow(d: AssemblyDecision) {
  return {
    position: d.position,
    question_revision_id: d.revisionId,
    question_id: d.questionId,
    requirement: d.requirement,
    cell_position: d.cellPosition,
    wanted_difficulty: d.wantedDifficulty,
    difficulty: d.difficulty,
    reasons: d.reasons,
    candidates: d.candidates,
  };
}
