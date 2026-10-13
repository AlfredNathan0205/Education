/**
 * Operator tooling: where is the question bank thin?
 *
 *   coverage report <curriculumCode> <gradeCode> <subjectCode> <targetPerCell> [top]
 *
 * <targetPerCell> is the number of approved questions you want in each objective x difficulty cell.
 * It is your decision; there is no built-in default. Read-only: this never creates or changes anything.
 */
import type { CoverageService } from '../coverage.service';
import type { CoverageReport } from '../coverage-domain';

export class CoverageUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CoverageUsageError';
  }
}

export const USAGE = 'Usage: coverage report <curriculumCode> <gradeCode> <subjectCode> <targetPerCell> [top]';

const pct = (n: number) => `${Math.round(n * 100)}%`;

export function formatReport(r: CoverageReport, top: number): string {
  const out: string[] = [];
  out.push(`Target: ${r.targetPerCell} approved per cell (objective x difficulty).`);
  out.push(
    `Objectives ${r.totals.objectives}; cells ${r.totals.cells} (${r.totals.cellsAtTarget} at target); approved questions ${r.totals.approved}; objectives with no approved question ${r.totals.objectivesWithNoApproved}.`,
  );
  if (r.orphaned.approved || r.orphaned.inPipeline) {
    out.push(`Questions pointing at an objective that is not in the current curriculum (count for nothing): ${r.orphaned.approved} approved, ${r.orphaned.inPipeline} in review.`);
  }
  out.push('', 'By chapter (gaps are never rolled up):');
  for (const c of r.chapters) {
    out.push(`  ${c.chapterCode}: ${c.objectives} objectives, ${c.objectivesWithGap} with a gap, ${c.approved} approved, weakest cell ${pct(c.minDepth)} of target`);
  }
  out.push('', `Objectives with a difficulty at zero approved (${r.gaps.length}):`);
  for (const g of r.gaps.slice(0, top)) out.push(`  ${g.objectivePath}  missing ${g.missingDifficulties.join(', ')}  (${g.approvedTotal} approved in total)`);
  if (r.gaps.length > top) out.push(`  ... and ${r.gaps.length - top} more`);
  out.push('', `Highest need first (top ${Math.min(top, r.cells.length)}), provisional score 0 to 1:`);
  for (const c of r.cells.slice(0, top)) {
    out.push(`  ${c.need?.toFixed(3) ?? '  n/a'}  ${c.objectivePath} ${c.difficulty}: approved ${c.approved}, queued ${c.inPipeline}, could request ${c.requestable}`);
  }
  out.push('', 'Not measured yet:');
  for (const n of r.notYetAvailable) out.push(`  - ${n}`);
  out.push('The score uses only the components above that have data, with their spec weights shared out over those. Treat it as a ranking aid.');
  return out.join('\n');
}

export async function runCoverageCli(argv: string[], deps: { coverage: Pick<CoverageService, 'report'> }): Promise<string> {
  const [command, curriculumCode, gradeCode, subjectCode, targetRaw, topRaw, ...extra] = argv;
  if (command !== 'report' || !curriculumCode || !gradeCode || !subjectCode || !targetRaw || extra.length) throw new CoverageUsageError(USAGE);
  const target = Number(targetRaw);
  if (!Number.isInteger(target) || target < 1 || target > 1000) throw new CoverageUsageError('targetPerCell must be a whole number from 1 to 1000');
  const top = topRaw === undefined ? 20 : Number(topRaw);
  if (!Number.isInteger(top) || top < 1 || top > 500) throw new CoverageUsageError('top must be a whole number from 1 to 500');
  const report = await deps.coverage.report({ curriculumCode, gradeCode, subjectCode, targetPerCell: target });
  return formatReport(report, top);
}
