import {
  BlueprintInputError,
  appliesTo,
  designOf,
  draftOf,
  draftProblems,
  parseDraft,
  parseHeader,
  resolveScope,
  type VersionRow,
} from './blueprint-domain';

const base = { totalQuestions: 10, difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 } };
const subject = { curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHY' };

describe('parseDraft', () => {
  it('fills defaults: MCQ for every question, whole subject, prefer unseen', () => {
    expect(parseDraft(base)).toEqual({
      totalQuestions: 10,
      difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 },
      types: [{ type: 'MCQ', count: 10 }],
      scope: { mode: 'WHOLE_SUBJECT', strict: false, chapters: [] },
      cells: [],
      preferUnseen: true,
      openingDifficulty: null,
      notes: null,
    });
  });

  it('reports every shape problem at once', () => {
    try {
      parseDraft({ totalQuestions: 0, difficulty: { EASY: -1, D5: 1 }, scope: { mode: 'TERM' }, cells: [{ minCount: 0, cognitive: 'C9' }], openingDifficulty: 'D1' });
      fail('expected an error');
    } catch (e) {
      expect(e).toBeInstanceOf(BlueprintInputError);
      const p = (e as BlueprintInputError).problems.join('|');
      expect(p).toMatch(/totalQuestions/);
      expect(p).toMatch(/unknown difficulty D5/);
      expect(p).toMatch(/difficulty EASY/);
      expect(p).toMatch(/scope mode/);
      expect(p).toMatch(/cell 1: cognitive/);
      expect(p).toMatch(/cell 1: minCount/);
      expect(p).toMatch(/openingDifficulty/);
    }
  });

  it('refuses a non-object and an unknown question type', () => {
    expect(() => parseDraft(null)).toThrow(BlueprintInputError);
    expect(() => parseDraft({ ...base, types: [{ type: 'ESSAY', count: 10 }] })).toThrow(/question type/);
  });

  it('trims and de-duplicates scope chapters', () => {
    expect(parseDraft({ ...base, scope: { mode: 'CHAPTERS', chapters: [' CH01 ', 'CH01', 'CH02'] } }).scope.chapters).toEqual(['CH01', 'CH02']);
  });
});

describe('draftProblems', () => {
  it('accepts the Quick 10 design', () => {
    expect(draftProblems(parseDraft({ ...base, openingDifficulty: 'EASY' }), null)).toEqual([]);
  });

  it('needs the counts to add up', () => {
    const p = draftProblems(parseDraft({ totalQuestions: 20, difficulty: { EASY: 8, MEDIUM: 7, HARD: 4 }, types: [{ type: 'MCQ', count: 19 }] }), null);
    expect(p).toEqual(expect.arrayContaining([expect.stringMatching(/add up to 19, not 20/), expect.stringMatching(/type counts add up to 19/)]));
  });

  it('needs a subject for a chapter scope or a chapter cell', () => {
    const d = parseDraft({ ...base, scope: { mode: 'CHAPTERS', chapters: ['CH01'] }, cells: [{ chapterCode: 'CH01', minCount: 1 }] });
    expect(draftProblems(d, null)).toEqual(expect.arrayContaining([expect.stringMatching(/chapter scope needs the blueprint to be for one subject/), expect.stringMatching(/cell 1 names a chapter/)]));
    expect(draftProblems(d, subject)).toEqual([]);
  });

  it('keeps cells inside the scope and inside the mix', () => {
    const d = parseDraft({
      ...base,
      scope: { mode: 'CHAPTERS', chapters: ['CH01'] },
      cells: [{ chapterCode: 'CH02', minCount: 1 }, { difficulty: 'HARD', minCount: 3 }, { minCount: 1 }],
    });
    const p = draftProblems(d, subject).join('|');
    expect(p).toMatch(/outside the chapter scope/);
    expect(p).toMatch(/cells ask for 3 HARD questions but the mix has 2/);
    expect(p).toMatch(/cell 3 must name/);
  });

  it('refuses cell minimums above the total, chapters on a non-chapter scope, and an impossible opening', () => {
    const d = parseDraft({ ...base, difficulty: { EASY: 10, MEDIUM: 0, HARD: 0 }, openingDifficulty: 'HARD', scope: { mode: 'WHOLE_SUBJECT', chapters: ['CH01'] }, cells: [{ cognitive: 'C1', minCount: 11 }] });
    const p = draftProblems(d, subject).join('|');
    expect(p).toMatch(/cell minimums add up to 11/);
    expect(p).toMatch(/chapters can only be listed/);
    expect(p).toMatch(/cannot open with HARD/);
  });
});

