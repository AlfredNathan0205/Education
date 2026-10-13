import { validateCurriculumTree } from '../curriculum-validation';
import {
  ImportFormatError,
  MAX_UPLOAD_CHARS,
  countNodes,
  parseContent,
  parseCsv,
  resolveEvidence,
} from './content-import';

const HEAD = 'chapter_code,chapter_title,topic_code,topic_title,concept_code,concept_title,objective_code,objective,evidence_ref,provenance,rationale';
const row = (...c: string[]) => c.join(',');

describe('parseCsv', () => {
  it('handles quotes, doubled quotes, commas, newlines and a BOM', () => {
    const rows = parseCsv('﻿a,"b,c","d ""q"""\r\n"line\none",x,y\r\n');
    expect(rows).toEqual([['a', 'b,c', 'd "q"'], ['line\none', 'x', 'y']]);
  });
  it('skips blank lines and rejects an unclosed quote', () => {
    expect(parseCsv('a,b\n\n,\nc,d')).toEqual([['a', 'b'], ['c', 'd']]);
    expect(() => parseCsv('a,"b')).toThrow(ImportFormatError);
  });
});

describe('CSV content', () => {
  const ok = [
    HEAD,
    row('CH1', 'Chapter One', 'T1', 'Topic One', 'M1', 'Concept One', 'O1', 'Do the first thing', '1', 'OFFICIAL_INFERRED', 'Inferred from section X'),
    row('CH1', 'Chapter One', 'T1', 'Topic One', 'M1', 'Concept One', 'O2', 'Do the second thing', '1', 'OFFICIAL_INFERRED', 'Inferred from section X'),
    row('CH1', 'Chapter One', 'T2', 'Topic Two', 'M2', 'Concept Two', 'O1', 'Another objective', '2', 'OFFICIAL_INFERRED', 'Inferred from section Y'),
  ].join('\n');

  it('builds one tree, merging repeated parents and ordering by first appearance', () => {
    const { tree, issues } = parseContent('csv', ok, 'HUMAN');
    expect(issues).toEqual([]);
    expect(countNodes(tree)).toEqual({ chapters: 1, topics: 2, concepts: 2, objectives: 3 });
    expect(tree.chapters[0].topics.map((t) => [t.code, t.position])).toEqual([['T1', 0], ['T2', 1]]);
    expect(tree.chapters[0].topics[0].microConcepts[0].learningObjectives.map((l) => l.position)).toEqual([0, 1]);
  });

  it('is accepted by the structural validator once evidence numbers are resolved', () => {
    const { tree } = parseContent('csv', ok, 'HUMAN');
    expect(resolveEvidence(tree, ['ev-a', 'ev-b'])).toEqual([]);
    expect(validateCurriculumTree(tree, { referenceIds: new Set(['ev-a', 'ev-b']) }).filter((f) => f.severity === 'ERROR')).toEqual([]);
  });

  it('reports a missing required column, naming it', () => {
    expect(() => parseContent('csv', 'chapter_code,chapter_title\nA,B', 'HUMAN')).toThrow(/missing column/);
  });
  it('column order is free and header case does not matter', () => {
    const csv = ['OBJECTIVE,Objective_Code,concept_title,concept_code,topic_title,topic_code,chapter_title,chapter_code,rationale,provenance,evidence_ref',
      'Do it,O1,C,M1,T,T1,Ch,CH1,why,ADMIN_ADDED,'].join('\n');
    const { tree, issues } = parseContent('csv', csv, 'HUMAN');
    expect(issues).toEqual([]);
    expect(tree.chapters[0].topics[0].microConcepts[0].learningObjectives[0].statement).toBe('Do it');
  });
  it('flags a code reused with a different title and a repeated objective', () => {
    const csv = [HEAD,
      row('CH1', 'One', 'T1', 'T', 'M1', 'C', 'O1', 'x', '', 'ADMIN_ADDED', 'r'),
      row('CH1', 'Other title', 'T1', 'T', 'M1', 'C', 'O1', 'x', '', 'ADMIN_ADDED', 'r')].join('\n');
    const msgs = parseContent('csv', csv, 'HUMAN').issues.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/chapter CH1 appears with two different titles/);
    expect(msgs).toMatch(/objective O1 is repeated/);
  });
  it('requires all four codes on every row, with a row number', () => {
    const csv = [HEAD, row('CH1', 'One', '', 'T', 'M1', 'C', 'O1', 'x', '', '', 'r')].join('\n');
    const { issues } = parseContent('csv', csv, 'HUMAN');
    expect(issues[0]).toMatchObject({ where: 'row 2' });
  });
  it('rejects a bad evidence number and control characters; an out-of-range number is caught on resolve', () => {
    const bad = [HEAD, row('CH1', 'One', 'T1', 'T', 'M1', 'C', 'O1', 'x\u0007y', 'one', 'ADMIN_ADDED', 'r')].join('\n');
    const msgs = parseContent('csv', bad, 'HUMAN').issues.map((i) => i.message).join(' | ');
    expect(msgs).toMatch(/evidence_ref must be a whole number/);
    expect(msgs).toMatch(/control characters/);
    const far = parseContent('csv', [HEAD, row('CH1', 'One', 'T1', 'T', 'M1', 'C', 'O1', 'x', '9', 'ADMIN_ADDED', 'r')].join('\n'), 'HUMAN');
    expect(resolveEvidence(far.tree, ['only-one'])[0].message).toMatch(/does not exist/);
  });
  it('rejects over-long fields rather than silently truncating', () => {
    const csv = [HEAD, row('CH1', 'T'.repeat(300), 'T1', 'T', 'M1', 'C', 'O1', 'x', '', 'ADMIN_ADDED', 'r')].join('\n');
    expect(parseContent('csv', csv, 'HUMAN').issues.some((i) => /longer than 255/.test(i.message))).toBe(true);
  });
});

