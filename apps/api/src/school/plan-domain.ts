import { InvalidSchoolInputError } from './school-domain';

/** "2026-27": four-digit year, then the last two digits of the following year. */
export function normalizeAcademicYear(raw: unknown): string {
  if (typeof raw !== 'string') throw new InvalidSchoolInputError('Academic year must be text like 2026-27');
  const v = raw.trim();
  const m = /^(\d{4})-(\d{2})$/.exec(v);
  if (!m) throw new InvalidSchoolInputError('Academic year must look like 2026-27');
  const start = Number(m[1]);
  if (start < 2000 || start > 2100 || (start + 1) % 100 !== Number(m[2])) {
    throw new InvalidSchoolInputError('Academic year must be consecutive years, like 2026-27');
  }
  return v;
}

/** The school's own wording for a term or assessment ("Term 1", "Unit Test 2"). Never interpreted. */
export function normalizePlanLabel(raw: unknown, field: string, max: number, required: boolean): string {
  if (raw === undefined || raw === null || raw === '') {
    if (required) throw new InvalidSchoolInputError(`${field} is required`);
    return '';
  }
  if (typeof raw !== 'string') throw new InvalidSchoolInputError(`${field} must be text`);
  const v = raw.trim().replace(/\s+/g, ' ');
  if (!v && required) throw new InvalidSchoolInputError(`${field} is required`);
  if (v.length > max) throw new InvalidSchoolInputError(`${field} is too long`);
  if (/[\u0000-\u001f<>]/.test(v)) throw new InvalidSchoolInputError(`${field} contains characters that are not allowed`);
  return v;
}

export function normalizeCode(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_.\-]{1,64}$/.test(raw.trim())) {
    throw new InvalidSchoolInputError(`${field} is not a valid code`);
  }
  return raw.trim();
}

export const MAX_SELECTED_CHAPTERS = 200;

export interface ChapterRef {
  subjectCode: string;
  chapterCode: string;
}

/** Parse a student's chapter selection: array of {subjectCode, chapterCode}, deduplicated, bounded. */
export function parseSelection(raw: unknown): ChapterRef[] {
  if (!Array.isArray(raw)) throw new InvalidSchoolInputError('chapters must be a list');
  if (raw.length > MAX_SELECTED_CHAPTERS) throw new InvalidSchoolInputError('Too many chapters selected');
  const seen = new Set<string>();
  const out: ChapterRef[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) throw new InvalidSchoolInputError('Each chapter needs a subjectCode and chapterCode');
    const subjectCode = normalizeCode((item as any).subjectCode, 'subjectCode');
    const chapterCode = normalizeCode((item as any).chapterCode, 'chapterCode');
    const key = `${subjectCode}|${chapterCode}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ subjectCode, chapterCode });
  }
  return out;
}
