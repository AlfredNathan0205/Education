/**
 * Step 20: data rights (export and erasure) and retention. Pure rules and configuration; the services do the I/O.
 *
 * PM decisions (16 October): erasure deletes personal data and unlinks the rest; self-serve requests with a 14-day
 * cancellable wait; adults ask for themselves and a guardian asks for a minor; retention periods are PROVISIONAL until
 * counsel confirms them.
 */

export const ERASURE_WAIT_DAYS = 14;
export const DAY_MS = 86_400_000;
/** Exports per requester and subject in any 24 hours. */
export const EXPORTS_PER_DAY = 3;
/** An erasure that fails is retried by the next run, up to this many times, then marked FAILED for an operator. */
export const ERASURE_MAX_ATTEMPTS = 5;

export type SubjectType = 'STUDENT' | 'ACCOUNT';
export type ErasureBlock = 'MINOR_ASKS_GUARDIAN' | 'GUARDIAN_OF_CHILDREN' | 'ADMIN_ROLE' | 'ALREADY_PENDING';

export const BLOCK_MESSAGE: Record<ErasureBlock, string> = {
  MINOR_ASKS_GUARDIAN: 'Ask your parent or guardian: they can delete your account from their guardian page.',
  GUARDIAN_OF_CHILDREN: 'You approve a child on Exam App. Delete their account first, or withdraw your approval, then delete yours.',
  ADMIN_ROLE: 'Your account has an administrator role. Ask another administrator to remove it first.',
  ALREADY_PENDING: 'Deletion is already scheduled.',
};

export function erasureDueAt(requestedAt: Date, waitDays = ERASURE_WAIT_DAYS): Date {
  return new Date(requestedAt.getTime() + waitDays * DAY_MS);
}

/**
 * Who may ask to erase whom. A student's own account: an adult only. A minor: an approving guardian. An account with
 * no student (a parent or guardian): themselves, once they approve no child and hold no role.
 */
export function erasureBlock(input: {
  capacity: 'SELF' | 'GUARDIAN';
  subjectIsMinor: boolean;
  requesterApprovesChildren: boolean;
  requesterHasRole: boolean;
  pending: boolean;
}): ErasureBlock | null {
  if (input.pending) return 'ALREADY_PENDING';
  if (input.capacity === 'GUARDIAN') return null;
  if (input.subjectIsMinor) return 'MINOR_ASKS_GUARDIAN';
  if (input.requesterHasRole) return 'ADMIN_ROLE';
  if (input.requesterApprovesChildren) return 'GUARDIAN_OF_CHILDREN';
  return null;
}

// ── export ─────────────────────────────────────────────────────────────────

/** Columns never exported: secrets, hashes and internal keys. Matched against the column name. */
export const EXPORT_OMIT = /(_hash|idempotency_key|^seed$|ciphertext|^assembly_report$|^items$)$/;

/**
 * Where a student's data lives, for the export. `by` says how rows are found: the student id in a column, or the
 * student's test sessions. Everything listed is the student's own; other students' data is never included (friendships
 * and challenges are counted, not listed, because their rows name the other student).
 */
export const STUDENT_EXPORT_TABLES: Array<{ table: string; by: { column: string } | { sessions: string } }> = [
  { table: 'age_classification', by: { column: 'student_id' } },
  { table: 'student_academic_context', by: { column: 'student_id' } },
  { table: 'student_school_association', by: { column: 'student_id' } },
  { table: 'student_chapter_selection', by: { column: 'student_id' } },
  { table: 'consent_record', by: { column: 'student_id' } },
  { table: 'assessment_instance', by: { column: 'student_id' } },
  { table: 'assessment_session', by: { column: 'student_id' } },
  { table: 'student_response', by: { sessions: 'session_id' } },
  { table: 'assessment_result', by: { column: 'student_id' } },
  { table: 'student_mastery_state', by: { column: 'student_id' } },
  { table: 'mastery_state_change', by: { column: 'student_id' } },
  { table: 'recommendation', by: { column: 'student_id' } },
  { table: 'competitive_qualification', by: { column: 'student_id' } },
  { table: 'cp_event', by: { column: 'student_id' } },
  { table: 'xp_event', by: { column: 'student_id' } },
  { table: 'public_profile', by: { column: 'student_id' } },
  { table: 'student_report', by: { column: 'student_id' } },
  { table: 'parent_share_invitation', by: { column: 'student_id' } },
  { table: 'parent_view_grant', by: { column: 'student_id' } },
  { table: 'guardian_invitation', by: { column: 'student_id' } },
  { table: 'subscription', by: { column: 'student_id' } },
  { table: 'entitlement_grant', by: { column: 'student_id' } },
  { table: 'safety_report', by: { column: 'reporter_student_id' } },
  { table: 'mastery_evidence_event', by: { column: 'student_id' } },
  { table: 'mastery_update_run', by: { column: 'student_id' } },
  { table: 'student_difficulty_state', by: { column: 'student_id' } },
  { table: 'student_cognitive_state', by: { column: 'student_id' } },
  { table: 'student_question_exposure', by: { column: 'student_id' } },
  { table: 'recommendation_refresh', by: { column: 'student_id' } },
  { table: 'challenge_participant', by: { column: 'student_id' } },
  { table: 'friendship_guardian_approval', by: { column: 'student_id' } },
  { table: 'guardian_relationship', by: { column: 'student_id' } },
];

