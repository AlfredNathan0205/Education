import type { CurriculumRole } from '../curriculum/curriculum-state';
import {
  COGNITIVE_LEVELS,
  DIFFICULTIES,
  QUESTION_TYPES,
  type AssemblyDesign,
  type AssemblyScope,
  type CellRequirement,
  type Cognitive,
  type Difficulty,
  type QuestionType,
  type ScopeMode,
} from '../assembly/assembly-engine';

/**
 * Pure rules for assessment blueprints (Step 10). A blueprint is the design of a kind of test; each change is a
 * new version, and a published version is never edited. Nothing here touches the database.
 */

/** Edit drafts. Assumption: the same people who may write questions may draft a test design. */
export const BLUEPRINT_EDIT_ROLES: readonly CurriculumRole[] = ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'];
/** Publish a version, switch a blueprint on or off. Mirrors who may publish questions. */
export const BLUEPRINT_PUBLISH_ROLES: readonly CurriculumRole[] = ['APPROVER', 'SUPER_ADMIN'];
/** Read and preview. */
export const BLUEPRINT_READ_ROLES: readonly CurriculumRole[] = ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'];

export const SCOPE_MODES: ScopeMode[] = ['WHOLE_SUBJECT', 'CHAPTERS', 'STUDENT_FOCUS', 'OBJECTIVES'];
/**
 * OBJECTIVES (Step 14): the objectives are chosen per student by a recommendation (practice or retest), never by the
 * blueprint. Such a blueprint is not offered as an ordinary test.
 */
export const isTargeted = (mode: ScopeMode) => mode === 'OBJECTIVES';
/** The proxy allows one or two digits for a question position; keep well inside that. */
export const MAX_TOTAL = 50;
export const MAX_CELLS = 30;
export const MAX_SCOPE_CHAPTERS = 60;
const CODE = /^[A-Z][A-Z0-9_]{1,31}$/;
const CHAPTER = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

export interface SubjectBinding {
  curriculumCode: string;
  gradeCode: string;
  subjectCode: string;
}

export interface BlueprintDraft {
  totalQuestions: number;
  difficulty: Record<Difficulty, number>;
  types: Array<{ type: QuestionType; count: number }>;
  scope: { mode: ScopeMode; strict: boolean; chapters: string[] };
  cells: CellRequirement[];
  preferUnseen: boolean;
  openingDifficulty: Difficulty | null;
  notes: string | null;
}

export interface BlueprintHeader {
  code: string;
  name: string;
  description: string | null;
  subject: SubjectBinding | null;
}

export class BlueprintInputError extends Error {
  constructor(readonly problems: string[]) {
    super(problems.join('; '));
    this.name = 'BlueprintInputError';
  }
}

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const text = (v: unknown, max: number): string | null => {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t === '' ? null : t.slice(0, max + 1);
};

