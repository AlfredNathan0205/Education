/**
 * Read-only operator tool: how much of the bank is actually in the serving bank?
 *
 *   bank status <curriculumCode> <gradeCode> <subjectCode>
 *
 * Publishing is done by an approver signed in to the question bank screen, not from here, so that every publication
 * is tied to a named person's role.
 */
import type { UnitBankSummary } from '../publication-domain';

export class BankUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BankUsageError';
  }
}

export const USAGE = 'Usage: bank status <curriculumCode> <gradeCode> <subjectCode>';

export async function runBankCli(
  argv: string[],
  deps: { unit: (c: string, g: string, s: string) => Promise<{ curriculumVersionId: string; gradeId: string; subjectId: string } | null>; summary: (u: { curriculumVersionId: string; gradeId: string; subjectId: string }) => Promise<UnitBankSummary> },
): Promise<string> {
  const [command, c, g, s, ...extra] = argv;
  if (command !== 'status' || !c || !g || !s || extra.length) throw new BankUsageError(USAGE);
  const unit = await deps.unit(c, g, s);
  if (!unit) throw new BankUsageError('No curriculum found for that curriculum, grade and subject');
  const r = await deps.summary(unit);
  const inBank = r.byStatus.NEW + r.byStatus.HEALTHY + r.byStatus.WATCH;
  const lines = [
    `Questions: ${r.total}`,
    `By review state: ${Object.entries(r.byState).map(([k, v]) => `${k.toLowerCase()} ${v}`).join(', ') || 'none'}`,
    `In the serving bank (approved and published): ${inBank}  (new ${r.byStatus.NEW}, healthy ${r.byStatus.HEALTHY}, watch ${r.byStatus.WATCH})`,
    `Held back as degraded: ${r.byStatus.DEGRADED}`,
    `Approved and waiting to be published: ${r.awaitingPublication}  (never published ${r.byStatus.NOT_PUBLISHED}, withdrawn ${r.byStatus.WITHDRAWN})`,
    `Quarantined ${r.byStatus.QUARANTINED}, retired or replaced ${r.byStatus.RETIRED}`,
  ];
  if (r.awaitingPublication > 0) lines.push('An approver publishes them in the question bank screen. Tests use only published questions.');
  return lines.join('\n');
}
