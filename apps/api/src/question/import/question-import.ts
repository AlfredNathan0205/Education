/**
 * Reads a question file (CSV or JSON) into drafts, with row-level issues. Pure: no database.
 * Nothing is silently trimmed or guessed: a problem is reported against its row or path.
 */
import { parseCsv } from '../../curriculum/import/content-import';
import {
  COGNITIVE_LEVELS,
  DIFFICULTIES,
  LIMITS,
  OPTION_COUNT,
  OPTION_LABELS,
  validateQuestionDraft,
  type QuestionCognitive,
  type QuestionDifficulty,
  type QuestionDraft,
} from '../question-domain';

export type QuestionFormat = 'csv' | 'json';
export const MAX_QUESTION_UPLOAD_CHARS = 2_000_000;
export const MAX_QUESTIONS = 2_000;

export interface QuestionIssue {
  where: string;
  message: string;
}

export class QuestionFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionFormatError';
  }
}

export interface ParsedQuestions {
  questions: { where: string; draft: QuestionDraft }[];
  issues: QuestionIssue[];
  /** From a JSON file's optional header (the AI import needs it, a person's upload does not). */
  header: Record<string, string> | null;
}

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function text(raw: unknown, where: string, what: string, issues: QuestionIssue[]): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    issues.push({ where, message: `${what} must be text` });
    return '';
  }
  if (CONTROL.test(raw)) issues.push({ where, message: `${what} contains control characters` });
  return raw.replace(/\s+/g, ' ').trim();
}

function correctIndex(raw: string, where: string, issues: QuestionIssue[]): number {
  const v = raw.trim().toUpperCase();
  const i = (OPTION_LABELS as readonly string[]).indexOf(v);
  if (i < 0) issues.push({ where, message: `correct must be A, B, C or D (got "${raw}")` });
  return i;
}

function difficulty(raw: string, where: string, issues: QuestionIssue[]): QuestionDifficulty {
  const v = raw.trim().toUpperCase() as QuestionDifficulty;
  if (!DIFFICULTIES.includes(v)) {
    issues.push({ where, message: `difficulty must be EASY, MEDIUM or HARD (got "${raw}")` });
  }
  return v;
}

function cognitive(raw: string, where: string, issues: QuestionIssue[]): QuestionCognitive | null {
  if (raw.trim() === '') return null;
  const v = raw.trim().toUpperCase() as QuestionCognitive;
  if (!COGNITIVE_LEVELS.includes(v)) {
    issues.push({ where, message: `cognitive must be C1, C2, C3 or C4 (got "${raw}")` });
    return null;
  }
  return v;
}

function finish(drafts: { where: string; draft: QuestionDraft }[], issues: QuestionIssue[]): void {
  const codes = new Map<string, string>();
  const stems = new Map<string, string>();
  for (const { where, draft } of drafts) {
    for (const p of validateQuestionDraft(draft)) issues.push({ where, message: p });
    const code = draft.code.toLowerCase();
    if (code && codes.has(code)) issues.push({ where, message: `question code ${draft.code} is repeated (first at ${codes.get(code)})` });
    else if (code) codes.set(code, where);
    const stem = draft.stem.replace(/\s+/g, ' ').trim().toLowerCase();
    if (stem && stems.has(stem)) issues.push({ where, message: `the same question wording appears at ${stems.get(stem)}` });
    else if (stem) stems.set(stem, where);
  }
}

const CSV_HEADERS = [
  'question_code', 'objective_code', 'stem', 'option_a', 'option_b', 'option_c', 'option_d',
  'correct', 'difficulty', 'cognitive', 'explanation',
] as const;

