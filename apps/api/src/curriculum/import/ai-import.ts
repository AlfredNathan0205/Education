/**
 * Operator-run import of an AI-drafted structure. The file is JSON with a header naming the unit:
 *   { "curriculumCode":"ICSE", "versionLabel":"2026-27", "gradeCode":"GRADE_8", "subjectCode":"PHYSICS", "chapters":[...] }
 * The import acts as the AI actor (never an account), so it can only draft: nodes may be OFFICIAL_INFERRED or
 * SYSTEM_DERIVED, never "explicit", and the unit moves DRAFT -> AI_STRUCTURED. A human editor then reviews,
 * edits if needed, and submits for validation. The file's hash and the operator's name go in the history note.
 */
import { createHash } from 'node:crypto';
import { CurriculumConflictError, CurriculumNotFoundError } from '../curriculum.errors';
import type { CurriculumService } from '../curriculum.service';
import type { CurriculumActor } from '../curriculum-state';
import { analyseUpload, type ImportResult } from './content-import.service';
import { ImportFormatError } from './content-import';

export const AI_ACTOR: CurriculumActor = { kind: 'AI', accountId: null, role: 'AI_RESEARCH' };

export interface AiImportOutcome {
  unitId: string;
  sha256: string;
  result: ImportResult;
  state: string | null;
}

const CODE = /^[A-Z][A-Z0-9_-]{0,31}$/;

export async function runAiImport(
  fileText: string,
  deps: Pick<CurriculumService, 'findSubjectVersion' | 'evidenceReferenceIds' | 'replaceContent' | 'transition'>,
  operator: string,
): Promise<AiImportOutcome> {
  let header: any;
  try {
    header = JSON.parse(fileText);
  } catch {
    throw new ImportFormatError('the file is not valid JSON');
  }
  const key = {
    curriculumCode: String(header?.curriculumCode ?? ''),
    versionLabel: String(header?.versionLabel ?? ''),
    gradeCode: String(header?.gradeCode ?? ''),
    subjectCode: String(header?.subjectCode ?? ''),
  };
  for (const [k, v] of Object.entries(key)) {
    if (k !== 'versionLabel' && !CODE.test(v)) throw new ImportFormatError(`header ${k} is missing or not a valid code`);
  }
  if (key.versionLabel.trim() === '' || key.versionLabel.length > 32) throw new ImportFormatError('header versionLabel is missing');

  const unit = await deps.findSubjectVersion(key);
  if (!unit) throw new CurriculumNotFoundError(`unit ${key.curriculumCode} ${key.versionLabel} ${key.gradeCode} ${key.subjectCode}`);
  if (unit.state !== 'DRAFT' && unit.state !== 'AI_STRUCTURED') {
    throw new CurriculumConflictError(`the unit is in state ${unit.state}; an AI draft can only be imported while it is DRAFT or AI_STRUCTURED`);
  }

  const sha256 = createHash('sha256').update(fileText).digest('hex');
  const { tree, result } = await analyseUpload(deps, unit.id, 'json', fileText, 'AI');
  if (!result.ok) return { unitId: unit.id, sha256, result, state: null };

  const { state } = await deps.replaceContent(unit.id, tree, AI_ACTOR);
  let finalState: string = state;
  if (unit.state === 'DRAFT') {
    await deps.transition(unit.id, 'AI_STRUCTURED', AI_ACTOR, `AI draft imported by operator ${operator}; file sha256 ${sha256}`);
    finalState = 'AI_STRUCTURED';
  }
  return { unitId: unit.id, sha256, result: { ...result, written: true, state: finalState }, state: finalState };
}
