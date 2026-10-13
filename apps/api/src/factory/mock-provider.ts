/**
 * A stand-in for a real model so the whole pipeline can be built, tested and hand-tried without one.
 * Its questions are placeholders (they say [MOCK]) and are meaningless as teaching content. It can be told to
 * misbehave on chosen candidates so each route (GREEN, repair, reject, failure) can be seen end to end.
 *
 *   MOCK_AI_FAULTS="wrong-answer=4,weak-explanation=5,duplicate=7,garbage=9"
 * means: every 4th candidate has a wrong key, every 5th has a weak explanation (a repair fixes it), every 7th repeats
 * the first question, every 9th is not valid JSON.
 */
import type { AiProvider, AiRequest, AiResponse } from './ai-provider';

export interface MockFaults {
  wrongAnswer?: number;
  weakExplanation?: number;
  duplicate?: number;
  garbage?: number;
}

export function parseMockFaults(raw: string | undefined): MockFaults {
  const out: MockFaults = {};
  if (!raw || !raw.trim()) return out;
  const names: Record<string, keyof MockFaults> = { 'wrong-answer': 'wrongAnswer', 'weak-explanation': 'weakExplanation', duplicate: 'duplicate', garbage: 'garbage' };
  for (const part of raw.split(',')) {
    const [k, v] = part.split('=').map((s) => s.trim());
    const n = Number(v);
    if (!names[k] || !Number.isInteger(n) || n < 1) throw new Error(`MOCK_AI_FAULTS: "${part}" is not valid (use name=N with N a whole number; names: ${Object.keys(names).join(', ')})`);
    out[names[k]] = n;
  }
  return out;
}

const every = (n: number | undefined, i: number) => n !== undefined && i % n === 0;

export class MockAiProvider implements AiProvider {
  readonly name = 'mock';
  readonly model = 'mock-1';
  private counter = 0;

  constructor(private readonly faults: MockFaults = {}) {}

  async complete(req: AiRequest): Promise<AiResponse> {
    const input = JSON.parse(req.user) as any;
    const text = this.answer(req.role, input);
    return { text, tokensIn: Math.ceil((req.system.length + req.user.length) / 4), tokensOut: Math.ceil(text.length / 4) };
  }

  private answer(role: string, input: any): string {
    if (role === 'QUESTION_GENERATOR') return this.generate(input);
    if (role === 'ANSWER_SOLVER') {
      const i = (input.options as string[]).findIndex((o) => o.startsWith('Correct:'));
      return JSON.stringify({ answer: i < 0 ? null : 'ABCD'[i] });
    }
    const q = input.question ?? {};
    const variant = Number(/variant (\d+)/.exec(q.stem ?? '')?.[1] ?? 0);
    if (role === 'EXPLANATION_VALIDATOR' && every(this.faults.weakExplanation, variant) && !(q.explanation ?? '').includes('(improved)')) {
      return JSON.stringify({ score: 0.6, critical: false, issues: ['the explanation only restates the question'] });
    }
    return JSON.stringify({ score: 1, critical: false, issues: [] });
  }

  private generate(input: any): string {
    if (input.mode === 'REPAIR') {
      const p = input.previous;
      return JSON.stringify({ stem: p.stem, options: p.options, correct: p.correct, explanation: `${p.explanation ?? ''} (improved)`.trim() });
    }
    // Carry on after the highest variant already in the bank, so a second run does not just repeat the first.
    const seen = Math.max(0, ...((input.avoidStems ?? []) as string[]).map((t) => Number(/variant (\d+)/.exec(t)?.[1] ?? 0)));
    const n = (this.counter = Math.max(this.counter, seen) + 1);
    if (every(this.faults.garbage, n)) return 'Sorry, I cannot help with that.';
    const variant = every(this.faults.duplicate, n) ? 1 : n;
    const statement = String(input.objective ?? 'the objective');
    // Placeholder wording that differs from one variant to the next, so the repeat-wording check is not tripped by the mock itself.
    const tag = (k: number) => `mk${variant}x${k}`;
    const options = [`Correct: ${statement} ${tag(1)} ${tag(2)}`, `Wrong idea ${tag(3)} ${tag(4)} ${tag(5)}`, `Wrong idea ${tag(6)} ${tag(7)} ${tag(8)}`, `Wrong idea ${tag(9)} ${tag(10)} ${tag(11)}`];
    // Put the right answer in a different place each time, so a position cue cannot be relied on.
    const at = variant % 4;
    [options[0], options[at]] = [options[at], options[0]];
    let correct = at;
    if (every(this.faults.wrongAnswer, n)) correct = (at + 1) % 4;
    return JSON.stringify({
      stem: `[MOCK] ${tag(12)} ${tag(13)} ${tag(14)} ${tag(15)} ${tag(16)} ${tag(17)} (variant ${variant})`,
      options,
      correct: 'ABCD'[correct],
      explanation: `[MOCK] The first statement restates the objective (variant ${variant}).`,
    });
  }
}
