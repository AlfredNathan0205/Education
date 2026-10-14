import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { CompetitionService } from './competition.service';

/** COMPETITION_UPDATES_ENABLED=false stops CP and XP being recorded (results still work; points just wait). On by default. */
export function competitionUpdatesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.COMPETITION_UPDATES_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('COMPETITION_UPDATES_ENABLED must be "true" or "false"');
}

/**
 * Every 30 seconds, records CP and XP for finished, rescored or invalidated tests. Safe on several API instances (one
 * qualification per test and result revision, under the student's row lock). A failure is logged and retried next time.
 */
@Injectable()
export class CompetitionSweeper {
  private readonly logger = new Logger(CompetitionSweeper.name);
  private readonly enabled = competitionUpdatesEnabled();
  private running = false;

  constructor(private readonly competition: CompetitionService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      const done = await this.competition.reconcile(50);
      if (done.length) this.logger.log(`competitive points recorded for ${done.length} test(s)`);
      return done.length;
    } catch (e) {
      this.logger.error(`competitive points update failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
