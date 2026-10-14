import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RecommendationService } from './recommendation.service';

/** RECOMMENDATIONS_ENABLED=false stops the refresh (tests, results and mastery still work). On by default. */
export function recommendationsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.RECOMMENDATIONS_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('RECOMMENDATIONS_ENABLED must be "true" or "false"');
}

/**
 * Every 30 seconds, refreshes recommendations after new mastery runs. Safe on several API instances (one refresh per
 * run, under the student's row lock). A failure is logged and retried next time.
 */
@Injectable()
export class RecommendationSweeper {
  private readonly logger = new Logger(RecommendationSweeper.name);
  private readonly enabled = recommendationsEnabled();
  private running = false;

  constructor(private readonly recs: RecommendationService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      const done = await this.recs.reconcile(50);
      if (done.length) this.logger.log(`recommendations refreshed after ${done.length} mastery run(s)`);
      return done.length;
    } catch (e) {
      this.logger.error(`recommendation refresh failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
