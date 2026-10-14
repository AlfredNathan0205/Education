/* Executable wrapper: `node dist/publication/cli/bank.js status ICSE GRADE_8 PHYSICS`. Logic and tests: publication-cli.ts. */
import { PrismaClient } from '@exam-app/database';
import { PublicationService } from '../publication.service';
import { BankUsageError, runBankCli } from './publication-cli';

async function main(): Promise<void> {
  const client = new PrismaClient();
  try {
    const service = new PublicationService({ client } as never, undefined as never, undefined as never, undefined as never);
    console.log(
      await runBankCli(process.argv.slice(2), {
        unit: async (curriculumCode, gradeCode, subjectCode) => {
          const sv: any = await client.curriculum_subject_version.findFirst({
            where: { grade: { code: gradeCode }, subject: { code: subjectCode }, curriculum_version: { curriculum: { code: curriculumCode } } },
            orderBy: { revision: 'desc' },
            select: { curriculum_version_id: true, grade_id: true, subject_id: true },
          });
          return sv ? { curriculumVersionId: sv.curriculum_version_id, gradeId: sv.grade_id, subjectId: sv.subject_id } : null;
        },
        summary: (u) => service.summaryOfUnit(u),
      }),
    );
  } finally {
    await client.$disconnect();
  }
}

main().catch((e: Error) => {
  console.error(e instanceof BankUsageError ? e.message : `${e.name}: ${e.message}`);
  process.exit(1);
});