/** Reads a draft from a request body. Shape problems are reported together; rule problems come from validateDraft. */
export function parseDraft(raw: unknown): BlueprintDraft {
  const problems: string[] = [];
  if (!isObj(raw)) throw new BlueprintInputError(['the design must be an object']);
  const total = raw.totalQuestions;
  if (!isInt(total, 1, MAX_TOTAL)) problems.push(`totalQuestions must be a whole number from 1 to ${MAX_TOTAL}`);

  const difficulty = { EASY: 0, MEDIUM: 0, HARD: 0 } as Record<Difficulty, number>;
  if (!isObj(raw.difficulty)) problems.push('difficulty must give a count for EASY, MEDIUM and HARD');
  else {
    for (const k of Object.keys(raw.difficulty)) if (!DIFFICULTIES.includes(k as Difficulty)) problems.push(`unknown difficulty ${k}`);
    for (const d of DIFFICULTIES) {
      const v = raw.difficulty[d] ?? 0;
      if (!isInt(v, 0, MAX_TOTAL)) problems.push(`difficulty ${d} must be a whole number from 0 to ${MAX_TOTAL}`);
      else difficulty[d] = v;
    }
  }

  let types: BlueprintDraft['types'] = [];
  if (raw.types === undefined || raw.types === null) types = isInt(total, 1, MAX_TOTAL) ? [{ type: 'MCQ', count: total }] : [];
  else if (!Array.isArray(raw.types)) problems.push('types must be a list');
  else {
    for (const t of raw.types) {
      if (!isObj(t) || !QUESTION_TYPES.includes(t.type as QuestionType)) problems.push(`question type must be one of ${QUESTION_TYPES.join(', ')}`);
      else if (!isInt(t.count, 0, MAX_TOTAL)) problems.push(`type ${String(t.type)} count must be a whole number`);
      else if (types.some((x) => x.type === t.type)) problems.push(`type ${String(t.type)} is listed twice`);
      else types.push({ type: t.type as QuestionType, count: t.count });
    }
  }

  const scope: BlueprintDraft['scope'] = { mode: 'WHOLE_SUBJECT', strict: false, chapters: [] };
  if (raw.scope !== undefined) {
    if (!isObj(raw.scope)) problems.push('scope must be an object');
    else {
      if (!SCOPE_MODES.includes(raw.scope.mode as ScopeMode)) problems.push(`scope mode must be one of ${SCOPE_MODES.join(', ')}`);
      else scope.mode = raw.scope.mode as ScopeMode;
      if (raw.scope.strict !== undefined && typeof raw.scope.strict !== 'boolean') problems.push('scope strict must be true or false');
      else scope.strict = raw.scope.strict === true;
      const ch = raw.scope.chapters ?? [];
      if (!Array.isArray(ch)) problems.push('scope chapters must be a list');
      else if (ch.length > MAX_SCOPE_CHAPTERS) problems.push(`at most ${MAX_SCOPE_CHAPTERS} chapters`);
      else
        for (const c of ch) {
          if (typeof c !== 'string' || !CHAPTER.test(c.trim())) problems.push(`chapter code ${JSON.stringify(c)} is not valid`);
          else if (!scope.chapters.includes(c.trim())) scope.chapters.push(c.trim());
        }
    }
  }

  const cells: CellRequirement[] = [];
  if (raw.cells !== undefined && raw.cells !== null) {
    if (!Array.isArray(raw.cells)) problems.push('cells must be a list');
    else if (raw.cells.length > MAX_CELLS) problems.push(`at most ${MAX_CELLS} cells`);
    else
      raw.cells.forEach((c, i) => {
        const n = i + 1;
        if (!isObj(c)) return void problems.push(`cell ${n} must be an object`);
        const chapterCode = c.chapterCode === undefined || c.chapterCode === null || c.chapterCode === '' ? null : c.chapterCode;
        const diff = c.difficulty === undefined || c.difficulty === null || c.difficulty === '' ? null : c.difficulty;
        const cog = c.cognitive === undefined || c.cognitive === null || c.cognitive === '' ? null : c.cognitive;
        if (chapterCode !== null && (typeof chapterCode !== 'string' || !CHAPTER.test(chapterCode))) problems.push(`cell ${n}: chapter code is not valid`);
        if (diff !== null && !DIFFICULTIES.includes(diff as Difficulty)) problems.push(`cell ${n}: difficulty must be EASY, MEDIUM or HARD`);
        if (cog !== null && !COGNITIVE_LEVELS.includes(cog as Cognitive)) problems.push(`cell ${n}: cognitive level must be C1 to C4`);
        if (!isInt(c.minCount, 1, MAX_TOTAL)) problems.push(`cell ${n}: minCount must be a whole number of at least 1`);
        cells.push({
          chapterCode: typeof chapterCode === 'string' ? chapterCode : null,
          difficulty: (diff as Difficulty) ?? null,
          cognitive: (cog as Cognitive) ?? null,
          minCount: isInt(c.minCount, 1, MAX_TOTAL) ? c.minCount : 1,
        });
      });
  }

  let preferUnseen = true;
  if (raw.preferUnseen !== undefined) {
    if (typeof raw.preferUnseen !== 'boolean') problems.push('preferUnseen must be true or false');
    else preferUnseen = raw.preferUnseen;
  }
  let openingDifficulty: Difficulty | null = null;
  if (raw.openingDifficulty !== undefined && raw.openingDifficulty !== null && raw.openingDifficulty !== '') {
    if (!DIFFICULTIES.includes(raw.openingDifficulty as Difficulty)) problems.push('openingDifficulty must be EASY, MEDIUM, HARD or empty');
    else openingDifficulty = raw.openingDifficulty as Difficulty;
  }
  if (raw.notes !== undefined && raw.notes !== null && typeof raw.notes !== 'string') problems.push('notes must be text');
  const notes = text(raw.notes, 1000);
  if (notes && notes.length > 1000) problems.push('notes must be at most 1000 characters');

  if (problems.length) throw new BlueprintInputError(problems);
  return { totalQuestions: total as number, difficulty, types, scope, cells, preferUnseen, openingDifficulty, notes };
}

