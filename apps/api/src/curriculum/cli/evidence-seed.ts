/**
 * Pure loading/validation of an evidence seed file, and the runner that creates one
 * subject version per unit with its evidence references. Content (chapters, topics) is
 * NOT created here: only the unit and its pointers to official sources.
 */
import type { CurriculumAdminService } from '../curriculum-admin.service';
import { CurriculumConflictError } from '../curriculum.errors';

export class SeedFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeedFileError';
  }
}

export interface SeedReference {
  sourceTitle: string;
  sourceUrl: string;
  locator: string;
  retrievedAt: Date;
}
export interface SeedUnit {
  subjectCode: string;
  subjectName: string;
  references: SeedReference[];
}
export interface SeedFile {
  curriculum: { code: string; name: string };
  versionLabel: string;
  gradeCode: string;
  units: SeedUnit[];
}

const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== 'string' || v.trim() === '' || v.length > max) {
    throw new SeedFileError(`${what} must be a non-empty string of at most ${max} characters`);
  }
  return v;
};
const CODE = /^[A-Z][A-Z0-9_]{0,31}$/;

export function parseSeedFile(raw: unknown): SeedFile {
  const o = raw as Record<string, any>;
  if (typeof o !== 'object' || o === null || Array.isArray(o)) throw new SeedFileError('seed file must be an object');
  const curriculum = { code: str(o.curriculum?.code, 'curriculum.code', 32), name: str(o.curriculum?.name, 'curriculum.name', 255) };
  const versionLabel = str(o.versionLabel, 'versionLabel', 32);
  const gradeCode = str(o.gradeCode, 'gradeCode', 16);
  if (!Array.isArray(o.units) || o.units.length === 0) throw new SeedFileError('units must be a non-empty array');

  const seen = new Set<string>();
  const units = o.units.map((u: any, i: number): SeedUnit => {
    const subjectCode = str(u?.subjectCode, `units[${i}].subjectCode`, 32);
    if (!CODE.test(subjectCode)) throw new SeedFileError(`units[${i}].subjectCode must be UPPER_SNAKE_CASE`);
    if (seen.has(subjectCode)) throw new SeedFileError(`duplicate subject ${subjectCode}`);
    seen.add(subjectCode);
    if (!Array.isArray(u.references) || u.references.length === 0) {
      throw new SeedFileError(`units[${i}] needs at least one evidence reference`);
    }
    const references = u.references.map((r: any, j: number): SeedReference => {
      const where = `units[${i}].references[${j}]`;
      const sourceUrl = str(r?.sourceUrl, `${where}.sourceUrl`, 2000);
      if (!/^https?:\/\//.test(sourceUrl)) throw new SeedFileError(`${where}.sourceUrl must be an http(s) URL`);
      const retrievedAt = new Date(`${str(r?.retrievedAt, `${where}.retrievedAt`, 10)}T00:00:00Z`);
      if (Number.isNaN(retrievedAt.getTime())) throw new SeedFileError(`${where}.retrievedAt must be YYYY-MM-DD`);
      return {
        sourceTitle: str(r?.sourceTitle, `${where}.sourceTitle`, 500),
        sourceUrl,
        locator: str(r?.locator, `${where}.locator`, 255),
        retrievedAt,
      };
    });
    return { subjectCode, subjectName: str(u.subjectName, `units[${i}].subjectName`, 128), references };
  });
  return { curriculum, versionLabel, gradeCode, units };
}

/** Creates each unit that does not exist yet. A unit that already exists is skipped whole, never topped up. */
export async function runEvidenceSeed(
  seed: SeedFile,
  editorAccountId: string,
  admin: Pick<CurriculumAdminService, 'createSubjectVersion' | 'addEvidenceReference'>,
): Promise<string[]> {
  const report: string[] = [];
  for (const unit of seed.units) {
    let created: { id: string };
    try {
      created = await admin.createSubjectVersion(editorAccountId, {
        curriculumCode: seed.curriculum.code,
        curriculumName: seed.curriculum.name,
        versionLabel: seed.versionLabel,
        gradeCode: seed.gradeCode,
        subjectCode: unit.subjectCode,
        subjectName: unit.subjectName,
      });
    } catch (e) {
      if (e instanceof CurriculumConflictError) {
        report.push(`${unit.subjectCode}: already exists, skipped`);
        continue;
      }
      throw e;
    }
    for (const r of unit.references) {
      await admin.addEvidenceReference(editorAccountId, created.id, {
        sourceTitle: r.sourceTitle,
        sourceUrl: r.sourceUrl,
        locator: r.locator,
        retrievedAt: r.retrievedAt,
      });
    }
    report.push(`${unit.subjectCode}: created in DRAFT with ${unit.references.length} evidence references (pack NOT verified)`);
  }
  return report;
}
