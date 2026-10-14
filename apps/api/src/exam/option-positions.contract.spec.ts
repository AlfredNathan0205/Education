/**
 * Contract between the question bank and the exam engine.
 *
 * Before this test existed, the bank stored options at positions 0..3 while the engine shuffled positions 1..4. Every
 * real question then failed `presentable` and was removed as a technical failure; the unit and integration fixtures
 * hid it because they wrote options at 1..4 by hand. This test builds the options with the bank's own `optionRows`
 * and runs them through the engine's own assembly, presentation and scoring checks.
 */
import { OPTION_LABELS, OPTION_POSITIONS, optionRows } from '../question/question-domain';
import { assemble } from '../assembly/assembly-engine';
import { OPTION_COUNT, QUICK10_DESIGN, slotToPosition, type PoolItem } from './exam-domain';
import { presentable } from './exam.service';

function pool(n: number): PoolItem[] {
  return Array.from({ length: n }, (_, i) => ({
    revisionId: `r${i}`,
    questionId: `q${i}`,
    objectivePath: `C1/T1/M1/O${i}`,
    difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[i % 3],
    stemHash: `h${i}`,
    lastSeenAt: null,
  }));
}

describe('option positions: the bank and the exam engine agree', () => {
  const stored = optionRows(['w', 'x', 'y', 'z'], 2);

  it('the bank stores one option per position in OPTION_POSITIONS, one label each', () => {
    expect(stored.map((o) => o.position)).toEqual([...OPTION_POSITIONS]);
    expect(OPTION_POSITIONS).toHaveLength(OPTION_COUNT);
    expect(OPTION_LABELS).toHaveLength(OPTION_COUNT);
    expect(stored.filter((o) => o.is_correct)).toEqual([{ position: OPTION_POSITIONS[2], text: 'y', is_correct: true }]);
  });

  it('every assembled item can be shown with options exactly as the bank stores them', () => {
    for (let s = 0; s < 25; s++) {
      for (const item of assemble(pool(30), QUICK10_DESIGN, `seed-${s}`).items) {
        expect(presentable({ stem: 'A real stem?', options: stored }, item.optionOrder)).toBe(true);
      }
    }
  });

  it('every displayed slot maps to a stored option, and the correct one is reachable', () => {
    const correct = stored.find((o) => o.is_correct)!.position;
    for (const item of assemble(pool(30), QUICK10_DESIGN, 'seed-x').items) {
      const reached = [0, 1, 2, 3].map((slot) => slotToPosition(item.optionOrder, slot));
      expect(reached.every((p) => stored.some((o) => o.position === p))).toBe(true);
      expect(reached).toContain(correct);
    }
  });
});