export type ErasureHandling =
  /** Rows are deleted. */
  | 'DELETE'
  /** Rows stay under the student or account id, which after erasure leads to no person. */
  | 'KEEP_UNLINKED'
  /** Rows stay but are ended or cancelled (they involve someone else). */
  | 'END'
  /** Rows stay as evidence (consent, safety, audit); see the notes for counsel. */
  | 'KEEP_EVIDENCE'
  /** Rows are about the work of staff, not about the person as a learner or parent. */
  | 'STAFF';

/**
 * Every table with a column pointing at a student or an account, and what erasure does to it. A unit test reads the
 * Prisma schema and fails if a table with such a column is missing here, so a new table cannot be forgotten.
 */
export const ERASURE_MAP: Record<string, ErasureHandling> = {
  account_student_access: 'DELETE',
  admin_mfa_factor: 'DELETE',
  age_classification: 'DELETE',
  auth_session: 'DELETE',
  authentication_identity: 'DELETE',
  friend_code: 'DELETE',
  friend_code_attempt: 'DELETE',
  guardian_invitation: 'DELETE',
  parent_share_invitation: 'DELETE',
  parent_view_grant: 'DELETE',
  public_profile: 'DELETE',
  student_block: 'DELETE',
  student_report: 'DELETE',
  student_school_association: 'DELETE',
  release_access: 'DELETE',
  assessment_instance: 'KEEP_UNLINKED',
  assessment_result: 'KEEP_UNLINKED',
  assessment_session: 'KEEP_UNLINKED',
  competitive_qualification: 'KEEP_UNLINKED',
  cp_event: 'KEEP_UNLINKED',
  mastery_evidence_event: 'KEEP_UNLINKED',
  mastery_state_change: 'KEEP_UNLINKED',
  mastery_update_run: 'KEEP_UNLINKED',
  recommendation: 'KEEP_UNLINKED',
  recommendation_refresh: 'KEEP_UNLINKED',
  student_academic_context: 'KEEP_UNLINKED',
  student_chapter_selection: 'KEEP_UNLINKED',
  student_cognitive_state: 'KEEP_UNLINKED',
  student_difficulty_state: 'KEEP_UNLINKED',
  student_mastery_state: 'KEEP_UNLINKED',
  student_question_exposure: 'KEEP_UNLINKED',
  xp_event: 'KEEP_UNLINKED',
  privacy_request: 'KEEP_UNLINKED',
  challenge: 'END',
  challenge_participant: 'KEEP_UNLINKED',
  friendship: 'END',
  friendship_guardian_approval: 'END',
  subscription: 'END',
  entitlement_grant: 'END',
  role_assignment: 'END',
  guardian_relationship: 'END',
  consent_record: 'KEEP_EVIDENCE',
  consent_withdrawal: 'KEEP_EVIDENCE',
  safety_report: 'KEEP_EVIDENCE',
  social_restriction: 'KEEP_EVIDENCE',
  audit_event: 'KEEP_EVIDENCE',
  subscription_event: 'KEEP_EVIDENCE',
  curriculum_activation_record: 'STAFF',
  curriculum_approval_record: 'STAFF',
  curriculum_event_log: 'STAFF',
  question_event: 'STAFF',
  question_publication_event: 'STAFF',
  experiment: 'STAFF',
  subject_release: 'STAFF',
  subject_release_event: 'STAFF',
  readiness_report: 'STAFF',
};

