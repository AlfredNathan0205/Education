/**
 * Pure rules for publishing questions (Step 9). No database, no I/O.
 *
 * Approved is not published (spec invariant 7). Approval says the wording and answer are right; publication says a
 * person has put this exact revision into the bank that tests are built from. Reviewers do not publish: an approver
 * does. The AI never does. Quarantining or retiring a question withdraws it, and restoring one does not republish it.
 */
import type { CurriculumRole } from '../curriculum/curriculum-state';
import type { QuestionState } from '../question/question-domain';

export type PublicationState = 'PUBLISHED' | 'WITHDRAWN';
/** Stored health. QUARANTINED and RETIRED are read from the revision's state. */
export type StoredHealth = 'NEW' | 'HEALTHY' | 'WATCH' | 'DEGRADED';
export type BankStatus = 'NOT_PUBLISHED' | 'WITHDRAWN' | StoredHealth | 'QUARANTINED' | 'RETIRED';

export const PUBLISH_ROLES: readonly CurriculumRole[] = ['APPROVER', 'SUPER_ADMIN'];
/** Pulling a question out of serving is the safe direction, so any reviewer may, as with quarantine. */
export const WITHDRAW_ROLES: readonly CurriculumRole[] = ['REVIEWER', 'APPROVER', 'SUPER_ADMIN'];
export const HEALTH_ROLES: readonly CurriculumRole[] = ['REVIEWER', 'APPROVER', 'SUPER_ADMIN'];

/** Health a person may set. NEW is only the starting value. */
export const SETTABLE_HEALTH: readonly StoredHealth[] = ['HEALTHY', 'WATCH', 'DEGRADED'];

export interface PublishFacts {
  revisionState: QuestionState;
  answerVerified: boolean;
  /** The last deterministic check on this exact revision passed. */
  checksPassed: boolean;
  objectiveExists: boolean;
  /** State of the unit's newest curriculum revision. */
  curriculumState: string;
  /** Local testing only: EXAM_ALLOW_UNACTIVATED_CURRICULUM. Refused in production by the exam config. */
  allowUnactivatedCurriculum: boolean;
  publication: PublicationState | null;
  /** Only a person publishes. */
  actorIsHuman: boolean;
}

/** Everything that stops this revision being published, in plain words. Empty means it may be published. */
export function publishBlockers(f: PublishFacts): string[] {
  const out: string[] = [];
  if (!f.actorIsHuman) out.push('only a person can publish a question');
  if (f.revisionState !== 'APPROVED') out.push(`only an approved question can be published (this one is ${f.revisionState.toLowerCase().replace(/_/g, ' ')})`);
  if (f.publication === 'PUBLISHED') out.push('this version is already published');
  if (f.revisionState === 'APPROVED') {
    if (!f.answerVerified) out.push('nobody has confirmed the answer key on this version');
    if (!f.checksPassed) out.push('the automatic checks have not passed on this version');
    if (!f.objectiveExists) out.push('its learning objective no longer exists in the curriculum');
    if (f.curriculumState !== 'ACTIVE' && !f.allowUnactivatedCurriculum) out.push(`the curriculum for this subject is not active (it is ${f.curriculumState.toLowerCase().replace(/_/g, ' ')}); only an active curriculum can publish`);
  }
  return out;
}

export function bankStatus(revisionState: QuestionState, publication: PublicationState | null, stored: StoredHealth | null): BankStatus {
  if (revisionState === 'QUARANTINED') return 'QUARANTINED';
  if (revisionState === 'RETIRED' || revisionState === 'SUPERSEDED') return 'RETIRED';
  if (publication === null) return 'NOT_PUBLISHED';
  if (publication === 'WITHDRAWN') return 'WITHDRAWN';
  return stored ?? 'NEW';
}

/**
 * The question can go into a new test: approved, published, and not marked DEGRADED. The exam engine applies the same
 * rule in its database query; this is the readable statement of it.
 */
export function isServable(revisionState: QuestionState, publication: PublicationState | null, stored: StoredHealth | null): boolean {
  return revisionState === 'APPROVED' && publication === 'PUBLISHED' && stored !== 'DEGRADED';
}

export function healthBlockers(from: StoredHealth | null, to: string, noteLength: number): string[] {
  const out: string[] = [];
  if (!(SETTABLE_HEALTH as readonly string[]).includes(to)) out.push(`health must be one of ${SETTABLE_HEALTH.join(', ')}`);
  else if ((from ?? 'NEW') === to) out.push(`it is already ${to}`);
  if (noteLength < 5) out.push('a note of at least 5 characters is required');
  return out;
}

export interface UnitBankSummary {
  total: number;
  byState: Record<string, number>;
  byStatus: Record<BankStatus, number>;
  /** Approved, not yet published. */
  awaitingPublication: number;
}

export function summariseBank(rows: Array<{ state: QuestionState; publication: PublicationState | null; health: StoredHealth | null }>): UnitBankSummary {
  const byState: Record<string, number> = {};
  const byStatus: Record<BankStatus, number> = { NOT_PUBLISHED: 0, WITHDRAWN: 0, NEW: 0, HEALTHY: 0, WATCH: 0, DEGRADED: 0, QUARANTINED: 0, RETIRED: 0 };
  let awaiting = 0;
  for (const r of rows) {
    byState[r.state] = (byState[r.state] ?? 0) + 1;
    byStatus[bankStatus(r.state, r.publication, r.health)]++;
    if (r.state === 'APPROVED' && r.publication !== 'PUBLISHED') awaiting++;
  }
  return { total: rows.length, byState, byStatus, awaitingPublication: awaiting };
}
