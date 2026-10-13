/**
 * Operator tooling for the AI question factory. Drafts only: nothing here approves, publishes or activates.
 *
 *   factory run <curriculumCode> <gradeCode> <subjectCode> <objectiveCode> <difficulty> <cognitive> <count>
 *   factory suggest <curriculumCode> <gradeCode> <subjectCode> <targetPerCell> [top]
 *   factory batches
 *   factory show <batchId>
 *   factory stop <batchId>
 */
import type { CoverageService } from '../../bank-coverage/coverage.service';
import { COGNITIVE_LEVELS, DIFFICULTIES, type QuestionCognitive, type QuestionDifficulty } from '../../question/question-domain';
import type { FactoryService } from '../factory.service';

export class FactoryUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FactoryUsageError';
  }
}

export const USAGE = [
  'Usage:',
  '  factory run <curriculumCode> <gradeCode> <subjectCode> <objectiveCode> <difficulty> <cognitive> <count>',
  '  factory suggest <curriculumCode> <gradeCode> <subjectCode> <targetPerCell> [top]',
  '  factory batches',
  '  factory show <batchId>',
  '  factory stop <batchId>',
].join('\n');

export interface FactoryCliDeps {
  factory: Pick<FactoryService, 'runBatch' | 'listBatches' | 'showBatch' | 'requestStop'>;
  coverage: Pick<CoverageService, 'report'>;
  operator: string;
}

const lastSegment = (path: string) => path.split('/').pop() ?? path;

export async function runFactoryCli(argv: string[], deps: FactoryCliDeps): Promise<string> {
  const [command, ...rest] = argv;
  switch (command) {
    case 'run': {
      const [curriculumCode, gradeCode, subjectCode, objectiveCode, difficulty, cognitive, countRaw, ...extra] = rest;
      if (!curriculumCode || !gradeCode || !subjectCode || !objectiveCode || !difficulty || !cognitive || !countRaw || extra.length) throw new FactoryUsageError(USAGE);
      if (!(DIFFICULTIES as readonly string[]).includes(difficulty)) throw new FactoryUsageError(`difficulty must be one of ${DIFFICULTIES.join(', ')}`);
      if (!(COGNITIVE_LEVELS as readonly string[]).includes(cognitive)) throw new FactoryUsageError(`cognitive must be one of ${COGNITIVE_LEVELS.join(', ')}`);
      const count = Number(countRaw);
      if (!Number.isInteger(count)) throw new FactoryUsageError('count must be a whole number');
      const s = await deps.factory.runBatch({
        curriculumCode, gradeCode, subjectCode, objectiveCode,
        difficulty: difficulty as QuestionDifficulty, cognitive: cognitive as QuestionCognitive, count, operator: deps.operator,
      });
      const routes = Object.entries(s.routes).map(([k, v]) => `${k} ${v}`).join(', ') || 'none';
      return [
        `Batch ${s.batchId}: ${s.status}${s.stopReason ? ` (${s.stopReason})` : ''}`,
        `Asked for ${s.requested}, tried ${s.attempted}: ${s.draftsStored} stored as drafts for review, ${s.rejected} rejected, ${s.duplicates} duplicates, ${s.failed} failed.`,
        `Routes of what was judged: ${routes}.`,
        'Drafts are not approved. A person must review each one in the question bank.',
      ].join('\n');
    }
    case 'suggest': {
      const [curriculumCode, gradeCode, subjectCode, targetRaw, topRaw, ...extra] = rest;
      if (!curriculumCode || !gradeCode || !subjectCode || !targetRaw || extra.length) throw new FactoryUsageError(USAGE);
      const target = Number(targetRaw);
      if (!Number.isInteger(target) || target < 1 || target > 1000) throw new FactoryUsageError('targetPerCell must be a whole number from 1 to 1000');
      const top = topRaw === undefined ? 10 : Number(topRaw);
      if (!Number.isInteger(top) || top < 1 || top > 100) throw new FactoryUsageError('top must be a whole number from 1 to 100');
      const r = await deps.coverage.report({ curriculumCode, gradeCode, subjectCode, targetPerCell: target });
      const cells = r.cells.filter((c) => c.requestable > 0).slice(0, top);
      if (!cells.length) return 'Nothing to suggest: every cell is at target or already has enough queued.';
      const out = ['Highest-need cells (the choice of cognitive level is yours; coverage by cognitive level is not measured yet):'];
      for (const c of cells) {
        out.push(`  need ${c.need?.toFixed(3) ?? 'n/a'}  ${c.objectivePath} ${c.difficulty}: approved ${c.approved}, queued ${c.inPipeline}`);
        out.push(`    factory run ${curriculumCode} ${gradeCode} ${subjectCode} ${lastSegment(c.objectivePath)} ${c.difficulty} <C1-C4> ${Math.min(c.requestable, 20)}`);
      }
      return out.join('\n');
    }
    case 'batches': {
      if (rest.length) throw new FactoryUsageError(USAGE);
      const rows = await deps.factory.listBatches(20);
      if (!rows.length) return 'No batches yet.';
      return rows
        .map((b) => `${b.id}  ${b.startedAt.toISOString()}  ${b.status}  ${b.objectivePath} ${b.difficulty}/${b.cognitive}  asked ${b.requested}: stored ${b.stored}, rejected ${b.rejected}, duplicates ${b.duplicates}, failed ${b.failed}  [${b.provider}]`)
        .join('\n');
    }
    case 'show': {
      const [batchId, ...extra] = rest;
      if (!batchId || extra.length) throw new FactoryUsageError(USAGE);
      const { batch, calls } = await deps.factory.showBatch(batchId);
      const out = [
        `Batch ${batch.id}: ${batch.status}${batch.stop_reason ? ` (${batch.stop_reason})` : ''}`,
        `Cell ${batch.objective_path} ${batch.difficulty}/${batch.cognitive}; provider ${batch.provider}/${batch.model}; config ${batch.config_version}; by ${batch.requested_by}`,
        `Asked ${batch.requested_count}: stored ${batch.drafts_stored}, rejected ${batch.rejected}, duplicates ${batch.duplicates}, failed ${batch.failed}`,
        '',
        'Attempts:',
      ];
      for (const a of batch.attempts as any[]) {
        out.push(`  #${a.sequence} ${a.outcome}${a.route ? ` ${a.route}` : ''}${a.confidence != null ? ` ${Number(a.confidence).toFixed(3)}` : ''} repairs ${a.repairs}${a.note ? ` - ${a.note}` : ''}`);
      }
      out.push('', 'Model calls by status:');
      for (const c of calls as any[]) out.push(`  ${c.status}: ${c._count._all} calls, ${c._sum.tokens_in ?? 0} tokens in, ${c._sum.tokens_out ?? 0} out`);
      return out.join('\n');
    }
    case 'stop': {
      const [batchId, ...extra] = rest;
      if (!batchId || extra.length) throw new FactoryUsageError(USAGE);
      return (await deps.factory.requestStop(batchId)) ? 'Stop requested. The batch ends after the attempt in progress.' : 'That batch is not running.';
    }
    default:
      throw new FactoryUsageError(USAGE);
  }
}
