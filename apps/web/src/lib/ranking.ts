import type { CompeteBoard, CompeteView } from './client-api';

/** What is still needed to be ranked this week, in words (shared by Compete, Home and the result). */
export function needsText(n: { tests: number; questions: number }): string {
  const parts: string[] = [];
  if (n.tests > 0) parts.push(n.tests === 1 ? '1 more test' : `${n.tests} more tests`);
  if (n.questions > 0) parts.push(`${n.questions} more counted question${n.questions === 1 ? '' : 's'}`);
  return parts.join(' with ');
}

/** The whole-cohort board (all subjects): the one Home and the result talk about. */
export function cohortBoard(view: CompeteView | null): CompeteBoard | null {
  return view?.boards.find((b) => b.scope === 'COHORT') ?? null;
}
