import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { RetentionService } from './retention.service';
import { RightsService } from './rights.service';

/** Hourly: erasures whose 14 days are up (ERASURE_ENABLED). Daily at 03:00 India time: retention (RETENTION_ENABLED). */
@Injectable()
export class RightsSweeper {
  private readonly logger = new Logger(RightsSweeper.name);
  private erasing = false;
  private retaining = false;

  constructor(private readonly rights: RightsService, private readonly retention: RetentionService) {}

  @Cron(CronExpression.EVERY_HOUR)
  async erasures(): Promise<void> {
    if (this.erasing) return;
    this.erasing = true;
    try {
      const r = await this.rights.runDue(new Date());
      if (r.completed || r.failed) this.logger.log(`erasure: ${r.completed} completed, ${r.failed} failed or retried`);
    } catch (e) {
      this.logger.error(`erasure run failed: ${(e as Error).message}`);
    } finally {
      this.erasing = false;
    }
  }

  // 21:30 UTC is 03:00 in India.
  @Cron('0 30 21 * * *')
  async retentionSweep(): Promise<void> {
    if (this.retaining) return;
    this.retaining = true;
    try {
      const c = await this.retention.run(new Date());
      if (c) this.logger.log(`retention: ${JSON.stringify(c)}`);
    } catch (e) {
      this.logger.error(`retention run failed: ${(e as Error).message}`);
    } finally {
      this.retaining = false;
    }
  }
}
