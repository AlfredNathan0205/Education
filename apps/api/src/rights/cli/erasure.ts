/*
 * Executable wrapper for operators (database access, trusted like the roles CLI):
 *
 *   node dist/rights/cli/erasure.js tombstones            > tombstones.jsonl   (keep this file OUTSIDE the database backups)
 *   node dist/rights/cli/erasure.js reapply tombstones.jsonl                   (after restoring a backup)
 *   node dist/rights/cli/erasure.js run-due                                    (run due erasures now)
 *   node dist/rights/cli/erasure.js retention                                  (run the retention sweep now)
 *
 * A restored backup brings back data that was erased after it was taken, and its own tombstone table is just as old.
 * That is why the tombstones are exported and kept apart, and reapplied from that file. See the launch review.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@exam-app/database';
import { AnalyticsService } from '../../analytics/analytics.service';
import { AuthzService } from '../../authz/authz.service';
import { OutboxService } from '../../outbox/outbox.service';
import { PrivacyService } from '../../privacy/privacy.service';
import { RetentionService } from '../retention.service';
import { RightsService } from '../rights.service';
import { parseTombstones } from './tombstones';

async function main(): Promise<void> {
  const [command, file] = process.argv.slice(2);
  const client = new PrismaClient();
  const db = { client } as never;
  const outbox = new OutboxService(db);
  const privacy = new PrivacyService(db, outbox);
  const rights = new RightsService(db, privacy, new AnalyticsService(db, privacy, new AuthzService(db)), outbox);
  try {
    switch (command) {
      case 'tombstones':
        for (const t of await rights.tombstones()) console.log(JSON.stringify(t));
        return;
      case 'reapply': {
        if (!file) throw new Error('Usage: erasure reapply <tombstones.jsonl>');
        const r = await rights.reapply(parseTombstones(readFileSync(file, 'utf8')));
        console.log(`Reapplied ${r.applied}; ${r.skipped} no longer present.`);
        return;
      }
      case 'run-due':
        console.log(JSON.stringify(await rights.runDue(new Date(), 1000)));
        return;
      case 'retention':
        console.log(JSON.stringify(await new RetentionService(db).run(new Date())));
        return;
      default:
        throw new Error('Usage: erasure tombstones | reapply <file> | run-due | retention');
    }
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
