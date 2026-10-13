import type { DatabaseService } from '../database/database.service';
import { runCoverageCli, CoverageUsageError } from './cli/coverage-cli';
import { computeCoverage, GENERATION_LIMITS, NEED_WEIGHTS, validTarget, type CoverageItem } from './coverage-domain';
import { CoverageService, CoverageUnitNotFoundError } from './coverage.service';

const A = 'C1/T1/M1/L1';
const B = 'C1/T1/M1/L2';
const objectives = [{ path: A, statement: 'a' }, { path: B, statement: 'b' }];
const item = (p: Partial<CoverageItem> & { objectivePath: string }): CoverageItem => ({
  questionId: Math.random().toString(36).slice(2), difficulty: 'EASY', state: 'APPROVED', timesSeen: 0, timesServed: 0, ...p,
});
const cell = (r: ReturnType<typeof computeCoverage>, p: string, d: string) => r.cells.find((c) => c.objectivePath === p && c.difficulty === d)!;

describe('weights and limits come from the spec', () => {
  it('baseline weights sum to 1 and limits match', () => {
    expect(Object.values(NEED_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    expect(NEED_WEIGHTS.depth).toBe(0.3);
    expect(GENERATION_LIMITS).toMatchObject({ maxPerCellPerCycle: 20, provisionalMaxCandidatesPerCellPerDay: 50, maxRepairs: 2 });
  });
  it('requires an explicit whole-number target', () => {
    for (const bad of [0, -1, 1.5, 1001, '5', undefined]) expect(() => validTarget(bad)).toThrow(RangeError);
    expect(validTarget(10)).toBe(10);
  });
});

describe('computeCoverage', () => {
  it('makes three cells per objective and counts only approved toward depth', () => {
    const r = computeCoverage({
      objectives, targetPerCell: 4,
      items: [item({ objectivePath: A }), item({ objectivePath: A }), item({ objectivePath: A, state: 'DRAFT' }), item({ objectivePath: A, state: 'IN_REVIEW' })],
    });
    expect(r.cells).toHaveLength(6);
    const c = cell(r, A, 'EASY');
    expect(c).toMatchObject({ approved: 2, inPipeline: 2, depth: 0.5 });
    expect(c.requestable).toBe(0); // 4 target - 2 approved - 2 queued
  });
  it('caps a request at the per-cycle limit and never goes negative', () => {
    const r = computeCoverage({ objectives, targetPerCell: 100, items: [item({ objectivePath: A })] });
    expect(cell(r, A, 'EASY').requestable).toBe(20);
    expect(cell(r, B, 'HARD').requestable).toBe(20);
    const full = computeCoverage({ objectives, targetPerCell: 1, items: [item({ objectivePath: A }), item({ objectivePath: A })] });
    expect(cell(full, A, 'EASY').requestable).toBe(0);
    expect(cell(full, A, 'EASY').depth).toBe(1);
  });
  it('does not let a good objective hide a gap in another, or a missing difficulty', () => {
    const r = computeCoverage({
      objectives, targetPerCell: 1,
      items: ['EASY', 'MEDIUM', 'HARD'].map((d) => item({ objectivePath: A, difficulty: d as any })).concat([item({ objectivePath: B })]),
    });
    expect(r.gaps.map((g) => g.objectivePath)).toEqual([B]);
    expect(r.gaps[0].missingDifficulties).toEqual(['MEDIUM', 'HARD']);
    expect(r.chapters[0]).toMatchObject({ objectives: 2, objectivesWithGap: 1, minDepth: 0 });
    expect(r.totals.objectivesWithNoApproved).toBe(0);
  });
  it('sets aside questions on objectives that are not in the curriculum', () => {
    const r = computeCoverage({ objectives, targetPerCell: 2, items: [item({ objectivePath: 'X/Y/Z/W' }), item({ objectivePath: 'X/Y/Z/W', state: 'DRAFT' })] });
    expect(r.orphaned).toEqual({ approved: 1, inPipeline: 1 });
    expect(r.totals.approved).toBe(0);
  });
  it('ranks an empty cell above a full one, using depth alone when nothing else has data', () => {
    const r = computeCoverage({ objectives, targetPerCell: 2, items: [item({ objectivePath: A }), item({ objectivePath: A })] });
    expect(cell(r, A, 'EASY').need).toBe(0);
    expect(cell(r, B, 'EASY').need).toBe(1);
    expect(cell(r, B, 'EASY').needBasis).toEqual(['depth']);
    expect(r.cells[0].need).toBe(1);
  });
  it('shares out the weights of unavailable components instead of counting them as zero', () => {
    const r = computeCoverage({ objectives, targetPerCell: 2, items: [item({ objectivePath: A, timesSeen: 10, timesServed: 5 }), item({ objectivePath: A, timesSeen: 10, timesServed: 5 })] });
    const c = cell(r, A, 'EASY'); // depth gap 0; exposure 1 (the max); attrition 0; demand 1 (the max)
    expect(c.needBasis).toEqual(['depth', 'exposure', 'qualityAttrition', 'testDemand']);
    expect(c.need).toBeCloseTo((0.15 * 1 + 0.1 * 1) / (0.3 + 0.15 + 0.1 + 0.1), 3);
  });
  it('counts retired questions as quality attrition', () => {
    const r = computeCoverage({ objectives, targetPerCell: 2, items: [item({ objectivePath: A }), item({ objectivePath: A, state: 'RETIRED' })] });
    const c = cell(r, A, 'EASY');
    expect(c.retired).toBe(1);
    expect(c.needBasis).toContain('qualityAttrition');
  });
  it('states what is not measured yet', () => {
    const r = computeCoverage({ objectives, targetPerCell: 2, items: [] });
    expect(r.notYetAvailable.join(' ')).toMatch(/Cognitive level/);
    expect(r.notYetAvailable.join(' ')).toMatch(/priority/i);
  });
});

function fakeDb() {
  const client: any = {
    curriculum_subject_version: {
      findFirst: jest.fn().mockResolvedValue({
        curriculum_version_id: 'cv', grade_id: 'g', subject_id: 's',
        chapters: [{ code: 'C1', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'L1', statement: 'a' }] }] }] }],
      }),
    },
    question_revision: {
      findMany: jest.fn().mockResolvedValue([
        { state: 'APPROVED', difficulty: 'EASY', question: { id: 'q1', objective_path: A } },
        { state: 'DRAFT', difficulty: 'EASY', question: { id: 'q2', objective_path: A } },
      ]),
    },
    student_question_exposure: { groupBy: jest.fn().mockResolvedValue([{ question_id: 'q1', _sum: { times_seen: 7 } }]) },
    assessment_instance_question: { groupBy: jest.fn().mockResolvedValue([{ question_id: 'q1', _count: { _all: 3 } }]) },
  };
  return client;
}

