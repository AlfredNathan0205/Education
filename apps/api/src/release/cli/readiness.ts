/*
 * Operator tooling for content readiness (database access, trusted like the roles CLI). Set ADMIN_OPERATOR.
 *
 *   readiness policy                                      show the active policy and whether it is signed off
 *   readiness policy publish <CODE> <file.json> [notes]   a new policy version becomes active (PROVISIONAL)
 *   readiness policy sign-off <CODE> "<academic lead>" "<reference to their written approval>"
 *   readiness report <curriculum> <grade> <subject>       check the served revision now and print the verdict
 *   readiness access <INTERNAL|CONTROLLED> <emails.txt> "<reason>"   give an audience to many accounts (one email per line)
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@exam-app/database';
import { AuthzService } from '../../authz/authz.service';
import { OutboxService } from '../../outbox/outbox.service';
import { ReadinessService } from '../readiness.service';
import { ReleaseService } from '../release.service';

const USAGE = `Usage:
  readiness policy
  readiness policy publish <CODE> <file.json> [notes]
  readiness policy sign-off <CODE> "<academic lead's name>" "<reference>"
  readiness report <curriculum> <grade> <subject>
  readiness access <INTERNAL|CONTROLLED> <emails.txt> "<reason>"`;

async function main(): Promise<void> {
  const [cmd, a, b, c, d] = process.argv.slice(2);
  const operator = process.env.ADMIN_OPERATOR?.trim() ?? '';
  const client = new PrismaClient();
  const db = { client } as never;
  const authz = new AuthzService(db);
  const release = new ReleaseService(db, authz);
  const readiness = new ReadinessService(db, authz, release, new OutboxService(db));
  try {
    if (cmd === 'policy' && !a) {
      const p = await client.readiness_policy_version.findFirst({ where: { status: 'ACTIVE' } });
      console.log(p ? JSON.stringify({ code: p.code, signedOff: p.signed_off_at ? { by: p.signed_off_by_name, reference: p.signed_off_reference, at: p.signed_off_at } : 'PROVISIONAL', params: p.params }, null, 2) : 'No active policy.');
    } else if (cmd === 'policy' && a === 'publish' && b && c) {
      if (!operator) throw new Error('ADMIN_OPERATOR must be set');
      console.log(JSON.stringify(await readiness.publishPolicy({ code: b, params: JSON.parse(readFileSync(c, 'utf8')), notes: d, operator })));
    } else if (cmd === 'policy' && a === 'sign-off' && b && c && d) {
      if (!operator) throw new Error('ADMIN_OPERATOR must be set');
      console.log(JSON.stringify(await readiness.signOff({ code: b, approverName: c, reference: d, operator })));
    } else if (cmd === 'report' && a && b && c) {
      const unit = await client.curriculum_subject_version.findFirst({
        where: { curriculum_version: { curriculum: { code: a } }, grade: { code: b }, subject: { code: c }, state: 'ACTIVE' },
        orderBy: { revision: 'desc' },
      });
      if (!unit) throw new Error('No ACTIVE revision for that subject.');
      const r = await readiness.generate(null, unit.id);
      console.log(`Report ${r.id} (${r.policy.code}${r.policy.signedOff ? '' : ', PROVISIONAL'}): highest tier ${r.highest}`);
      for (const [tier, v] of Object.entries(r.result.tiers)) for (const ch of v.checks) console.log(`${tier.padEnd(10)} ${ch.ok ? 'pass' : 'FAIL'}  ${ch.message}`);
    } else if (cmd === 'access' && a && b && c) {
      if (!operator) throw new Error('ADMIN_OPERATOR must be set');
      const emails = readFileSync(b, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
      for (const email of emails) {
        try {
          const r = await release.grantAccess(null, { email, tier: a, reason: c }, new Date(), operator);
          console.log(`${email}: ${a}${r.replaced ? ' (replaced an earlier grant)' : ''}`);
        } catch (e) {
          console.log(`${email}: not given (${(e as Error).message})`);
        }
      }
    } else {
      throw new Error(USAGE);
    }
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
