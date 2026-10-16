import { Injectable } from '@nestjs/common';
import { DatabaseService } from '../database/database.service';
import { retentionCutoffs, retentionPeriods, switchOn, type RetentionPeriods } from './rights-domain';

export type RetentionCounts = Record<'otpChallenges' | 'sessions' | 'friendCodes' | 'friendCodeAttempts' | 'analyticsEvents' | 'outboxEvents' | 'inactiveFlagged', number>;

/**
 * Step 20: the daily retention sweep. Deletes what has outlived its PROVISIONAL period (rights-domain.ts) and flags
 * accounts that have not signed in for the inactivity period. Nothing about tests, answers or progress is deleted:
 * how long learning records are kept is a decision for counsel. Each run is recorded in retention_run and audited.
 */
@Injectable()
export class RetentionService {
  readonly periods: RetentionPeriods = retentionPeriods(process.env);

  constructor(private readonly db: DatabaseService) {}

  async run(now = new Date()): Promise<RetentionCounts | null> {
    if (!switchOn('RETENTION_ENABLED')) return null;
    const db = this.db.client as any;
    const run = await db.retention_run.create({ data: { started_at: now } });
    try {
      const c = retentionCutoffs(now, this.periods);
      // Outbox events go only once analytics has read past them, so a paused projector loses nothing.
      const cursor = await db.analytics_cursor.findUnique({ where: { id: 'outbox' } });
      const outboxBefore = cursor && cursor.last_created_at < c.outbox ? cursor.last_created_at : c.outbox;
      const counts: RetentionCounts = {
        otpChallenges: (await db.otp_challenge.deleteMany({ where: { expires_at: { lt: c.otp } } })).count,
        sessions: (await db.auth_session.deleteMany({ where: { OR: [{ expires_at: { lt: c.session } }, { revoked_at: { lt: c.session } }] } })).count,
        friendCodes: (await db.friend_code.deleteMany({ where: { expires_at: { lt: c.friendCodeAttempt } } })).count,
        friendCodeAttempts: (await db.friend_code_attempt.deleteMany({ where: { at: { lt: c.friendCodeAttempt } } })).count,
        analyticsEvents: (await db.analytics_event.deleteMany({ where: { occurred_at: { lt: c.analytics } } })).count,
        outboxEvents: (await db.outbox_event.deleteMany({ where: { published_at: { not: null, lt: c.outbox }, created_at: { lt: outboxBefore } } })).count,
        inactiveFlagged: (
          await db.account.updateMany({
            where: {
              erased_at: null,
              inactive_flagged_at: null,
              created_at: { lt: c.inactive },
              OR: [{ last_sign_in_at: null }, { last_sign_in_at: { lt: c.inactive } }],
            },
            data: { inactive_flagged_at: now },
          })
        ).count,
      };
      await db.retention_run.update({ where: { id: run.id }, data: { finished_at: new Date(), counts, ok: true } });
      await db.audit_event.create({ data: { actor_account_id: null, action: 'retention.run', subject_type: 'retention_run', subject_id: run.id, metadata: counts } });
      return counts;
    } catch (e) {
      await db.retention_run.update({ where: { id: run.id }, data: { finished_at: new Date(), ok: false, error: (e as Error).message.slice(0, 300) } });
      throw e;
    }
  }
}
