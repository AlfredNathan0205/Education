import {
  hasErrors,
  validateCurriculumTree,
  type ChapterNode,
  type CurriculumTree,
} from './curriculum-validation';

const REF = 'ref-1';
const ev = { referenceIds: new Set([REF]) };

/** Structural fixture only. Not syllabus content. */
const good = (): CurriculumTree => ({
  chapters: [
    {
      code: 'C1', title: 'Chapter', position: 0, provenance: 'OFFICIAL_EXPLICIT',
      evidenceReferenceId: REF, rationale: null,
      topics: [
        {
          code: 'T1', title: 'Topic', position: 0, provenance: 'OFFICIAL_EXPLICIT',
          evidenceReferenceId: REF, rationale: null,
          microConcepts: [
            {
              code: 'M1', title: 'Micro', position: 0, provenance: 'OFFICIAL_EXPLICIT',
              evidenceReferenceId: REF, rationale: null,
              learningObjectives: [
                {
                  code: 'L1', statement: 'Objective', position: 0,
                  provenance: 'OFFICIAL_EXPLICIT', evidenceReferenceId: REF, rationale: null,
                },
              ],
            },
          ],
        },
      ],
    },
  ],
});

const rules = (t: CurriculumTree, e = ev) => validateCurriculumTree(t, e).map((f) => f.rule);

describe('validateCurriculumTree', () => {
  it('passes a well-formed, fully evidenced tree with no findings', () => {
    expect(validateCurriculumTree(good(), ev)).toEqual([]);
  });

  it('errors on an empty tree and an empty evidence pack', () => {
    const r = rules({ chapters: [] }, { referenceIds: new Set() });
    expect(r).toEqual(expect.arrayContaining(['EMPTY_TREE', 'EVIDENCE_PACK_EMPTY']));
  });

  it('errors when an official claim cites no evidence', () => {
    const t = good();
    t.chapters[0].evidenceReferenceId = null;
    expect(rules(t)).toContain('MISSING_EVIDENCE');
  });

  it('errors when evidence is outside the version pack', () => {
    const t = good();
    t.chapters[0].topics[0].evidenceReferenceId = 'someone-elses';
    expect(rules(t)).toContain('UNKNOWN_EVIDENCE');
  });

  it('inferred, derived and admin-added nodes need a rationale', () => {
    const t = good();
    t.chapters[0].provenance = 'OFFICIAL_INFERRED';
    expect(rules(t)).toContain('MISSING_RATIONALE');
    t.chapters[0].rationale = 'Grouping implied by the official list';
    expect(rules(t)).not.toContain('MISSING_RATIONALE');
  });

  it('flags non-official nodes as warnings for the reviewer, not errors', () => {
    const t = good();
    const lo = t.chapters[0].topics[0].microConcepts[0].learningObjectives[0];
    lo.provenance = 'ADMIN_ADDED';
    lo.evidenceReferenceId = null;
    lo.rationale = 'Added by editor';
    const f = validateCurriculumTree(t, ev);
    expect(hasErrors(f)).toBe(false);
    expect(f.map((x) => x.rule)).toEqual(['NOT_OFFICIAL']);
  });

  it('errors on empty children at every level', () => {
    const t = good();
    t.chapters[0].topics[0].microConcepts[0].learningObjectives = [];
    expect(rules(t)).toContain('EMPTY_CHILDREN');
    const t2 = good();
    t2.chapters[0].topics[0].microConcepts = [];
    expect(rules(t2)).toContain('EMPTY_CHILDREN');
    const t3 = good();
    t3.chapters[0].topics = [];
    expect(rules(t3)).toContain('EMPTY_CHILDREN');
  });

  it('errors on duplicate codes, bad codes, bad positions and blank titles', () => {
    const t = good();
    const c2: ChapterNode = JSON.parse(JSON.stringify(t.chapters[0]));
    t.chapters.push(c2);
    expect(rules(t)).toEqual(expect.arrayContaining(['DUPLICATE_CODE', 'BAD_POSITION']));

    const t2 = good();
    t2.chapters[0].code = 'has space';
    t2.chapters[0].title = '  ';
    expect(rules(t2)).toEqual(expect.arrayContaining(['BAD_CODE', 'EMPTY_TITLE']));
  });

  it('reports a path so a reviewer can find the node', () => {
    const t = good();
    t.chapters[0].topics[0].microConcepts[0].learningObjectives[0].statement = '';
    const f = validateCurriculumTree(t, ev);
    expect(f[0].path).toBe('/chapters/C1/topics/T1/microConcepts/M1/learningObjectives/L1');
  });
});
