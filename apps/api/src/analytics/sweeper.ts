import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AnalyticsService } from './analytics.service';

/** Every 30 seconds: records outbox events for consenting students into the pseudonymous analytics store. */
@Injectable()
export class AnalyticsSweeper {
  private readonly logger = new Logger(AnalyticsSweeper.name);
  private running = false;

  constructor(private readonly analytics: AnalyticsService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      // Catch up in batches, at most 10 per run.
      for (let i = 0; i < 10; i++) {
        const r = await this.analytics.projectOutbox(new Date(), 200);
        if (r.recorded || r.forgotten) this.logger.log(`analytics: ${r.recorded} recorded, ${r.forgotten} deleted (withdrawn)`);
        if (r.read < 200) break;
      }
    } catch (e) {
      this.logger.error(`analytics projection failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