/** Rules a draft must meet to be saved. `subject` is the blueprint's binding (null = any subject). */
export function draftProblems(d: BlueprintDraft, subject: SubjectBinding | null): string[] {
  const p: string[] = [];
  const sum = DIFFICULTIES.reduce((a, k) => a + d.difficulty[k], 0);
  if (sum !== d.totalQuestions) p.push(`the difficulty counts add up to ${sum}, not ${d.totalQuestions}`);
  const typeSum = d.types.reduce((a, t) => a + t.count, 0);
  if (typeSum !== d.totalQuestions) p.push(`the question type counts add up to ${typeSum}, not ${d.totalQuestions}`);
  if (d.scope.mode === 'CHAPTERS') {
    if (!subject) p.push('a chapter scope needs the blueprint to be for one subject');
    if (d.scope.chapters.length === 0) p.push('a chapter scope needs at least one chapter');
  } else if (d.scope.chapters.length > 0) p.push('chapters can only be listed for a chapter scope');
  const cellSum = d.cells.reduce((a, c) => a + c.minCount, 0);
  if (cellSum > d.totalQuestions) p.push(`the cell minimums add up to ${cellSum}, more than ${d.totalQuestions} questions`);
  d.cells.forEach((c, i) => {
    if (c.chapterCode === null && c.difficulty === null && c.cognitive === null) p.push(`cell ${i + 1} must name a chapter, difficulty or cognitive level`);
    if (c.chapterCode !== null && !subject) p.push(`cell ${i + 1} names a chapter, so the blueprint must be for one subject`);
    if (c.chapterCode !== null && d.scope.mode === 'CHAPTERS' && !d.scope.chapters.includes(c.chapterCode)) {
      p.push(`cell ${i + 1} names chapter ${c.chapterCode}, which is outside the chapter scope`);
    }
  });
  for (const k of DIFFICULTIES) {
    const need = d.cells.filter((c) => c.difficulty === k).reduce((a, c) => a + c.minCount, 0);
    if (need > d.difficulty[k]) p.push(`cells ask for ${need} ${k} questions but the mix has ${d.difficulty[k]}`);
  }
  if (d.openingDifficulty && d.difficulty[d.openingDifficulty] === 0) p.push(`the test cannot open with ${d.openingDifficulty}: the mix has none`);
  return p;
}

export function parseHeader(raw: unknown): BlueprintHeader {
  const problems: string[] = [];
  if (!isObj(raw)) throw new BlueprintInputError(['the blueprint must be an object']);
  const code = typeof raw.code === 'string' ? raw.code.trim().toUpperCase() : '';
  if (!CODE.test(code)) problems.push('code must be 2 to 32 capital letters, digits or _ and start with a letter');
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 2 || name.length > 120) problems.push('name must be 2 to 120 characters');
  if (raw.description !== undefined && raw.description !== null && typeof raw.description !== 'string') problems.push('description must be text');
  const description = text(raw.description, 1000);
  if (description && description.length > 1000) problems.push('description must be at most 1000 characters');
  let subject: SubjectBinding | null = null;
  if (raw.subject !== undefined && raw.subject !== null) {
    const s = raw.subject;
    if (!isObj(s) || typeof s.curriculumCode !== 'string' || typeof s.gradeCode !== 'string' || typeof s.subjectCode !== 'string') {
      problems.push('subject must give curriculumCode, gradeCode and subjectCode');
    } else {
      const b = { curriculumCode: s.curriculumCode.trim(), gradeCode: s.gradeCode.trim(), subjectCode: s.subjectCode.trim() };
      if (!b.curriculumCode || b.curriculumCode.length > 32 || !b.gradeCode || b.gradeCode.length > 16 || !b.subjectCode || b.subjectCode.length > 64) {
        problems.push('subject codes are empty or too long');
      } else subject = b;
    }
  }
  if (problems.length) throw new BlueprintInputError(problems);
  return { code, name, description, subject };
}

