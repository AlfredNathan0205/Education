import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { MasteryService } from './mastery.service';

/** MASTERY_UPDATES_ENABLED=false stops the reconciler (results still work; mastery just waits). On by default. */
export function masteryUpdatesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.MASTERY_UPDATES_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('MASTERY_UPDATES_ENABLED must be "true" or "false"');
}

/**
 * Every 30 seconds, counts finished, rescored or invalidated tests into mastery. Safe on several API instances (each
 * run is unique per test and result revision, under the student's row lock). A failure is logged and retried next time.
 */
@Injectable()
export class MasterySweeper {
  private readonly logger = new Logger(MasterySweeper.name);
  private readonly enabled = masteryUpdatesEnabled();
  private running = false;

  constructor(private readonly mastery: MasteryService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      const done = await this.mastery.reconcile(50);
      if (done.length) this.logger.log(`mastery updated from ${done.length} test(s)`);
      return done.length;
    } catch (e) {
      this.logger.error(`mastery update failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
