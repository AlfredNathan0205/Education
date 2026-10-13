import { Injectable } from '@nestjs/common';
import { AuthzService } from '../../authz/authz.service';
import { CurriculumAdminService } from '../curriculum-admin.service';
import { CurriculumForbiddenError } from '../curriculum.errors';
import { CurriculumService, type UnitSummary } from '../curriculum.service';
import { validateCurriculumTree, type CurriculumTree, type ValidationFinding } from '../curriculum-validation';
import {
  ImportFormatError,
  countNodes,
  parseContent,
  resolveEvidence,
  type ImportFormat,
  type ImportIssue,
  type Uploader,
} from './content-import';

export interface ImportResult {
  /** True when the file could be read: no format/provenance/evidence-number problems. */
  ok: boolean;
  /** True only when content was actually saved (never on preview, never when not ok). */
  written: boolean;
  counts: { chapters: number; topics: number; concepts: number; objectives: number };
  /** Problems with the file itself. Nothing is saved while any exist. */
  issues: ImportIssue[];
  /** What the structural validator would say about the content (informational until submitted). */
  findings: ValidationFinding[];
  state?: string;
}

/**
 * Parse, resolve evidence numbers and run the same structural validator the system uses later.
 * Pure of side effects: shared by preview, upload and the operator's AI import.
 */
export async function analyseUpload(
  curriculum: Pick<CurriculumService, 'evidenceReferenceIds'>,
  unitId: string,
  format: ImportFormat,
  text: unknown,
  who: Uploader,
): Promise<{ tree: CurriculumTree; result: ImportResult }> {
  const parsed = parseContent(format, text, who);
  const referenceIds = await curriculum.evidenceReferenceIds(unitId);
  const issues = [...parsed.issues, ...resolveEvidence(parsed.tree, referenceIds)];
  const findings = validateCurriculumTree(parsed.tree, { referenceIds: new Set(referenceIds) });
  return {
    tree: parsed.tree,
    result: { ok: issues.length === 0, written: false, counts: countNodes(parsed.tree), issues: issues.slice(0, 200), findings: findings.slice(0, 200) },
  };
}

/**
 * Teacher/admin upload. The role is looked up from the database for every call (never taken from
 * the request). Uploaded content lands in the unit's DRAFT; it still has to pass automated validation,
 * human verification of the evidence and a different person's approval before anything is ACTIVE.
 */
@Injectable()
export class ContentImportService {
  constructor(
    private readonly curriculum: CurriculumService,
    private readonly admin: CurriculumAdminService,
    private readonly authz: AuthzService,
  ) {}

  async listUnits(accountId: string): Promise<UnitSummary[]> {
    const roles = await this.authz.curriculumRolesFor(accountId);
    if (roles.length === 0) throw new CurriculumForbiddenError('your account does not hold a curriculum role');
    return this.curriculum.listSubjectVersions();
  }

  async preview(accountId: string, unitId: string, format: ImportFormat, text: unknown): Promise<ImportResult> {
    await this.requireEditor(accountId);
    return (await this.analyse(unitId, format, text)).result;
  }

  async upload(accountId: string, unitId: string, format: ImportFormat, text: unknown): Promise<ImportResult> {
    await this.requireEditor(accountId);
    const { tree, result } = await this.analyse(unitId, format, text);
    if (!result.ok) return result;
    const { state } = await this.admin.replaceContent(accountId, unitId, tree);
    return { ...result, written: true, state };
  }

  submit(accountId: string, unitId: string) {
    return this.admin.submitForValidation(accountId, unitId);
  }

  /** A file that cannot be read at all is reported as an issue on the file, not as a server error. */
  private async analyse(unitId: string, format: ImportFormat, text: unknown) {
    try {
      return await analyseUpload(this.curriculum, unitId, format, text, 'HUMAN');
    } catch (e) {
      if (!(e instanceof ImportFormatError)) throw e;
      const empty = { chapters: [] };
      return {
        tree: empty,
        result: {
          ok: false,
          written: false,
          counts: { chapters: 0, topics: 0, concepts: 0, objectives: 0 },
          issues: [{ where: 'file', message: e.message }],
          findings: [],
        } satisfies ImportResult,
      };
    }
  }

  private async requireEditor(accountId: string): Promise<void> {
    const roles = await this.authz.curriculumRolesFor(accountId);
    if (!roles.includes('EDITOR') && !roles.includes('SUPER_ADMIN')) {
      throw new CurriculumForbiddenError('only an editor may upload content');
    }
  }
}
