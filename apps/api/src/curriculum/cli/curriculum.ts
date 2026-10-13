/*
 * Executable wrapper: `node dist/curriculum/cli/curriculum.js seed <email|phone> <identifier> <seed.json>`
 * The account must already exist and hold CURRICULUM_EDITOR (or SUPER_ADMIN). Logic and tests: evidence-seed.ts.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@exam-app/database';
import { AuthzService } from '../../authz/authz.service';
import { OutboxService } from '../../outbox/outbox.service';
import { CurriculumAdminService } from '../curriculum-admin.service';
import { CurriculumService } from '../curriculum.service';
import { parseSeedFile, runEvidenceSeed, SeedFileError } from './evidence-seed';

async function main(): Promise<void> {
  const [command, kindArg, identifier, file] = process.argv.slice(2);
  const kind = kindArg?.toLowerCase() === 'email' ? 'EMAIL' : kindArg?.toLowerCase() === 'phone' ? 'PHONE' : null;
  if (command !== 'seed' || !kind || !identifier || !file) {
    throw new SeedFileError('Usage: curriculum seed <email|phone> <identifier> <seed.json>');
  }
  const seed = parseSeedFile(JSON.parse(readFileSync(file, 'utf8')));
  const client = new PrismaClient();
  const db = { client } as never;
  try {
    const authz = new AuthzService(db);
    const accountId = await authz.findAccountId(kind, identifier);
    if (!accountId) throw new SeedFileError('No account for that identifier. Sign in once first.');
    const admin = new CurriculumAdminService(new CurriculumService(db, new OutboxService(db)), authz);
    for (const line of await runEvidenceSeed(seed, accountId, admin)) console.log(line);
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e instanceof SeedFileError ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