describe('who may claim what provenance', () => {
  const csvWith = (prov: string) => [HEAD, row('CH1', 'One', 'T1', 'T', 'M1', 'C', 'O1', 'x', '1', prov, 'r')].join('\n');
  it('a person may claim OFFICIAL_EXPLICIT; the AI may not, and may not claim ADMIN_ADDED', () => {
    expect(parseContent('csv', csvWith('OFFICIAL_EXPLICIT'), 'HUMAN').issues).toEqual([]);
    expect(parseContent('csv', csvWith('OFFICIAL_EXPLICIT'), 'AI').issues[0].message).toMatch(/not allowed here/);
    expect(parseContent('csv', csvWith('ADMIN_ADDED'), 'AI').issues[0].message).toMatch(/not allowed here/);
    expect(parseContent('csv', csvWith('SYSTEM_DERIVED'), 'HUMAN').issues[0].message).toMatch(/not allowed here/);
  });
  it('a blank provenance defaults to ADMIN_ADDED for people and OFFICIAL_INFERRED for the AI, and the validator then asks for a rationale', () => {
    const blank = [HEAD, row('CH1', 'One', 'T1', 'T', 'M1', 'C', 'O1', 'x', '1', '', '')].join('\n');
    const human = parseContent('csv', blank, 'HUMAN').tree;
    const ai = parseContent('csv', blank, 'AI').tree;
    expect(human.chapters[0].provenance).toBe('ADMIN_ADDED');
    expect(ai.chapters[0].provenance).toBe('OFFICIAL_INFERRED');
    resolveEvidence(ai, ['e']);
    expect(validateCurriculumTree(ai, { referenceIds: new Set(['e']) }).some((f) => f.rule === 'MISSING_RATIONALE')).toBe(true);
  });
});

describe('JSON content', () => {
  const json = {
    chapters: [{
      code: 'CH1', title: 'One', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why',
      topics: [{ code: 'T1', title: 'T', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why',
        microConcepts: [{ code: 'M1', title: 'C', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why',
          learningObjectives: [{ code: 'O1', statement: 'Do it', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why' }] }] }],
    }],
  };
  it('parses the nested form, taking positions from list order', () => {
    const { tree, issues } = parseContent('json', JSON.stringify(json), 'AI');
    expect(issues).toEqual([]);
    expect(countNodes(tree)).toEqual({ chapters: 1, topics: 1, concepts: 1, objectives: 1 });
    expect(tree.chapters[0].evidenceReferenceId).toBe('1');
  });
  it('rejects non-JSON, non-objects and wrong shapes with clear messages', () => {
    expect(() => parseContent('json', '{nope', 'AI')).toThrow(/not valid JSON/);
    expect(() => parseContent('json', '[]', 'AI')).toThrow(/JSON object/);
    expect(parseContent('json', JSON.stringify({ chapters: 'x' }), 'AI').issues[0].message).toMatch(/must be a list/);
    expect(parseContent('json', JSON.stringify({ chapters: [1] }), 'AI').issues[0].message).toMatch(/must be an object/);
  });
  it('does not let __proto__ keys reach the result', () => {
    const { tree } = parseContent('json', '{"chapters":[{"code":"C","title":"t","__proto__":{"polluted":true},"topics":[]}]}', 'AI');
    expect(({} as any).polluted).toBeUndefined();
    expect((tree.chapters[0] as any).polluted).toBeUndefined();
  });
});

describe('format and size guards', () => {
  it('rejects unknown formats, empty and oversize files', () => {
    expect(() => parseContent('xlsx' as never, 'a', 'HUMAN')).toThrow(/csv or json/);
    expect(() => parseContent('csv', '   ', 'HUMAN')).toThrow(/empty/);
    expect(() => parseContent('csv', undefined, 'HUMAN')).toThrow(/empty/);
    expect(() => parseContent('csv', 'a'.repeat(MAX_UPLOAD_CHARS + 1), 'HUMAN')).toThrow(/too large/);
  });
});
