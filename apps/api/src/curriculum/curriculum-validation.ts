/**
 * Automated structural validation of a curriculum subject-version tree.
 * Pure. It checks that the tree is well formed and traceable to evidence; it does
 * NOT judge whether the syllabus content is correct (that is the human reviewer's job).
 */

export type Provenance =
  'OFFICIAL_EXPLICIT' | 'OFFICIAL_INFERRED' | 'SYSTEM_DERIVED' | 'ADMIN_ADDED';

export interface NodeBase {
  code: string;
  position: number;
  provenance: Provenance;
  evidenceReferenceId: string | null;
  /** Why an ADMIN_ADDED / SYSTEM_DERIVED / OFFICIAL_INFERRED node exists. */
  rationale: string | null;
}
export interface LearningObjectiveNode extends NodeBase {
  statement: string;
}
export interface MicroConceptNode extends NodeBase {
  title: string;
  learningObjectives: LearningObjectiveNode[];
}
export interface TopicNode extends NodeBase {
  title: string;
  microConcepts: MicroConceptNode[];
}
export interface ChapterNode extends NodeBase {
  title: string;
  topics: TopicNode[];
}
export interface CurriculumTree {
  chapters: ChapterNode[];
}

export interface EvidenceContext {
  /** Ids of evidence references that belong to this version's evidence pack. */
  referenceIds: ReadonlySet<string>;
}

export interface ValidationFinding {
  severity: 'ERROR' | 'WARNING';
  rule: string;
  path: string;
  message: string;
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function validateCurriculumTree(
  tree: CurriculumTree,
  evidence: EvidenceContext,
): ValidationFinding[] {
  const out: ValidationFinding[] = [];
  const add = (severity: 'ERROR' | 'WARNING', rule: string, path: string, message: string) =>
    out.push({ severity, rule, path, message });

  if (evidence.referenceIds.size === 0) {
    add('ERROR', 'EVIDENCE_PACK_EMPTY', '/', 'the evidence pack has no references');
  }
  if (tree.chapters.length === 0) add('ERROR', 'EMPTY_TREE', '/', 'the version has no chapters');

  const checkNode = (n: NodeBase, label: string, path: string) => {
    if (!CODE.test(n.code)) add('ERROR', 'BAD_CODE', path, `${label} code "${n.code}" is not valid`);
    const needsEvidence = n.provenance === 'OFFICIAL_EXPLICIT' || n.provenance === 'OFFICIAL_INFERRED';
    if (needsEvidence) {
      if (n.evidenceReferenceId === null) {
        add('ERROR', 'MISSING_EVIDENCE', path, `${label} claims ${n.provenance} but cites no evidence`);
      } else if (!evidence.referenceIds.has(n.evidenceReferenceId)) {
        add('ERROR', 'UNKNOWN_EVIDENCE', path, `${label} cites evidence outside this version's pack`);
      }
    }
    const needsRationale = n.provenance !== 'OFFICIAL_EXPLICIT';
    if (needsRationale && (n.rationale === null || n.rationale.trim() === '')) {
      add('ERROR', 'MISSING_RATIONALE', path, `${label} is ${n.provenance} and needs a rationale`);
    }
    if (n.provenance === 'SYSTEM_DERIVED' || n.provenance === 'ADMIN_ADDED') {
      add('WARNING', 'NOT_OFFICIAL', path, `${label} is ${n.provenance}; reviewer must confirm`);
    }
  };

  const dupes = (codes: string[]): string[] => codes.filter((c, i) => codes.indexOf(c) !== i);
  const positions = (items: { position: number }[], path: string) => {
    const seen = new Set<number>();
    for (const it of items) {
      if (!Number.isInteger(it.position) || it.position < 0 || seen.has(it.position)) {
        add('ERROR', 'BAD_POSITION', path, 'positions must be unique non-negative integers');
        return;
      }
      seen.add(it.position);
    }
  };

  positions(tree.chapters, '/chapters');
  for (const d of dupes(tree.chapters.map((c) => c.code))) add('ERROR', 'DUPLICATE_CODE', '/chapters', `duplicate chapter code ${d}`);

  tree.chapters.forEach((ch) => {
    const cp = `/chapters/${ch.code}`;
    checkNode(ch, 'chapter', cp);
    if (ch.title.trim() === '') add('ERROR', 'EMPTY_TITLE', cp, 'chapter title is empty');
    if (ch.topics.length === 0) add('ERROR', 'EMPTY_CHILDREN', cp, 'chapter has no topics');
    positions(ch.topics, `${cp}/topics`);
    for (const d of dupes(ch.topics.map((t) => t.code))) add('ERROR', 'DUPLICATE_CODE', cp, `duplicate topic code ${d}`);

    ch.topics.forEach((tp) => {
      const tpp = `${cp}/topics/${tp.code}`;
      checkNode(tp, 'topic', tpp);
      if (tp.title.trim() === '') add('ERROR', 'EMPTY_TITLE', tpp, 'topic title is empty');
      if (tp.microConcepts.length === 0) add('ERROR', 'EMPTY_CHILDREN', tpp, 'topic has no micro-concepts');
      positions(tp.microConcepts, `${tpp}/microConcepts`);
      for (const d of dupes(tp.microConcepts.map((m) => m.code))) add('ERROR', 'DUPLICATE_CODE', tpp, `duplicate micro-concept code ${d}`);

      tp.microConcepts.forEach((mc) => {
        const mp = `${tpp}/microConcepts/${mc.code}`;
        checkNode(mc, 'micro-concept', mp);
        if (mc.title.trim() === '') add('ERROR', 'EMPTY_TITLE', mp, 'micro-concept title is empty');
        if (mc.learningObjectives.length === 0) add('ERROR', 'EMPTY_CHILDREN', mp, 'micro-concept has no learning objectives');
        positions(mc.learningObjectives, `${mp}/learningObjectives`);
        for (const d of dupes(mc.learningObjectives.map((l) => l.code))) add('ERROR', 'DUPLICATE_CODE', mp, `duplicate learning-objective code ${d}`);

        mc.learningObjectives.forEach((lo) => {
          const lp = `${mp}/learningObjectives/${lo.code}`;
          checkNode(lo, 'learning objective', lp);
          if (lo.statement.trim() === '') add('ERROR', 'EMPTY_TITLE', lp, 'learning objective statement is empty');
        });
      });
    });
  });

  return out;
}

export const hasErrors = (findings: ValidationFinding[]): boolean =>
  findings.some((f) => f.severity === 'ERROR');
