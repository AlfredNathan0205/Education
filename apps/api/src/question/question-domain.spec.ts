import {
  QuestionTransitionError,
  assertQuestionTransition,
  stemHash,
  validateQuestionDraft,
  type QuestionActor,
  type QuestionDraft,
} from './question-domain';

const good = (over: Partial<QuestionDraft> = {}): QuestionDraft => ({
  code: 'CHE8-001',
  objectiveCode: 'CHE8-C1-T1-M1-O1',
  stem: 'What is the unit of electric current?',
  options: ['Volt', 'Ampere', 'Ohm', 'Watt'],
  correctIndex: 1,
  difficulty: 'EASY',
  cognitive: 'C1',
  explanation: null,
  ...over,
});

describe('validateQuestionDraft', () => {
  it('accepts a well-formed question', () => expect(validateQuestionDraft(good())).toEqual([]));

  it.each([
    ['empty code', { code: '' }, /code is required/],
    ['bad code characters', { code: 'A B' }, /letters, digits/],
    ['short stem', { stem: 'Why?' }, /at least 10/],
    ['three options', { options: ['a', 'b', 'c'] }, /exactly 4/],
    ['five options', { options: ['a', 'b', 'c', 'd', 'e'] }, /exactly 4/],
    ['empty option', { options: ['a', '', 'c', 'd'] }, /option B is empty/],
    ['repeated option', { options: ['Same', 'same ', 'c', 'd'] }, /two options are the same/],
    ['correct out of range', { correctIndex: 4 }, /one of A, B, C or D/],
    ['no correct answer', { correctIndex: -1 }, /one of A, B, C or D/],
    ['bad difficulty', { difficulty: 'EXTREME' as never }, /difficulty/],
  ])('rejects %s', (_n, over, re) => {
    expect(validateQuestionDraft(good(over as Partial<QuestionDraft>)).join('|')).toMatch(re);
  });
});

describe('stemHash', () => {
  it('ignores case and spacing', () => {
    expect(stemHash('What  is   X?')).toBe(stemHash(' what is x? '));
    expect(stemHash('What is X?')).not.toBe(stemHash('What is Y?'));
  });
});

const human = (accountId: string, role: 'EDITOR' | 'REVIEWER' | 'APPROVER' | 'SUPER_ADMIN'): QuestionActor => ({ kind: 'HUMAN', accountId, role });
const ai: QuestionActor = { kind: 'AI', accountId: null };
const system: QuestionActor = { kind: 'SYSTEM', accountId: null };
const ctx = { involved: ['author'] };

