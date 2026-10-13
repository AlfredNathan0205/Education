/*
 * Executable wrapper: `ADMIN_OPERATOR=you node dist/question/cli/import-ai-questions.js <file.json>`
 * Imports AI-drafted questions as DRAFT questions (AI actor; adds only; a person must submit and a
 * different person approve). Logic and tests: import/ai-question-import.ts.
 */
import { readFileSync } from 'node:fs';
import { PrismaClient } from '@exam-app/database';
import { CurriculumService } from '../../curriculum/curriculum.service';
import { OutboxService } from '../../outbox/outbox.service';
import { QuestionService } from '../question.service';
import { QuestionFormatError } from '../import/question-import';
import { runAiQuestionImport } from '../import/ai-question-import';

async function main(): Promise<void> {
  const file = process.argv[2];
  const operator = process.env.ADMIN_OPERATOR?.trim();
  if (!operator) throw new QuestionFormatError('ADMIN_OPERATOR must be set (who is running this?)');
  if (!file) throw new QuestionFormatError('Usage: import-ai-questions <file.json>');
  const client = new PrismaClient();
  const db = { client } as never;
  try {
    const out = await runAiQuestionImport(
      readFileSync(file, 'utf8'),
      { curriculum: new CurriculumService(db, new OutboxService(db)), questions: new QuestionService(db) },
      operator,
    );
    console.log(`file sha256 ${out.sha256}`);
    if (!out.result.ok) {
      console.log(`NOT imported: ${out.result.issues.length} problem(s) with the file:`);
      for (const i of out.result.issues.slice(0, 50)) console.log(`  - ${i.where}: ${i.message}`);
      process.exitCode = 1;
      return;
    }
    console.log(`Imported ${out.result.counts.CREATE} draft question(s). A person must now submit them for review.`);
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e.name.startsWith('Question') ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
