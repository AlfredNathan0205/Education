import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ParentService } from './parent.service';

/** REPORTS_ENABLED=false stops weekly reports being frozen (the live summary still works). On by default. */
export function reportsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.REPORTS_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('REPORTS_ENABLED must be "true" or "false"');
}

/**
 * Every 30 seconds: freezes last week's report for students who were active in it (once their tests are counted), and
 * adds a new version where that week's evidence was corrected later. Safe on several API instances (one report per
 * student and week, unique versions, under the student's row lock). A failure is logged and retried next time.
 */
@Injectable()
export class ReportSweeper {
  private readonly logger = new Logger(ReportSweeper.name);
  private readonly enabled = reportsEnabled();
  private running = false;

  constructor(private readonly parent: ParentService) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async run(): Promise<number> {
    if (!this.enabled || this.running) return 0;
    this.running = true;
    try {
      const done = await this.parent.reconcile(new Date(), 50);
      if (done.length) this.logger.log(`weekly reports written: ${done.length}`);
      return done.length;
    } catch (e) {
      this.logger.error(`weekly report update failed: ${(e as Error).message}`);
      return 0;
    } finally {
      this.running = false;
    }
  }
}