describe('assertQuestionTransition', () => {
  it('lets an editor submit a draft or a returned question', () => {
    expect(() => assertQuestionTransition('DRAFT', 'IN_REVIEW', human('e', 'EDITOR'), ctx)).not.toThrow();
    expect(() => assertQuestionTransition('CHANGES_REQUIRED', 'IN_REVIEW', human('e', 'SUPER_ADMIN'), ctx)).not.toThrow();
  });

  it('refuses the AI and a reviewer-only account for submitting', () => {
    expect(() => assertQuestionTransition('DRAFT', 'IN_REVIEW', ai, ctx)).toThrow(QuestionTransitionError);
    expect(() => assertQuestionTransition('DRAFT', 'IN_REVIEW', human('r', 'REVIEWER'), ctx)).toThrow(/editor/);
  });

  it('lets a different reviewer approve once the answer key is confirmed', () => {
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('r', 'REVIEWER'), { ...ctx, answerVerified: true })).not.toThrow();
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('a', 'APPROVER'), { ...ctx, answerVerified: true })).not.toThrow();
  });

  it('refuses approval without the answer-key confirmation', () => {
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('r', 'REVIEWER'), ctx)).toThrow(/answer key/);
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('r', 'REVIEWER'), { ...ctx, answerVerified: false })).toThrow(/answer key/);
  });

  it('refuses approval by anyone who wrote, edited or submitted it, even a SUPER_ADMIN', () => {
    const c = { involved: ['author', 'submitter'], answerVerified: true };
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('author', 'SUPER_ADMIN'), c)).toThrow(/wrote, edited or submitted/);
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('submitter', 'REVIEWER'), c)).toThrow(/wrote, edited or submitted/);
  });

  it('refuses approval by the AI or an editor-only account', () => {
    const c = { ...ctx, answerVerified: true };
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', ai, c)).toThrow();
    expect(() => assertQuestionTransition('IN_REVIEW', 'APPROVED', human('x', 'EDITOR'), c)).toThrow(/reviewer or approver/);
  });

  it('needs a real note and a reason code to send back or retire', () => {
    const ok = { reasonCode: 'OTHER' };
    expect(() => assertQuestionTransition('IN_REVIEW', 'CHANGES_REQUIRED', human('r', 'REVIEWER'), { ...ctx, ...ok, note: 'no' })).toThrow(/note/);
    expect(() => assertQuestionTransition('IN_REVIEW', 'CHANGES_REQUIRED', human('r', 'REVIEWER'), { ...ctx, ...ok, note: 'Option C is also correct.' })).not.toThrow();
    expect(() => assertQuestionTransition('APPROVED', 'RETIRED', human('r', 'REVIEWER'), { ...ctx, ...ok, note: '' })).toThrow(/note/);
    expect(() => assertQuestionTransition('APPROVED', 'RETIRED', human('r', 'REVIEWER'), { ...ctx, ...ok, note: 'Syllabus changed.' })).not.toThrow();
    for (const bad of [undefined, null, '', 'MADE_UP']) {
      expect(() => assertQuestionTransition('IN_REVIEW', 'CHANGES_REQUIRED', human('r', 'REVIEWER'), { ...ctx, reasonCode: bad as never, note: 'Option C is also correct.' })).toThrow(/reason code/);
      expect(() => assertQuestionTransition('APPROVED', 'RETIRED', human('r', 'REVIEWER'), { ...ctx, reasonCode: bad as never, note: 'Syllabus changed.' })).toThrow(/reason code/);
    }
  });

  it('quarantine: a reviewer may pull an approved question; only an approver may restore it', () => {
    const q = { ...ctx, reasonCode: 'ANSWER_WRONG', note: 'The key is wrong.' };
    expect(() => assertQuestionTransition('APPROVED', 'QUARANTINED', human('r', 'REVIEWER'), q)).not.toThrow();
    expect(() => assertQuestionTransition('APPROVED', 'QUARANTINED', human('e', 'EDITOR'), q)).toThrow(/reviewer or approver/);
    expect(() => assertQuestionTransition('APPROVED', 'QUARANTINED', system, q)).toThrow();
    expect(() => assertQuestionTransition('APPROVED', 'QUARANTINED', human('r', 'REVIEWER'), { ...q, reasonCode: undefined })).toThrow(/reason code/);
    expect(() => assertQuestionTransition('QUARANTINED', 'APPROVED', human('r', 'REVIEWER'), q)).toThrow(/approver/);
    expect(() => assertQuestionTransition('QUARANTINED', 'APPROVED', human('a', 'APPROVER'), q)).not.toThrow();
    expect(() => assertQuestionTransition('QUARANTINED', 'APPROVED', human('a', 'APPROVER'), { ...q, note: 'x' })).toThrow(/note/);
    expect(() => assertQuestionTransition('QUARANTINED', 'RETIRED', human('r', 'REVIEWER'), q)).not.toThrow();
    expect(() => assertQuestionTransition('QUARANTINED', 'IN_REVIEW', human('e', 'EDITOR'), q)).toThrow(/cannot go/);
    expect(() => assertQuestionTransition('IN_REVIEW', 'QUARANTINED', human('r', 'REVIEWER'), q)).toThrow(/cannot go/);
  });

  it('only the system supersedes, and nothing leaves a final state', () => {
    expect(() => assertQuestionTransition('APPROVED', 'SUPERSEDED', system, ctx)).not.toThrow();
    expect(() => assertQuestionTransition('APPROVED', 'SUPERSEDED', human('r', 'SUPER_ADMIN'), ctx)).toThrow(/system/);
    expect(() => assertQuestionTransition('RETIRED', 'DRAFT', human('r', 'SUPER_ADMIN'), ctx)).toThrow(/cannot go/);
    expect(() => assertQuestionTransition('SUPERSEDED', 'APPROVED', system, ctx)).toThrow(/cannot go/);
  });

  it('refuses shortcuts', () => {
    expect(() => assertQuestionTransition('DRAFT', 'APPROVED', human('r', 'SUPER_ADMIN'), { ...ctx, answerVerified: true })).toThrow(/cannot go/);
    expect(() => assertQuestionTransition('APPROVED', 'DRAFT', human('r', 'SUPER_ADMIN'), ctx)).toThrow(/cannot go/);
  });
});
