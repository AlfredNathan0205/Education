/**
 * Pure parsing of uploaded curriculum content (CSV or JSON) into a CurriculumTree.
 *
 * Nothing here touches the database or decides whether content is RIGHT: it checks that the
 * file is readable, within size limits, and that every node says where it came from. Structural
 * validation (codes, evidence, rationale, duplicates) is still done by validateCurriculumTree.
 *
 * Evidence is referenced by a 1-based number: "1" is the first evidence reference of the unit's
 * pack. Uploaders never see database ids.
 */
import type { CurriculumTree, NodeBase, Provenance } from '../curriculum-validation';

export const MAX_UPLOAD_CHARS = 2_000_000;
export const MAX_ROWS = 20_000;

export type ImportFormat = 'csv' | 'json';
export type Uploader = 'HUMAN' | 'AI';

/** A person may claim official provenance; AI may only INFER or derive, so a human must confirm anything "explicit". */
const ALLOWED: Record<Uploader, readonly Provenance[]> = {
  HUMAN: ['OFFICIAL_EXPLICIT', 'OFFICIAL_INFERRED', 'ADMIN_ADDED'],
  AI: ['OFFICIAL_INFERRED', 'SYSTEM_DERIVED'],
};

export interface ImportIssue {
  /** CSV: "row 12"; JSON: a path like /chapters/0/topics/1. */
  where: string;
  message: string;
}

export interface ParsedContent {
  /** evidenceReferenceId holds the 1-based reference NUMBER as a string until resolveEvidence runs. */
  tree: CurriculumTree;
  issues: ImportIssue[];
}

export class ImportFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportFormatError';
  }
}

const LIMITS = { code: 64, title: 255, objective: 1000, rationale: 1000 };
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function clean(raw: unknown, max: number, where: string, what: string, issues: ImportIssue[]): string {
  if (raw === undefined || raw === null) return '';
  if (typeof raw !== 'string') {
    issues.push({ where, message: `${what} must be text` });
    return '';
  }
  const v = raw.replace(/\s+/g, ' ').trim();
  if (CONTROL.test(raw)) issues.push({ where, message: `${what} contains control characters` });
  if (v.length > max) {
    issues.push({ where, message: `${what} is longer than ${max} characters` });
    return v.slice(0, max);
  }
  return v;
}

/* ------------------------------------------------------------------ CSV */

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else inQuotes = false;
      } else field += c;
    } else if (c === '"' && field === '') inQuotes = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      field = '';
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      if (rows.length > MAX_ROWS) throw new ImportFormatError(`more than ${MAX_ROWS} rows`);
    } else field += c;
  }
  if (inQuotes) throw new ImportFormatError('a quoted value is never closed');
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const HEADERS = [
  'chapter_code', 'chapter_title', 'topic_code', 'topic_title', 'concept_code', 'concept_title',
  'objective_code', 'objective', 'evidence_ref', 'provenance', 'rationale',
] as const;
type Header = (typeof HEADERS)[number];

function emptyBase(position: number): NodeBase {
  return { code: '', position, provenance: 'ADMIN_ADDED', evidenceReferenceId: null, rationale: null };
}

function provenanceOf(raw: string, who: Uploader, where: string, issues: ImportIssue[]): Provenance {
  if (raw === '') return who === 'AI' ? 'OFFICIAL_INFERRED' : 'ADMIN_ADDED';
  const p = raw.toUpperCase().replace(/[\s-]+/g, '_') as Provenance;
  if (!ALLOWED[who].includes(p)) {
    issues.push({ where, message: `provenance "${raw}" is not allowed here (allowed: ${ALLOWED[who].join(', ')})` });
  }
  return p;
}

function evidenceNumber(raw: string, where: string, issues: ImportIssue[]): string | null {
  if (raw === '') return null;
  if (!/^[1-9][0-9]{0,2}$/.test(raw)) {
    issues.push({ where, message: `evidence_ref must be a whole number such as 1 or 2 (got "${raw}")` });
    return null;
  }
  return raw;
}

/**
 * One row per learning objective. A parent (chapter/topic/concept) is introduced by its first row;
 * later rows repeat its code. The provenance, evidence_ref and rationale on a row apply to every node
 * that row introduces. A code reused with a different title is an error, never a silent merge.
 */
