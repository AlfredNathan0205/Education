/**
 * Coverage and generation demand (Domain: COVERAGE_AND_DEMAND). Pure calculation, no database.
 *
 * Spec cell = learning objective x cognitive level x difficulty x question type. Today a question stores
 * only its objective and difficulty (and every question is a 4-option multiple choice), so a cell here is
 * objective x difficulty. Cognitive level and question type are NOT tracked yet and are reported as such,
 * never guessed. This module only measures and ranks. It never decides to generate anything
 * ("the generator never decides demand").
 */

export const DIFFICULTIES = ['EASY', 'MEDIUM', 'HARD'] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** Weights from the spec's Generation Need Score baseline. */
export const NEED_WEIGHTS = {
  depth: 0.3,
  diversity: 0.25,
  exposure: 0.15,
  qualityAttrition: 0.1,
  testDemand: 0.1,
  curriculumPriority: 0.1,
} as const;

/** Limits from the spec, for the future generator (Step 8) to enforce. Nothing here generates. */
export const GENERATION_LIMITS = {
  maxPerCellPerCycle: 20,
  provisionalMaxCandidatesPerCellPerDay: 50,
  yieldBreakerBelow: 0.3,
  duplicateSaturationAbove: 0.4,
  maxRepairs: 2,
} as const;

/** Components the spec names that cannot be computed from the data we hold yet, and why. */
export const NOT_YET_AVAILABLE = [
  'Cognitive level and question type per question (not stored; the cell is objective x difficulty for now)',
  'Diversity (needs reasoning/scenario families and near-duplicate detection; Question Bank step)',
  'Curriculum priority P0-P6 (the priority scheme is not defined in our repository)',
  'Empirical calibration and stability (needs real student answers)',
  'In-flight reservation of generation work (arrives with the AI Question Factory; queued drafts are counted instead)',
] as const;

export interface ObjectiveInfo {
  /** "chapter/topic/concept/objective" */
  path: string;
  statement: string;
}

export type ItemState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUIRED' | 'APPROVED' | 'RETIRED';

/** One question revision that counts (superseded revisions are left out by the caller). */
export interface CoverageItem {
  questionId: string;
  objectivePath: string;
  difficulty: Difficulty;
  state: ItemState;
  /** Total times students have been shown it, across students (aggregate only). */
  timesSeen: number;
  /** Times it has been placed in an assessment. */
  timesServed: number;
}

export interface Cell {
  objectivePath: string;
  difficulty: Difficulty;
  approved: number;
  inPipeline: number;
  retired: number;
  /** 0..1 against the target. */
  depth: number;
  timesServed: number;
  /** 0..1; null when no component could be computed for this cell. */
  need: number | null;
  /** Which spec components were available for this cell's score (the rest were redistributed). */
  needBasis: string[];
  /** Suggested size of a request: spec cap per cell per cycle, reduced by what is already approved or queued. */
  requestable: number;
}

export interface ObjectiveGap {
  objectivePath: string;
  statement: string;
  approvedTotal: number;
  missingDifficulties: Difficulty[];
}

export interface ChapterRollup {
  chapterCode: string;
  objectives: number;
  /** Objectives with at least one difficulty at zero approved. A rollup never hides these. */
  objectivesWithGap: number;
  approved: number;
  /** The worst cell depth in the chapter (0..1). */
  minDepth: number;
}

export interface CoverageReport {
  targetPerCell: number;
  cells: Cell[];
  gaps: ObjectiveGap[];
  chapters: ChapterRollup[];
  /** Questions pointing at an objective that is not in the current curriculum tree. They count for nothing. */
  orphaned: { approved: number; inPipeline: number };
  totals: { objectives: number; cells: number; cellsAtTarget: number; objectivesWithNoApproved: number; approved: number };
  notYetAvailable: readonly string[];
}

export function validTarget(n: unknown): number {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 1000) {
    throw new RangeError('The target per cell must be a whole number from 1 to 1000');
  }
  return n;
}

const PIPELINE: ReadonlySet<ItemState> = new Set(['DRAFT', 'IN_REVIEW', 'CHANGES_REQUIRED']);

