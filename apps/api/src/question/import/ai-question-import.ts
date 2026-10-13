/**
 * Operator-run import of AI-drafted questions. The file is JSON:
 *   { "curriculumCode":"ICSE", "versionLabel":"2026-27", "gradeCode":"GRADE_8", "subjectCode":"CHEMISTRY",
 *     "questions":[ { code, objectiveCode, stem, options:[A,B,C,D], correct:"B", difficulty, explanation } ] }
 * The AI acts as an AI actor, never an account. It can only ADD new questions as DRAFT: it never edits an
 * existing question, never submits, and can never approve. A person submits; a different person approves.
 */
import { QuestionConflictError, QuestionNotFoundError } from '../question.errors';
import { analyseQuestionFile, type QuestionImportResult } from '../question-bank.service';
import { fileHash, type QuestionService } from '../question.service';
import type { CurriculumService } from '../../curriculum/curriculum.service';
import { QuestionFormatError } from './question-import';

export const AI_QUESTION_ACTOR = { kind: 'AI', accountId: null } as const;

export interface AiQuestionOutcome {
  sha256: string;
  unitId: string;
  result: QuestionImportResult;
}

const CODE = /^[A-Z][A-Z0-9_-]{0,31}$/;

export async function runAiQuestionImport(
  fileText: string,
  deps: {
    curriculum: Pick<CurriculumService, 'findSubjectVersion'>;
    questions: Pick<QuestionService, 'unitIdentity' | 'plan' | 'apply'>;
  },
  operator: string,
): Promise<AiQuestionOutcome> {
  let header: any;
  try {
    header = JSON.parse(fileText);
  } catch {
    throw new QuestionFormatError('the file is not valid JSON');
  }
  const key = {
    curriculumCode: String(header?.curriculumCode ?? ''),
    versionLabel: String(header?.versionLabel ?? ''),
    gradeCode: String(header?.gradeCode ?? ''),
    subjectCode: String(header?.subjectCode ?? ''),
  };
  for (const [k, v] of Object.entries(key)) {
    if (k !== 'versionLabel' && !CODE.test(v)) throw new QuestionFormatError(`header ${k} is missing or not a valid code`);
  }
  if (key.versionLabel.trim() === '' || key.versionLabel.length > 32) throw new QuestionFormatError('header versionLabel is missing');

  const sv = await deps.curriculum.findSubjectVersion(key);
  if (!sv) throw new QuestionNotFoundError(`unit ${key.curriculumCode} ${key.versionLabel} ${key.gradeCode} ${key.subjectCode}`);
  const unit = await deps.questions.unitIdentity(sv.id);
  const sha256 = fileHash(fileText);

  const { plan, result } = await analyseQuestionFile(deps.questions, unit, 'json', fileText);
  if (!plan || !result.ok) return { sha256, unitId: sv.id, result };

  // The AI only adds. Changing an existing question is a person's job.
  const notNew = plan.items.filter((i) => i.action !== 'CREATE');
  if (notNew.length) {
    return {
      sha256,
      unitId: sv.id,
      result: {
        ...result,
        ok: false,
        issues: notNew.map((i) => ({ where: i.where, message: `question ${i.draft.code} already exists; an AI import only adds new questions` })),
      },
    };
  }
  if (plan.items.length === 0) throw new QuestionConflictError('the file has no questions');

  const counts = await deps.questions.apply(unit, plan, {
    actor: AI_QUESTION_ACTOR,
    origin: 'AI_DRAFT',
    aiSource: `operator ${operator}; file sha256 ${sha256}`.slice(0, 255),
  });
  return { sha256, unitId: sv.id, result: { ...result, written: true, counts } };
}