describe('parseHeader', () => {
  it('upper-cases the code and reads an optional subject', () => {
    expect(parseHeader({ code: 'subject20', name: 'Subject test (20)', subject })).toEqual({ code: 'SUBJECT20', name: 'Subject test (20)', description: null, subject });
  });
  it('refuses bad codes, names and partial subjects', () => {
    expect(() => parseHeader({ code: '1X', name: 'ok name' })).toThrow(/code/);
    expect(() => parseHeader({ code: 'OK', name: 'x' })).toThrow(/name/);
    expect(() => parseHeader({ code: 'OK', name: 'ok name', subject: { curriculumCode: 'ICSE' } })).toThrow(/subject/);
  });
});

describe('stored versions', () => {
  const row: VersionRow = {
    version: 3,
    total_questions: 10,
    prefer_unseen: true,
    opening_difficulty: 'EASY',
    scope_mode: 'CHAPTERS',
    scope_strict: true,
    notes: 'n',
    difficulties: [{ difficulty: 'HARD', count: 2 }, { difficulty: 'EASY', count: 5 }, { difficulty: 'MEDIUM', count: 3 }],
    types: [{ question_type: 'MCQ', count: 10 }],
    cells: [{ position: 2, chapter_code: null, difficulty: 'HARD', cognitive: null, min_count: 1 }, { position: 1, chapter_code: 'CH02', difficulty: null, cognitive: 'C3', min_count: 2 }],
    scopes: [{ chapter_code: 'CH02' }, { chapter_code: 'CH01' }],
  };

  it('becomes an engine design with cells in order', () => {
    const d = designOf('X', row);
    expect(d).toMatchObject({ code: 'X', version: 3, total: 10, difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 }, openingDifficulty: 'EASY' });
    expect(d.cells.map((c) => c.minCount)).toEqual([2, 1]);
  });

  it('round-trips to an editable draft', () => {
    expect(draftOf(row)).toMatchObject({ scope: { mode: 'CHAPTERS', strict: true, chapters: ['CH01', 'CH02'] }, notes: 'n' });
    expect(draftProblems(draftOf(row), subject)).toEqual([]);
  });

  it('resolves the scope for a test and for a preview', () => {
    expect(resolveScope(row, null)).toEqual({ mode: 'CHAPTERS', chapters: ['CH02', 'CH01'], strict: true });
    const focus = { scope_mode: 'STUDENT_FOCUS' as const, scope_strict: false, scopes: [] };
    expect(resolveScope(focus, ['CH01'])).toEqual({ mode: 'STUDENT_FOCUS', chapters: ['CH01'], strict: false });
    expect(resolveScope(focus, null)).toEqual({ mode: 'STUDENT_FOCUS', chapters: null, strict: false });
    expect(resolveScope({ scope_mode: 'WHOLE_SUBJECT', scope_strict: true, scopes: [] }, ['CH01'])).toEqual({ mode: 'WHOLE_SUBJECT', chapters: null, strict: false });
  });

  it('applies an unbound blueprint everywhere and a bound one only to its subject', () => {
    const unit = { curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHY' };
    expect(appliesTo({ curriculum_code: null, grade_code: null, subject_code: null }, unit)).toBe(true);
    expect(appliesTo({ curriculum_code: 'ICSE', grade_code: 'GRADE_8', subject_code: 'PHY' }, unit)).toBe(true);
    expect(appliesTo({ curriculum_code: 'ICSE', grade_code: 'GRADE_8', subject_code: 'CHEM' }, unit)).toBe(false);
  });
});