export function computeCoverage(input: { objectives: ObjectiveInfo[]; items: CoverageItem[]; targetPerCell: number }): CoverageReport {
  const target = validTarget(input.targetPerCell);
  const known = new Map(input.objectives.map((o) => [o.path, o]));

  const itemsByCell = new Map<string, CoverageItem[]>();
  const orphaned = { approved: 0, inPipeline: 0 };
  for (const it of input.items) {
    if (!known.has(it.objectivePath)) {
      if (it.state === 'APPROVED') orphaned.approved++;
      else if (PIPELINE.has(it.state)) orphaned.inPipeline++;
      continue;
    }
    const k = `${it.objectivePath}|${it.difficulty}`;
    const list = itemsByCell.get(k);
    if (list) list.push(it);
    else itemsByCell.set(k, [it]);
  }

  // Raw measurements per cell first; the need score needs maxima across cells.
  const raw = [];
  for (const o of input.objectives) {
    for (const d of DIFFICULTIES) {
      const list = itemsByCell.get(`${o.path}|${d}`) ?? [];
      const approvedItems = list.filter((i) => i.state === 'APPROVED');
      const retired = list.filter((i) => i.state === 'RETIRED').length;
      raw.push({
        objectivePath: o.path,
        difficulty: d,
        approved: approvedItems.length,
        inPipeline: list.filter((i) => PIPELINE.has(i.state)).length,
        retired,
        meanSeen: approvedItems.length ? approvedItems.reduce((s, i) => s + i.timesSeen, 0) / approvedItems.length : null,
        timesServed: approvedItems.reduce((s, i) => s + i.timesServed, 0),
      });
    }
  }
  const maxSeen = Math.max(0, ...raw.map((r) => r.meanSeen ?? 0));
  const maxServed = Math.max(0, ...raw.map((r) => r.timesServed));

  const cells: Cell[] = raw.map((r) => {
    const depth = Math.min(1, r.approved / target);
    const parts: Array<[string, number, number]> = [['depth', NEED_WEIGHTS.depth, 1 - depth]];
    if (r.meanSeen !== null && maxSeen > 0) parts.push(['exposure', NEED_WEIGHTS.exposure, r.meanSeen / maxSeen]);
    if (r.approved + r.retired > 0) parts.push(['qualityAttrition', NEED_WEIGHTS.qualityAttrition, r.retired / (r.approved + r.retired)]);
    if (maxServed > 0) parts.push(['testDemand', NEED_WEIGHTS.testDemand, r.timesServed / maxServed]);
    const weight = parts.reduce((s, p) => s + p[1], 0);
    const need = parts.reduce((s, p) => s + p[1] * p[2], 0) / weight;
    return {
      objectivePath: r.objectivePath,
      difficulty: r.difficulty,
      approved: r.approved,
      inPipeline: r.inPipeline,
      retired: r.retired,
      depth,
      timesServed: r.timesServed,
      need: Math.round(need * 1000) / 1000,
      needBasis: parts.map((p) => p[0]),
      requestable: Math.min(GENERATION_LIMITS.maxPerCellPerCycle, Math.max(0, target - r.approved - r.inPipeline)),
    };
  });

  const gaps: ObjectiveGap[] = [];
  const byObjective = new Map<string, Cell[]>();
  for (const c of cells) {
    const l = byObjective.get(c.objectivePath);
    if (l) l.push(c);
    else byObjective.set(c.objectivePath, [c]);
  }
  for (const o of input.objectives) {
    const cs = byObjective.get(o.path) ?? [];
    const missing = cs.filter((c) => c.approved === 0).map((c) => c.difficulty);
    if (missing.length) gaps.push({ objectivePath: o.path, statement: o.statement, approvedTotal: cs.reduce((s, c) => s + c.approved, 0), missingDifficulties: missing });
  }

  const chapterMap = new Map<string, ChapterRollup>();
  for (const o of input.objectives) {
    const code = o.path.split('/')[0];
    const cs = byObjective.get(o.path) ?? [];
    const r = chapterMap.get(code) ?? { chapterCode: code, objectives: 0, objectivesWithGap: 0, approved: 0, minDepth: 1 };
    r.objectives++;
    if (cs.some((c) => c.approved === 0)) r.objectivesWithGap++;
    r.approved += cs.reduce((s, c) => s + c.approved, 0);
    r.minDepth = Math.min(r.minDepth, ...cs.map((c) => c.depth));
    chapterMap.set(code, r);
  }

  const ranked = [...cells].sort((a, b) => (b.need ?? -1) - (a.need ?? -1) || a.objectivePath.localeCompare(b.objectivePath) || a.difficulty.localeCompare(b.difficulty));
  return {
    targetPerCell: target,
    cells: ranked,
    gaps,
    chapters: [...chapterMap.values()],
    orphaned,
    totals: {
      objectives: input.objectives.length,
      cells: cells.length,
      cellsAtTarget: cells.filter((c) => c.depth >= 1).length,
      objectivesWithNoApproved: input.objectives.filter((o) => (byObjective.get(o.path) ?? []).every((c) => c.approved === 0)).length,
      approved: cells.reduce((s, c) => s + c.approved, 0),
    },
    notYetAvailable: NOT_YET_AVAILABLE,
  };
}
