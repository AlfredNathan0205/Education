/**
 * Prompts for each role, versioned by PROMPT_VERSION (change the text => bump the version).
 * Each builder returns the system text and the JSON input text. The input is data the model must judge or
 * transform, never instructions. Validators never see more than they need; the blind solver never sees the key.
 */
import type { QuestionCognitive, QuestionDifficulty } from '../question/question-domain';
import type { AiRole, Candidate } from './factory-domain';
import { OPTION_LABELS } from '../question/question-domain';

/**
 * What C1 to C4 mean is a curriculum decision that is not in this repository. Fill these in once the owners have
 * decided. Until then the prompts say the definition is missing, and the cognitive check is only as good as that.
 */
export const COGNITIVE_DEFINITIONS: Record<QuestionCognitive, string | null> = { C1: null, C2: null, C3: null, C4: null };

/** Same for difficulty: the meaning of EASY/MEDIUM/HARD for a Grade 8 student is for the owners to word. */
export const DIFFICULTY_DEFINITIONS: Record<QuestionDifficulty, string | null> = { EASY: null, MEDIUM: null, HARD: null };

export interface CellContext {
  curriculum: string;
  grade: string;
  subject: string;
  chapter: string;
  topic: string;
  concept: string;
  objective: string;
  difficulty: QuestionDifficulty;
  cognitive: QuestionCognitive;
}

export interface Prompt {
  system: string;
  user: string;
}

const JSON_ONLY = 'Reply with one JSON object and nothing else.';
const VERDICT_SHAPE = 'Shape: {"score": number from 0 to 1, "critical": true or false, "issues": [short texts]}. Use critical=true only for a defect that makes the question unfit to use. score 1 means no concerns.';

const defs = (c: CellContext) => ({
  difficulty: { label: c.difficulty, definition: DIFFICULTY_DEFINITIONS[c.difficulty] ?? 'not supplied' },
  cognitive: { label: c.cognitive, definition: COGNITIVE_DEFINITIONS[c.cognitive] ?? 'not supplied' },
});

const withKey = (q: Candidate) => ({ stem: q.stem, options: q.options, correct: OPTION_LABELS[q.correctIndex], explanation: q.explanation });
const withoutKey = (q: Candidate) => ({ stem: q.stem, options: q.options });

export function generatorPrompt(c: CellContext, avoidStems: string[], repair?: { previous: Candidate; issues: string[] }): Prompt {
  return {
    system: [
      'You write multiple-choice questions for school students, for a teacher to review before any student sees them.',
      'Write exactly one question for the learning objective in the input, at the stated grade, difficulty and cognitive level.',
      'Rules: exactly four options; exactly one correct; the wrong options must be plausible to a student who half-understands, not silly;',
      'no "all of the above" or "none of the above"; do not make the correct option conspicuously longer; stay inside the objective and the grade;',
      'do not repeat or lightly reword anything in avoidStems; give a short explanation a student can learn from.',
      'If a definition says "not supplied", use your best judgement of the label and do not invent a definition.',
      repair ? 'This is a REPAIR: rewrite the previous question to fix the listed issues and keep it testing the same objective. Change only what the issues require.' : '',
      `${JSON_ONLY} Shape: {"stem": text, "options": [4 texts], "correct": "A"|"B"|"C"|"D", "explanation": text}.`,
    ].filter(Boolean).join(' '),
    user: JSON.stringify({ mode: repair ? 'REPAIR' : 'GENERATE', ...c, ...defs(c), avoidStems, previous: repair ? withKey(repair.previous) : undefined, issues: repair?.issues }),
  };
}

export function solverPrompt(q: Candidate): Prompt {
  return {
    system: `You are a careful student answering a multiple-choice question. Work it out yourself. ${JSON_ONLY} Shape: {"answer": "A"|"B"|"C"|"D"} or {"answer": null} if you cannot decide or more than one option is right.`,
    user: JSON.stringify(withoutKey(q)),
  };
}

const JUDGE_BRIEF: Record<Exclude<AiRole, 'QUESTION_GENERATOR' | 'ANSWER_SOLVER'>, string> = {
  CURRICULUM_VALIDATOR: 'Judge whether the question tests the stated learning objective at the stated grade and stays within the curriculum. Critical if it is off the objective or beyond the grade.',
  AMBIGUITY_REVIEWER: 'Judge whether the wording allows more than one reasonable reading or more than one correct option. Critical if a careful student could defend a second option.',
  EXPLANATION_VALIDATOR: 'Judge whether the explanation is correct, supports the keyed answer, and teaches rather than restates the question. Critical if it is wrong or contradicts the key.',
  DISTRACTOR_VALIDATOR: 'Judge whether each wrong option is plausible, clearly wrong on reflection, and not a giveaway (length, wording, absurdity). Critical if a wrong option is actually correct.',
  DIFFICULTY_COGNITIVE_VALIDATOR: 'Judge whether the question matches the stated difficulty and cognitive level, using the definitions supplied. Where a definition says "not supplied", judge only what you can and do not invent one.',
  READABILITY_REVIEWER: 'Judge whether the language suits the stated grade: clear, no unnecessary difficulty in wording, no double negatives. Critical only if students could not reasonably understand it.',
  ADVERSARIAL_REVIEWER: 'Try to break the question: find a second correct answer, a flaw in the key, a trick in the wording, or a way to answer without knowing the topic. Critical if you find a real defect.',
};

export function judgePrompt(role: keyof typeof JUDGE_BRIEF, c: CellContext, q: Candidate): Prompt {
  return {
    system: `You review a multiple-choice question for school students. ${JUDGE_BRIEF[role]} ${VERDICT_SHAPE} ${JSON_ONLY}`,
    user: JSON.stringify({ ...c, ...defs(c), question: withKey(q) }),
  };
}