export function parseCsvContent(text: string, who: Uploader): ParsedContent {
  const issues: ImportIssue[] = [];
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ImportFormatError('the file needs a header row and at least one data row');
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const missing = HEADERS.filter((h) => !header.includes(h));
  if (missing.length) throw new ImportFormatError(`missing column(s): ${missing.join(', ')}`);
  const idx = Object.fromEntries(HEADERS.map((h) => [h, header.indexOf(h)])) as Record<Header, number>;

  const tree: CurriculumTree = { chapters: [] };
  for (let r = 1; r < rows.length; r++) {
    const where = `row ${r + 1}`;
    const cell = (h: Header, max: number) => clean(rows[r][idx[h]], max, where, h, issues);
    const chapterCode = cell('chapter_code', LIMITS.code);
    const topicCode = cell('topic_code', LIMITS.code);
    const conceptCode = cell('concept_code', LIMITS.code);
    const objectiveCode = cell('objective_code', LIMITS.code);
    if (!chapterCode || !topicCode || !conceptCode || !objectiveCode) {
      issues.push({ where, message: 'chapter_code, topic_code, concept_code and objective_code are all required' });
      continue;
    }
    const provenance = provenanceOf(cell('provenance', 40), who, where, issues);
    const evidence = evidenceNumber(cell('evidence_ref', 10), where, issues);
    const rationale = cell('rationale', LIMITS.rationale) || null;
    const meta = (position: number): NodeBase => ({ ...emptyBase(position), provenance, evidenceReferenceId: evidence, rationale });
    const checkTitle = (existing: string, incoming: string, label: string, code: string) => {
      if (incoming !== '' && existing !== incoming) {
        issues.push({ where, message: `${label} ${code} appears with two different titles` });
      }
    };

    let ch = tree.chapters.find((c) => c.code === chapterCode);
    const chTitle = cell('chapter_title', LIMITS.title);
    if (!ch) {
      ch = { ...meta(tree.chapters.length), code: chapterCode, title: chTitle, topics: [] };
      tree.chapters.push(ch);
    } else checkTitle(ch.title, chTitle, 'chapter', chapterCode);

    let tp = ch.topics.find((t) => t.code === topicCode);
    const tpTitle = cell('topic_title', LIMITS.title);
    if (!tp) {
      tp = { ...meta(ch.topics.length), code: topicCode, title: tpTitle, microConcepts: [] };
      ch.topics.push(tp);
    } else checkTitle(tp.title, tpTitle, 'topic', topicCode);

    let mc = tp.microConcepts.find((m) => m.code === conceptCode);
    const mcTitle = cell('concept_title', LIMITS.title);
    if (!mc) {
      mc = { ...meta(tp.microConcepts.length), code: conceptCode, title: mcTitle, learningObjectives: [] };
      tp.microConcepts.push(mc);
    } else checkTitle(mc.title, mcTitle, 'concept', conceptCode);

    if (mc.learningObjectives.some((l) => l.code === objectiveCode)) {
      issues.push({ where, message: `objective ${objectiveCode} is repeated under concept ${conceptCode}` });
      continue;
    }
    mc.learningObjectives.push({
      ...meta(mc.learningObjectives.length),
      code: objectiveCode,
      statement: cell('objective', LIMITS.objective),
    });
  }
  return { tree, issues };
}

/* ----------------------------------------------------------------- JSON */

type Raw = Record<string, unknown>;
const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);

function jsonBase(n: Raw, position: number, who: Uploader, where: string, issues: ImportIssue[]): NodeBase {
  const provenance = provenanceOf(clean(n.provenance, 40, where, 'provenance', issues), who, where, issues);
  const ref = n.evidenceRef === undefined || n.evidenceRef === null ? '' : String(n.evidenceRef);
  const rationale = clean(n.rationale, LIMITS.rationale, where, 'rationale', issues) || null;
  return {
    code: clean(n.code, LIMITS.code, where, 'code', issues),
    position,
    provenance,
    evidenceReferenceId: evidenceNumber(ref, where, issues),
    rationale,
  };
}