/** Student tables deliberately left out of the export, and why. */
export const NOT_EXPORTED: Record<string, string> = {
  challenge: 'names the other student; counted instead',
  friendship: 'names the other student; counted instead',
  student_block: 'names another student',
  safety_report_about: 'reports by others about the student would reveal the reporter (counsel to decide)',
  social_restriction: 'a safety decision; counsel to decide whether and how to disclose',
  friend_code: 'short-lived codes',
  friend_code_attempt: 'rate-limit records',
};

/** Masks someone else's email or number that appears in the student's rows (an invitation they sent). */
export function maskOther(value: string): string {
  const at = value.indexOf('@');
  if (at > 0) return `${value[0]}•••${value.slice(at)}`;
  return value.length > 4 ? `•••${value.slice(-4)}` : '•••';
}

/** Columns holding someone else's email or number, masked in the export. */
export const EXPORT_MASK = new Set(['email_normalized', 'guardian_email_normalized']);

/** Plain JSON for one row: dates as ISO strings, big integers as strings, omitted and masked columns applied. */
export function exportRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (EXPORT_OMIT.test(k)) continue;
    if (EXPORT_MASK.has(k) && typeof v === 'string') out[k] = maskOther(v);
    else out[k] = plain(v);
  }
  return out;
}

function plain(v: unknown): unknown {
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(plain);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, plain(x)]));
  return v;
}

// ── retention ──────────────────────────────────────────────────────────────

export interface RetentionPeriods {
  /** Sign-in codes, after they expire. */
  otpDays: number;
  /** Sessions, after they expire or are revoked. */
  sessionDays: number;
  /** Friend-code attempts. */
  friendCodeAttemptDays: number;
  /** Pseudonymous analytics rows. */
  analyticsMonths: number;
  /** Outbox events, after they are published (and analytics has read them). */
  outboxDays: number;
  /** Accounts not signed in for this long are flagged (not deleted: what happens next is for counsel). */
  inactiveMonths: number;
}

/** PROVISIONAL defaults (PM, 16 October), each overridable by RETENTION_<NAME>; counsel to confirm. */
export const DEFAULT_RETENTION: RetentionPeriods = {
  otpDays: 90,
  sessionDays: 90,
  friendCodeAttemptDays: 30,
  analyticsMonths: 13,
  outboxDays: 90,
  inactiveMonths: 24,
};

const ENV_NAMES: Record<keyof RetentionPeriods, string> = {
  otpDays: 'RETENTION_OTP_DAYS',
  sessionDays: 'RETENTION_SESSION_DAYS',
  friendCodeAttemptDays: 'RETENTION_FRIEND_CODE_ATTEMPT_DAYS',
  analyticsMonths: 'RETENTION_ANALYTICS_MONTHS',
  outboxDays: 'RETENTION_OUTBOX_DAYS',
  inactiveMonths: 'RETENTION_INACTIVE_MONTHS',
};

/** Periods from the environment. A value must be a whole number of at least 1; anything else stops start-up. */
export function retentionPeriods(env: Record<string, string | undefined> = process.env): RetentionPeriods {
  const out = { ...DEFAULT_RETENTION };
  for (const [k, name] of Object.entries(ENV_NAMES) as Array<[keyof RetentionPeriods, string]>) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 1200) throw new Error(`${name} must be a whole number from 1 to 1200`);
    out[k] = n;
  }
  return out;
}

/** Calendar months back (UTC), for the month-based periods. */
export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now.getTime());
  d.setUTCMonth(d.getUTCMonth() - months);
  return d;
}

export function retentionCutoffs(now: Date, p: RetentionPeriods) {
  const days = (n: number) => new Date(now.getTime() - n * DAY_MS);
  return {
    otp: days(p.otpDays),
    session: days(p.sessionDays),
    friendCodeAttempt: days(p.friendCodeAttemptDays),
    analytics: monthsBefore(now, p.analyticsMonths),
    outbox: days(p.outboxDays),
    inactive: monthsBefore(now, p.inactiveMonths),
  };
}

export function switchOn(name: string, env: Record<string, string | undefined> = process.env): boolean {
  const raw = env[name]?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be "true" or "false"`);
}