describe('CoverageService', () => {
  it('reads the unit, excludes superseded revisions, and uses aggregate exposure only', async () => {
    const client = fakeDb();
    const r = await new CoverageService({ client } as unknown as DatabaseService).report({ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS', targetPerCell: 2 });
    expect(client.question_revision.findMany.mock.calls[0][0].where.state).toEqual({ not: 'SUPERSEDED' });
    expect(client.student_question_exposure.groupBy.mock.calls[0][0].by).toEqual(['question_id']);
    expect(cell(r, A, 'EASY')).toMatchObject({ approved: 1, inPipeline: 1, timesServed: 3 });
  });
  it('says so when the unit does not exist', async () => {
    const client = fakeDb();
    client.curriculum_subject_version.findFirst.mockResolvedValue(null);
    await expect(new CoverageService({ client } as unknown as DatabaseService).report({ curriculumCode: 'X', gradeCode: 'Y', subjectCode: 'Z', targetPerCell: 1 })).rejects.toBeInstanceOf(CoverageUnitNotFoundError);
  });
});

describe('coverage CLI', () => {
  const report = computeCoverage({ objectives, targetPerCell: 2, items: [item({ objectivePath: A })] });
  const deps: any = { coverage: { report: jest.fn().mockResolvedValue(report) } };
  it('prints gaps, ranking and what is not measured', async () => {
    const out = await runCoverageCli(['report', 'ICSE', 'GRADE_8', 'PHYSICS', '2'], deps);
    expect(deps.coverage.report).toHaveBeenCalledWith({ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS', targetPerCell: 2 });
    expect(out).toContain('Objectives with a difficulty at zero approved');
    expect(out).toContain('Not measured yet');
  });
  it('has no default target and rejects bad arguments', async () => {
    await expect(runCoverageCli(['report', 'ICSE', 'GRADE_8', 'PHYSICS'], deps)).rejects.toBeInstanceOf(CoverageUsageError);
    await expect(runCoverageCli(['report', 'ICSE', 'GRADE_8', 'PHYSICS', '0'], deps)).rejects.toBeInstanceOf(CoverageUsageError);
    await expect(runCoverageCli(['nope'], deps)).rejects.toBeInstanceOf(CoverageUsageError);
  });
});