/** Stored version rows (as Prisma returns them) to the engine's design. */
export interface VersionRow {
  version: number;
  total_questions: number;
  prefer_unseen: boolean;
  opening_difficulty: Difficulty | null;
  scope_mode: ScopeMode;
  scope_strict: boolean;
  notes?: string | null;
  difficulties: Array<{ difficulty: Difficulty; count: number }>;
  types: Array<{ question_type: QuestionType; count: number }>;
  cells: Array<{ position: number; chapter_code: string | null; difficulty: Difficulty | null; cognitive: Cognitive | null; min_count: number }>;
  scopes: Array<{ chapter_code: string }>;
}

export function designOf(code: string, v: VersionRow): AssemblyDesign {
  const difficulty = { EASY: 0, MEDIUM: 0, HARD: 0 } as Record<Difficulty, number>;
  for (const d of v.difficulties) difficulty[d.difficulty] = d.count;
  return {
    code,
    version: v.version,
    total: v.total_questions,
    difficulty,
    types: v.types.map((t) => ({ type: t.question_type, count: t.count })),
    cells: [...v.cells]
      .sort((a, b) => a.position - b.position)
      .map((c) => ({ chapterCode: c.chapter_code, difficulty: c.difficulty, cognitive: c.cognitive, minCount: c.min_count })),
    preferUnseen: v.prefer_unseen,
    openingDifficulty: v.opening_difficulty,
  };
}

export function draftOf(v: VersionRow): BlueprintDraft {
  const design = designOf('', v);
  return {
    totalQuestions: design.total,
    difficulty: design.difficulty,
    types: design.types,
    scope: { mode: v.scope_mode, strict: v.scope_strict, chapters: v.scopes.map((s) => s.chapter_code).sort() },
    cells: design.cells,
    preferUnseen: design.preferUnseen,
    openingDifficulty: design.openingDifficulty,
    notes: v.notes ?? null,
  };
}

/**
 * The scope for one assembly. `studentChapters` is the student's own focus for this subject (null in a preview,
 * where there is no student: a focus blueprint then previews the whole subject and says so). `objectives` are the
 * targets of a practice or retest set; null in a preview, which then previews the whole subject.
 */
export function resolveScope(
  v: Pick<VersionRow, 'scope_mode' | 'scope_strict' | 'scopes'>,
  studentChapters: string[] | null,
  objectives: string[] | null = null,
): AssemblyScope {
  switch (v.scope_mode) {
    case 'OBJECTIVES':
      if (objectives === null) return { mode: 'WHOLE_SUBJECT', chapters: null, strict: false };
      return { mode: 'OBJECTIVES', chapters: null, strict: v.scope_strict, objectives };
    case 'CHAPTERS':
      return { mode: 'CHAPTERS', chapters: v.scopes.map((s) => s.chapter_code), strict: v.scope_strict };
    case 'STUDENT_FOCUS':
      if (studentChapters === null) return { mode: 'STUDENT_FOCUS', chapters: null, strict: false };
      return { mode: 'STUDENT_FOCUS', chapters: studentChapters, strict: v.scope_strict };
    default:
      return { mode: 'WHOLE_SUBJECT', chapters: null, strict: false };
  }
}

/** Does a blueprint apply to this unit? Unbound blueprints apply to every subject. */
export function appliesTo(
  b: { curriculum_code: string | null; grade_code: string | null; subject_code: string | null },
  unit: { curriculumCode: string; gradeCode: string; subjectCode: string },
): boolean {
  if (b.subject_code === null) return true;
  return b.curriculum_code === unit.curriculumCode && b.grade_code === unit.gradeCode && b.subject_code === unit.subjectCode;
}
