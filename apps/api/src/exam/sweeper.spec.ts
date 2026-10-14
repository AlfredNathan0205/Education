import { ExamSweeper, sweepEnabled } from './sweeper';

describe('ExamSweeper', () => {
  it('is on by default and refuses unclear settings', () => {
    expect(sweepEnabled({})).toBe(true);
    expect(sweepEnabled({ EXAM_SWEEP_ENABLED: 'false' })).toBe(false);
    expect(() => sweepEnabled({ EXAM_SWEEP_ENABLED: 'no' })).toThrow(/EXAM_SWEEP_ENABLED/);
  });

  it('keeps sweeping in batches of 100 until a batch comes back short, at most 10 batches', async () => {
    const exam: any = { sweepExpired: jest.fn().mockResolvedValueOnce(100).mockResolvedValueOnce(100).mockResolvedValueOnce(3) };
    expect(await new ExamSweeper(exam).run()).toBe(203);
    expect(exam.sweepExpired).toHaveBeenCalledTimes(3);
    const busy: any = { sweepExpired: jest.fn().mockResolvedValue(100) };
    expect(await new ExamSweeper(busy).run()).toBe(1000);
    expect(busy.sweepExpired).toHaveBeenCalledTimes(10);
  });

  it('does not overlap itself and survives a failure', async () => {
    let release!: () => void;
    const slow: any = { sweepExpired: jest.fn(() => new Promise<number>((r) => (release = () => r(0)))) };
    const s = new ExamSweeper(slow);
    const first = s.run();
    expect(await s.run()).toBe(0);
    release();
    await first;
    const failing: any = { sweepExpired: jest.fn().mockRejectedValue(new Error('db down')) };
    expect(await new ExamSweeper(failing).run()).toBe(0);
  });
});
