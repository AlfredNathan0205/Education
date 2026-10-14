import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ExamService } from './exam.service';

/** EXAM_SWEEP_ENABLED=false turns the sweeper off (for example on a read-only replica). On by default. */
export function sweepEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.EXAM_SWEEP_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('EXAM_SWEEP_ENABLED must be "true" or "false"');
}

/**
 * Settles tests whose resume window has passed, every five minutes, so a result (or a void attempt) does not wait for
 * the student to come back. Safe to run on several API instances: each test is settled under its session row lock.
 */
@Injectable()
export class ExamSweeper {
  private readonly logger = new Logger(ExamSweeper.name);
  private readonly enabled = sweepEnabled();
  private running = false;

  constructor(private readonly exam: ExamService) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async run(): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      let total = 0;
      // Up to 10 batches of 100 per run; anything left waits for the next run.
      for (let i = 0; i < 10; i++) {
        const n = await this.exam.sweepExpired(100);
        total += n;
        if (n < 100) break;
      }
      if (total > 0) this.logger.log(`settled ${total} expired assessment(s)`);
      return total;
    } catch (e) {
      this.logger.error(`expiry sweep failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
