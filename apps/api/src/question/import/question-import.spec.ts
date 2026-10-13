import { QuestionFormatError, parseQuestions, parseQuestionsCsv, parseQuestionsJson } from './question-import';

const HEAD = 'question_code,objective_code,stem,option_a,option_b,option_c,option_d,correct,difficulty,explanation';
const row = (code: string, stem = 'What is the unit of electric current?', correct = 'B') =>
  `${code},O1,${stem},Volt,Ampere,Ohm,Watt,${correct},easy,Current is measured in amperes`;

describe('parseQuestionsCsv', () => {
  it('reads a clean file; codes are upper-cased, difficulty and correct are case-insensitive', () => {
    const r = parseQuestionsCsv([HEAD, row('q1'), row('q2', 'What is the unit of resistance?', 'c')].join('\n'));
    expect(r.issues).toEqual([]);
    expect(r.questions.map((q) => q.draft.code)).toEqual(['Q1', 'Q2']);
    expect(r.questions[0].draft).toMatchObject({ correctIndex: 1, difficulty: 'EASY', objectiveCode: 'O1', options: ['Volt', 'Ampere', 'Ohm', 'Watt'] });
    expect(r.questions[1].draft.correctIndex).toBe(2);
  });

  it('handles quoted commas and newlines inside a field', () => {
    const r = parseQuestionsCsv(`${HEAD}\nQ1,O1,"Which, of these, is right?\nPick one.","a, b",B,C,D,A,MEDIUM,`);
    expect(r.issues).toEqual([]);
    expect(r.questions[0].draft.stem).toBe('Which, of these, is right? Pick one.');
    expect(r.questions[0].draft.options[0]).toBe('a, b');
    expect(r.questions[0].draft.explanation).toBeNull();
  });

  it('reports the row for each problem and never trims silently', () => {
    const r = parseQuestionsCsv([HEAD, row('q1', 'Short', 'E'), 'q2,O1,What is the unit of power here?,a,a,c,d,A,EXTREME,'].join('\n'));
    const msgs = r.issues.map((i) => `${i.where}: ${i.message}`).join('\n');
    expect(msgs).toMatch(/row 2: correct must be A, B, C or D/);
    expect(msgs).toMatch(/row 2: the question must be at least 10/);
    expect(msgs).toMatch(/row 3: two options are the same/);
    expect(msgs).toMatch(/row 3: difficulty must be/);
  });

  it('flags a repeated code and a repeated wording in the same file', () => {
    const r = parseQuestionsCsv([HEAD, row('q1'), row('Q1', 'Another question about current?'), row('q3')].join('\n'));
    const msgs = r.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/question code Q1 is repeated/);
    expect(msgs).toMatch(/same question wording appears at row 2/);
  });

  it('rejects a file with a missing column, or with no data', () => {
    expect(() => parseQuestionsCsv('question_code,stem\nq1,x')).toThrow(/missing column/);
    expect(() => parseQuestionsCsv(HEAD)).toThrow(QuestionFormatError);
  });

  it('rejects control characters', () => {
    const r = parseQuestionsCsv(`${HEAD}\nQ1,O1,What is the unit\u0001 of current?,a,b,c,d,A,EASY,`);
    expect(r.issues.map((i) => i.message).join()).toMatch(/control characters/);
  });
});

describe('parseQuestionsJson', () => {
  const q = (over = {}) => ({ code: 'q1', objectiveCode: 'O1', stem: 'What is the unit of electric current?', options: ['Volt', 'Ampere', 'Ohm', 'Watt'], correct: 'B', difficulty: 'EASY', ...over });

  it('reads questions and a top-level unit header', () => {
    const r = parseQuestionsJson(JSON.stringify({ curriculumCode: 'ICSE', versionLabel: '2026-27', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS', questions: [q()] }));
    expect(r.issues).toEqual([]);
    expect(r.header).toEqual({ curriculumCode: 'ICSE', versionLabel: '2026-27', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS' });
    expect(r.questions[0].draft.code).toBe('Q1');
  });

  it('reports bad shapes by path', () => {
    const r = parseQuestionsJson(JSON.stringify({ questions: [q({ options: 'nope' }), 5, q({ code: 'q3', correct: 3 })] }));
    const msgs = r.issues.map((i) => `${i.where}: ${i.message}`).join('\n');
    expect(msgs).toMatch(/\/questions\/0: options must be a list/);
    expect(msgs).toMatch(/\/questions\/1: each question must be an object/);
    expect(msgs).toMatch(/\/questions\/2: correct must be text/);
  });

  it('rejects invalid JSON and a missing questions list', () => {
    expect(() => parseQuestionsJson('{')).toThrow(/not valid JSON/);
    expect(() => parseQuestionsJson('{}')).toThrow(/"questions" list/);
    expect(() => parseQuestionsJson('[]')).toThrow(/JSON object/);
  });
});

describe('parseQuestions', () => {
  it('checks the format, emptiness and size', () => {
    expect(() => parseQuestions('xml' as never, 'x')).toThrow(/csv or json/);
    expect(() => parseQuestions('csv', '  ')).toThrow(/empty/);
    expect(() => parseQuestions('csv', 5)).toThrow(/empty/);
    expect(() => parseQuestions('csv', 'x'.repeat(2_000_001))).toThrow(/too large/);
  });
});