function list(v: unknown, where: string, what: string, issues: ImportIssue[]): Raw[] {
  if (v === undefined) return [];
  if (!Array.isArray(v)) {
    issues.push({ where, message: `${what} must be a list` });
    return [];
  }
  return v.filter((x, i) => {
    if (isObj(x)) return true;
    issues.push({ where: `${where}/${i}`, message: `${what} entry must be an object` });
    return false;
  }) as Raw[];
}

export function parseJsonContent(text: string, who: Uploader): ParsedContent {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new ImportFormatError('the file is not valid JSON');
  }
  if (!isObj(raw)) throw new ImportFormatError('the file must contain a JSON object with a "chapters" list');
  const issues: ImportIssue[] = [];
  const chapters = list(raw.chapters, '/chapters', 'chapters', issues).map((c, ci) => {
    const w = `/chapters/${ci}`;
    return {
      ...jsonBase(c, ci, who, w, issues),
      title: clean(c.title, LIMITS.title, w, 'title', issues),
      topics: list(c.topics, `${w}/topics`, 'topics', issues).map((t, ti) => {
        const tw = `${w}/topics/${ti}`;
        return {
          ...jsonBase(t, ti, who, tw, issues),
          title: clean(t.title, LIMITS.title, tw, 'title', issues),
          microConcepts: list(t.microConcepts, `${tw}/microConcepts`, 'microConcepts', issues).map((m, mi) => {
            const mw = `${tw}/microConcepts/${mi}`;
            return {
              ...jsonBase(m, mi, who, mw, issues),
              title: clean(m.title, LIMITS.title, mw, 'title', issues),
              learningObjectives: list(m.learningObjectives, `${mw}/learningObjectives`, 'learningObjectives', issues).map((l, li) => {
                const lw = `${mw}/learningObjectives/${li}`;
                return {
                  ...jsonBase(l, li, who, lw, issues),
                  statement: clean(l.statement, LIMITS.objective, lw, 'statement', issues),
                };
              }),
            };
          }),
        };
      }),
    };
  });
  return { tree: { chapters }, issues };
}

export function parseContent(format: ImportFormat, text: unknown, who: Uploader): ParsedContent {
  if (format !== 'csv' && format !== 'json') throw new ImportFormatError('format must be csv or json');
  if (typeof text !== 'string' || text.trim() === '') throw new ImportFormatError('the file is empty');
  if (text.length > MAX_UPLOAD_CHARS) throw new ImportFormatError('the file is too large');
  return format === 'csv' ? parseCsvContent(text, who) : parseJsonContent(text, who);
}

/**
 * Replace evidence NUMBERS with the real ids of the unit's evidence references (in pack order).
 * A number beyond the pack is an issue, not a silent null.
 */
export function resolveEvidence(tree: CurriculumTree, referenceIds: readonly string[]): ImportIssue[] {
  const issues: ImportIssue[] = [];
  const fix = (n: NodeBase, where: string) => {
    if (n.evidenceReferenceId === null) return;
    const i = Number(n.evidenceReferenceId) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= referenceIds.length) {
      issues.push({ where, message: `evidence_ref ${n.evidenceReferenceId} does not exist (this unit has ${referenceIds.length})` });
      n.evidenceReferenceId = null;
    } else n.evidenceReferenceId = referenceIds[i];
  };
  tree.chapters.forEach((c) => {
    fix(c, `chapter ${c.code}`);
    c.topics.forEach((t) => {
      fix(t, `topic ${t.code}`);
      t.microConcepts.forEach((m) => {
        fix(m, `concept ${m.code}`);
        m.learningObjectives.forEach((l) => fix(l, `objective ${l.code}`));
      });
    });
  });
  return issues;
}

export function countNodes(tree: CurriculumTree) {
  let topics = 0, concepts = 0, objectives = 0;
  for (const c of tree.chapters) {
    topics += c.topics.length;
    for (const t of c.topics) {
      concepts += t.microConcepts.length;
      for (const m of t.microConcepts) objectives += m.learningObjectives.length;
    }
  }
  return { chapters: tree.chapters.length, topics, concepts, objectives };
}
