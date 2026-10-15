import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { parseBetaUntil } from './entitlement-domain';
import { EntitlementService } from './entitlement.service';

/**
 * Every 5 minutes: ends subscriptions whose period is over, and while BETA_GRANT_UNTIL is set (a date such as
 * 2027-03-31, in the future), gives every student a BETA plan until the end of that day (India time), or extends it if
 * the date moved later. Unset or past: no beta grants, and existing ones run out on their own date.
 * A malformed BETA_GRANT_UNTIL fails at startup.
 */
@Injectable()
export class EntitlementSweeper {
  private readonly logger = new Logger(EntitlementSweeper.name);
  private readonly raw = process.env.BETA_GRANT_UNTIL;
  private running = false;

  constructor(private readonly entitlements: EntitlementService) {
    parseBetaUntil(this.raw, new Date(0));
  }

  @Cron(CronExpression.EVERY_5_MINUTES)
  async run(now = new Date()): Promise<{ expired: number; granted: number; extended: number } | null> {
    if (this.running) return null;
    this.running = true;
    try {
      const r = await this.entitlements.reconcile(parseBetaUntil(this.raw, now), now);
      if (r.expired || r.granted || r.extended) this.logger.log(`plans: ${r.granted} beta granted, ${r.extended} extended, ${r.expired} expired`);
      return r;
    } catch (e) {
      this.logger.error(`plan update failed: ${(e as Error).message}`);
      return null;
    } finally {
      this.running = false;
    }
  }
}