export function parseQuestionsCsv(src: string): ParsedQuestions {
  const issues: QuestionIssue[] = [];
  const rows = parseCsv(src);
  if (rows.length < 2) throw new QuestionFormatError('the file needs a header row and at least one question');
  if (rows.length - 1 > MAX_QUESTIONS) throw new QuestionFormatError(`more than ${MAX_QUESTIONS} questions in one file`);
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const required = CSV_HEADERS.filter((h) => h !== 'explanation' && h !== 'cognitive');
  const missing = required.filter((h) => !header.includes(h));
  if (missing.length) throw new QuestionFormatError(`missing column(s): ${missing.join(', ')}`);
  const col = (h: string) => header.indexOf(h);

  const out: ParsedQuestions['questions'] = [];
  for (let r = 1; r < rows.length; r++) {
    const where = `row ${r + 1}`;
    const cell = (h: string) => text(col(h) < 0 ? '' : rows[r][col(h)], where, h, issues);
    const explanation = cell('explanation');
    out.push({
      where,
      draft: {
        code: cell('question_code').toUpperCase(),
        objectiveCode: cell('objective_code'),
        stem: cell('stem'),
        options: ['option_a', 'option_b', 'option_c', 'option_d'].map(cell),
        correctIndex: correctIndex(cell('correct'), where, issues),
        difficulty: difficulty(cell('difficulty'), where, issues),
        cognitive: cognitive(cell('cognitive'), where, issues),
        explanation: explanation === '' ? null : explanation,
      },
    });
  }
  finish(out, issues);
  return { questions: out, issues, header: null };
}

export function parseQuestionsJson(src: string): ParsedQuestions {
  let raw: unknown;
  try {
    raw = JSON.parse(src);
  } catch {
    throw new QuestionFormatError('the file is not valid JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new QuestionFormatError('the file must be a JSON object with a "questions" list');
  }
  const obj = raw as Record<string, unknown>;
  if (!Array.isArray(obj.questions)) throw new QuestionFormatError('the file must have a "questions" list');
  if (obj.questions.length > MAX_QUESTIONS) throw new QuestionFormatError(`more than ${MAX_QUESTIONS} questions in one file`);

  const issues: QuestionIssue[] = [];
  const out: ParsedQuestions['questions'] = [];
  obj.questions.forEach((q, i) => {
    const where = `/questions/${i}`;
    if (typeof q !== 'object' || q === null || Array.isArray(q)) {
      issues.push({ where, message: 'each question must be an object' });
      return;
    }
    const o = q as Record<string, unknown>;
    const options = Array.isArray(o.options) ? o.options.map((x, k) => text(x, `${where}/options/${k}`, 'option', issues)) : [];
    if (!Array.isArray(o.options)) issues.push({ where, message: `options must be a list of ${OPTION_COUNT} texts` });
    const explanation = text(o.explanation, where, 'explanation', issues);
    out.push({
      where,
      draft: {
        code: text(o.code, where, 'code', issues).toUpperCase(),
        objectiveCode: text(o.objectiveCode, where, 'objectiveCode', issues),
        stem: text(o.stem, where, 'stem', issues),
        options,
        correctIndex: correctIndex(text(o.correct, where, 'correct', issues), where, issues),
        difficulty: difficulty(text(o.difficulty, where, 'difficulty', issues), where, issues),
        cognitive: cognitive(text(o.cognitive, where, 'cognitive', issues), where, issues),
        explanation: explanation === '' ? null : explanation,
      },
    });
  });
  finish(out, issues);
  const header =
    typeof obj.header === 'object' && obj.header !== null && !Array.isArray(obj.header)
      ? Object.fromEntries(Object.entries(obj.header as Record<string, unknown>).filter(([, v]) => typeof v === 'string')) as Record<string, string>
      : null;
  const top = ['curriculumCode', 'versionLabel', 'gradeCode', 'subjectCode']
    .filter((k) => typeof obj[k] === 'string')
    .reduce<Record<string, string>>((a, k) => ({ ...a, [k]: obj[k] as string }), {});
  return { questions: out, issues, header: header ?? (Object.keys(top).length ? top : null) };
}

export function parseQuestions(format: QuestionFormat, src: unknown): ParsedQuestions {
  if (format !== 'csv' && format !== 'json') throw new QuestionFormatError('format must be csv or json');
  if (typeof src !== 'string' || src.trim() === '') throw new QuestionFormatError('the file is empty');
  if (src.length > MAX_QUESTION_UPLOAD_CHARS) throw new QuestionFormatError('the file is too large');
  return format === 'csv' ? parseQuestionsCsv(src) : parseQuestionsJson(src);
}

export { LIMITS };
