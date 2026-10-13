/*
 * Executable wrapper: `ADMIN_OPERATOR=you node dist/curriculum/cli/import-ai.js <draft.json>`
 * Imports an AI-drafted structure as the AI actor. Logic and tests: import/ai-import.ts.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@exam-app/database';
import { OutboxService } from '../../outbox/outbox.service';
import { CurriculumService } from '../curriculum.service';
import { ImportFormatError } from '../import/content-import';
import { runAiImport } from '../import/ai-import';

async function main(): Promise<void> {
  const file = process.argv[2];
  const operator = process.env.ADMIN_OPERATOR?.trim();
  if (!operator) throw new ImportFormatError('ADMIN_OPERATOR must be set (who is running this?)');
  if (!file) throw new ImportFormatError('Usage: import-ai <draft.json>');
  const client = new PrismaClient();
  const db = { client } as never;
  try {
    const out = await runAiImport(readFileSync(file, 'utf8'), new CurriculumService(db, new OutboxService(db)), operator);
    const c = out.result.counts;
    console.log(`file sha256 ${out.sha256}`);
    if (!out.result.ok) {
      console.log(`NOT imported: ${out.result.issues.length} problem(s) with the file:`);
      for (const i of out.result.issues.slice(0, 50)) console.log(`  - ${i.where}: ${i.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Imported ${c.chapters} chapters, ${c.topics} topics, ${c.concepts} concepts, ${c.objectives} objectives. State: ${out.state}.`);
    const errs = out.result.findings.filter((f) => f.severity === 'ERROR').length;
    const warns = out.result.findings.length - errs;
    console.log(`Structural check (informational): ${errs} error(s), ${warns} warning(s). An editor reviews it and submits for validation.`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.name === 'ImportFormatError' || e.name.startsWith('Curriculum') ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
