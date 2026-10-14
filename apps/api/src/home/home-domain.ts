/**
 * The student's Home (spec STUDENT_WEB: Home priority is the Next Best Action, then progress and subjects).
 * Pure: the next best action is chosen by a fixed, explainable order from facts the server already has. Step 14 puts
 * the loop's retest and practice recommendations (chosen from mastery evidence) ahead of the "take a test" rules.
 */

export const FIRST_TEST_MESSAGE = 'Building your mastery profile';
export const QUICK = 'QUICK10';
export const FOCUS = 'FOCUS10';

export interface HomeUnit {
  subjectVersionId: string;
  subjectCode: string;
  subjectName: string;
  ready: boolean;
  chosenChapters: number;
  tests: Array<{ code: string; name: string; total: number; ready: boolean }>;
}

export interface HomeAttempt {
  assessmentId: string;
  mode: 'TEST' | 'PRACTICE';
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'VOID' | 'INVALIDATED';
  subjectCode: string;
  subjectName: string;
  blueprint: string;
  startedAt: string;
  submittedAt: string | null;
  correct: number | null;
  total: number | null;
}

export type NextAction =
  | { kind: 'RESUME'; assessmentId: string; subjectName: string; mode: 'TEST' | 'PRACTICE'; reason: string }
  | { kind: 'FINISH_PROFILE'; reason: string }
  | { kind: 'COMING_SOON'; reason: string }
  | { kind: 'NOT_READY'; reason: string }
  | { kind: 'FIRST_TEST'; subjectVersionId: string; subjectName: string; blueprint: string; mode: 'TEST'; reason: string }
  | { kind: 'TAKE_TEST'; subjectVersionId: string; subjectName: string; blueprint: string; mode: 'TEST'; reason: string }
  | { kind: 'RETEST'; recommendationId: string; subjectName: string; objectives: number; reason: string }
  | { kind: 'PRACTICE'; recommendationId: string; subjectName: string; objectives: number; reason: string };

/** An open or started recommendation, as Home needs it (Step 14). */
export interface HomeRecommendation {
  id: string;
  kind: 'PRACTICE' | 'RETEST';
  subjectName: string;
  objectives: Array<unknown>;
  createdAt: string;
}

const objectivesText = (n: number) => (n === 1 ? 'one objective' : `${n} objectives`);

export interface SubjectSummary extends HomeUnit {
  /** The most recent finished result in this subject (TEST or PRACTICE), if any. */
  lastResult: { assessmentId: string; correct: number; total: number; mode: 'TEST' | 'PRACTICE'; at: string } | null;
  completed: number;
}

/** Focus 10 when the student chose chapters in this subject and it can be built; otherwise Quick 10; otherwise anything ready. */
export function testFor(unit: HomeUnit): string | null {
  const ready = unit.tests.filter((t) => t.ready);
  if (unit.chosenChapters > 0 && ready.some((t) => t.code === FOCUS)) return FOCUS;
  if (ready.some((t) => t.code === QUICK)) return QUICK;
  return ready[0]?.code ?? null;
}

export function summarise(units: HomeUnit[], attempts: HomeAttempt[]): SubjectSummary[] {
  return units.map((u) => {
    const done = attempts
      .filter((a) => a.subjectCode === u.subjectCode && a.status === 'SUBMITTED' && a.correct !== null && a.total !== null)
      .sort((a, b) => (b.submittedAt ?? b.startedAt).localeCompare(a.submittedAt ?? a.startedAt));
    const last = done[0];
    return {
      ...u,
      lastResult: last ? { assessmentId: last.assessmentId, correct: last.correct!, total: last.total!, mode: last.mode, at: last.submittedAt ?? last.startedAt } : null,
      completed: done.length,
    };
  });
}

/**
 * Order: resume what is open; finish the profile; coming soon; not ready; the first test; then a retest after practice;
 * then practice; then a subject never tested; then the subject tested longest ago.
 */
export function nextBestAction(input: { hasCohort: boolean; units: HomeUnit[]; attempts: HomeAttempt[]; recommendations?: HomeRecommendation[] }): NextAction {
  const open = input.attempts
    .filter((a) => a.status === 'IN_PROGRESS')
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  if (open) return { kind: 'RESUME', assessmentId: open.assessmentId, subjectName: open.subjectName, mode: open.mode, reason: 'You have a test in progress.' };
  if (!input.hasCohort) return { kind: 'FINISH_PROFILE', reason: 'Choose your curriculum and grade to see your subjects.' };
  if (input.units.length === 0) return { kind: 'COMING_SOON', reason: 'Your curriculum and grade are not available yet.' };

  const ready = input.units.filter((u) => testFor(u) !== null);
  if (ready.length === 0) return { kind: 'NOT_READY', reason: 'Questions for your subjects are still being prepared.' };

  const finished = input.attempts.filter((a) => a.status === 'SUBMITTED');
  if (finished.length === 0) {
    const pick = [...ready].sort((a, b) => Number(b.chosenChapters > 0) - Number(a.chosenChapters > 0) || a.subjectName.localeCompare(b.subjectName))[0];
    return { kind: 'FIRST_TEST', subjectVersionId: pick.subjectVersionId, subjectName: pick.subjectName, blueprint: testFor(pick)!, mode: 'TEST', reason: FIRST_TEST_MESSAGE };
  }

  const oldest = (kind: HomeRecommendation['kind']) =>
    (input.recommendations ?? []).filter((r) => r.kind === kind).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))[0];
  const retest = oldest('RETEST');
  if (retest) {
    const n = retest.objectives.length;
    return { kind: 'RETEST', recommendationId: retest.id, subjectName: retest.subjectName, objectives: n, reason: `You practised ${objectivesText(n)} in ${retest.subjectName}. A short retest shows what has stuck.` };
  }
  const practice = oldest('PRACTICE');
  if (practice) {
    const n = practice.objectives.length;
    return { kind: 'PRACTICE', recommendationId: practice.id, subjectName: practice.subjectName, objectives: n, reason: `Practise ${objectivesText(n)} in ${practice.subjectName}, chosen from your recent answers.` };
  }

  const lastTested = (u: HomeUnit) =>
    finished
      .filter((a) => a.subjectCode === u.subjectCode && a.mode === 'TEST')
      .map((a) => a.submittedAt ?? a.startedAt)
      .sort()
      .pop() ?? null;
  const never = ready.filter((u) => lastTested(u) === null).sort((a, b) => a.subjectName.localeCompare(b.subjectName));
  if (never.length) {
    const u = never[0];
    return { kind: 'TAKE_TEST', subjectVersionId: u.subjectVersionId, subjectName: u.subjectName, blueprint: testFor(u)!, mode: 'TEST', reason: `You have not taken a ${u.subjectName} test yet.` };
  }
  const u = [...ready].sort((a, b) => lastTested(a)!.localeCompare(lastTested(b)!) || a.subjectName.localeCompare(b.subjectName))[0];
  return { kind: 'TAKE_TEST', subjectVersionId: u.subjectVersionId, subjectName: u.subjectName, blueprint: testFor(u)!, mode: 'TEST', reason: `${u.subjectName} is the subject you tested longest ago.` };
}
