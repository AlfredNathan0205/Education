/**
 * Pure rules for the multiple-choice question bank (Block 008). No database, no I/O.
 *
 * A question's wording is a REVISION with a state. Approved revisions are never edited: a change is a
 * new revision. Approval needs a human reviewer who is neither the author nor the person who submitted it
 * (separation of duties), who confirms they checked the answer key themselves. The AI can only draft.
 */
import { createHash } from 'node:crypto';
import type { CurriculumRole } from '../curriculum/curriculum-state';

export type QuestionState = 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUIRED' | 'APPROVED' | 'RETIRED' | 'SUPERSEDED';
export type QuestionDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type QuestionOrigin = 'HUMAN' | 'AI_DRAFT';

export const OPTION_COUNT = 4;
export const OPTION_LABELS = ['A', 'B', 'C', 'D'] as const;
export const LIMITS = { code: 64, stem: 2000, option: 500, explanation: 2000, note: 1000 };
export const MIN_STEM = 10;
export const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const MIN_NOTE = 5;
export const DIFFICULTIES: readonly QuestionDifficulty[] = ['EASY', 'MEDIUM', 'HARD'];

/** States in which the wording may still be changed in place. */
export const EDITABLE_STATES: readonly QuestionState[] = ['DRAFT', 'CHANGES_REQUIRED'];

export interface QuestionDraft {
  /** Author-chosen code, unique within the unit; lets a corrected file update the same question. */
  code: string;
  /** The learning objective's own code (resolved against the unit's curriculum). */
  objectiveCode: string;
  stem: string;
  options: string[];
  correctIndex: number;
  difficulty: QuestionDifficulty;
  explanation: string | null;
}

export type QuestionActor =
  | { kind: 'HUMAN'; accountId: string; role: CurriculumRole }
  | { kind: 'AI'; accountId: null }
  | { kind: 'SYSTEM'; accountId: null };

export class QuestionTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QuestionTransitionError';
  }
}

export function normaliseText(s: string): string {
  return s.replace(/\s+/g, ' ').trim().toLowerCase();
}

/** Same question wording in the same unit means the same hash, whatever the case or spacing. */
export function stemHash(stem: string): string {
  return createHash('sha256').update(normaliseText(stem)).digest('hex');
}

/** Problems with one question's content (empty list means it is well formed). */
export function validateQuestionDraft(d: QuestionDraft): string[] {
  const problems: string[] = [];
  if (d.code.trim() === '') problems.push('question code is required');
  else if (!CODE_PATTERN.test(d.code)) problems.push('question code may use only letters, digits, dot, dash and underscore');
  if (d.code.length > LIMITS.code) problems.push(`question code is longer than ${LIMITS.code} characters`);
  if (d.objectiveCode.trim() === '') problems.push('objective code is required');
  if (d.stem.trim().length < MIN_STEM) problems.push(`the question must be at least ${MIN_STEM} characters`);
  if (d.stem.length > LIMITS.stem) problems.push(`the question is longer than ${LIMITS.stem} characters`);
  if (d.options.length !== OPTION_COUNT) {
    problems.push(`a question needs exactly ${OPTION_COUNT} options`);
  } else {
    d.options.forEach((o, i) => {
      if (o.trim() === '') problems.push(`option ${OPTION_LABELS[i]} is empty`);
      if (o.length > LIMITS.option) problems.push(`option ${OPTION_LABELS[i]} is longer than ${LIMITS.option} characters`);
    });
    const seen = new Set(d.options.map(normaliseText).filter((o) => o !== ''));
    if (seen.size < d.options.filter((o) => o.trim() !== '').length) problems.push('two options are the same');
  }
  if (!Number.isInteger(d.correctIndex) || d.correctIndex < 0 || d.correctIndex >= OPTION_COUNT) {
    problems.push('the correct answer must be one of A, B, C or D');
  }
  if (!DIFFICULTIES.includes(d.difficulty)) problems.push('difficulty must be EASY, MEDIUM or HARD');
  if (d.explanation !== null && d.explanation.length > LIMITS.explanation) {
    problems.push(`the explanation is longer than ${LIMITS.explanation} characters`);
  }
  return problems;
}

const SUBMIT_ROLES: readonly CurriculumRole[] = ['EDITOR', 'SUPER_ADMIN'];
export const REVIEW_ROLES: readonly CurriculumRole[] = ['REVIEWER', 'APPROVER', 'SUPER_ADMIN'];
export { SUBMIT_ROLES };

export interface TransitionContext {
  /** Every person who wrote or edited the wording, plus the person who submitted it. */
  involved: readonly string[];
  answerVerified?: boolean;
  note?: string | null;
}

const ALLOWED: Record<QuestionState, readonly QuestionState[]> = {
  DRAFT: ['IN_REVIEW'],
  IN_REVIEW: ['APPROVED', 'CHANGES_REQUIRED'],
  CHANGES_REQUIRED: ['IN_REVIEW'],
  APPROVED: ['RETIRED', 'SUPERSEDED'],
  RETIRED: [],
  SUPERSEDED: [],
};

function needNote(ctx: TransitionContext, what: string): void {
  if ((ctx.note ?? '').trim().length < MIN_NOTE) {
    throw new QuestionTransitionError(`${what} needs a note of at least ${MIN_NOTE} characters`);
  }
}

/** Throws QuestionTransitionError unless this actor may make this change. */
export function assertQuestionTransition(
  from: QuestionState,
  to: QuestionState,
  actor: QuestionActor,
  ctx: TransitionContext,
): void {
  if (!ALLOWED[from].includes(to)) throw new QuestionTransitionError(`a question cannot go from ${from} to ${to}`);

  if (to === 'SUPERSEDED') {
    if (actor.kind !== 'SYSTEM') throw new QuestionTransitionError('only the system supersedes an approved question');
    return;
  }
  if (actor.kind !== 'HUMAN') throw new QuestionTransitionError('only a person can change a question\'s review state');

  if (to === 'IN_REVIEW') {
    if (!SUBMIT_ROLES.includes(actor.role)) throw new QuestionTransitionError('only an editor may submit a question for review');
    return;
  }
  if (!REVIEW_ROLES.includes(actor.role)) throw new QuestionTransitionError('only a reviewer or approver may do this');

  if (to === 'APPROVED') {
    if (ctx.involved.includes(actor.accountId)) {
      throw new QuestionTransitionError('a question cannot be approved by anyone who wrote, edited or submitted it');
    }
    if (ctx.answerVerified !== true) throw new QuestionTransitionError('the reviewer must confirm they checked the answer key');
    return;
  }
  if (to === 'CHANGES_REQUIRED') return needNote(ctx, 'sending a question back');
  if (to === 'RETIRED') return needNote(ctx, 'retiring a question');
}
