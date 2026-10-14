export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** Calls the same-origin proxy. Throws ApiError with a message safe to show to the user. */
export async function bff<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api/bff/${path}`, {
      method,
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'You appear to be offline. Check your connection and try again.');
  }
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON error body */
  }
  if (!res.ok) {
    const raw = (data as { message?: unknown } | null)?.message;
    const msg = Array.isArray(raw) ? String(raw[0]) : typeof raw === 'string' ? raw : null;
    throw new ApiError(res.status, msg ?? 'Something went wrong. Please try again.');
  }
  return data as T;
}

export interface StudentProfile {
  studentId: string;
  displayName: string | null;
  ageClassified: boolean;
  requiresGuardianConsent: boolean;
}

export interface AdminUnit {
  id: string;
  curriculumCode: string;
  versionLabel: string;
  gradeCode: string;
  subjectCode: string;
  subjectName: string;
  revision: number;
  state: string;
}

export interface QuestionRow {
  questionId: string;
  revisionId: string;
  code: string;
  objectivePath: string;
  stem: string;
  difficulty: 'EASY' | 'MEDIUM' | 'HARD';
  cognitive: 'C1' | 'C2' | 'C3' | 'C4' | null;
  state: 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUIRED' | 'APPROVED' | 'RETIRED' | 'SUPERSEDED' | 'QUARANTINED';
  revision: number;
  origin: 'HUMAN' | 'AI_DRAFT';
  bankStatus: BankStatus;
}

export type BankStatus = 'NOT_PUBLISHED' | 'WITHDRAWN' | 'NEW' | 'HEALTHY' | 'WATCH' | 'DEGRADED' | 'QUARANTINED' | 'RETIRED';

export const BANK_STATUS_LABEL: Record<BankStatus, string> = {
  NOT_PUBLISHED: 'not published',
  WITHDRAWN: 'withdrawn',
  NEW: 'published (new)',
  HEALTHY: 'published (healthy)',
  WATCH: 'published (watch)',
  DEGRADED: 'published but held back (degraded)',
  QUARANTINED: 'quarantined',
  RETIRED: 'retired',
};

export interface UnitBankSummary {
  total: number;
  byState: Record<string, number>;
  byStatus: Record<BankStatus, number>;
  awaitingPublication: number;
}

export interface PublishUnitResult {
  published: number;
  skipped: Array<{ code: string; reasons: string[] }>;
}

export interface QuestionDetail extends QuestionRow {
  publication: { state: 'PUBLISHED' | 'WITHDRAWN'; publishedAt: string; withdrawnReason: string | null; withdrawnNote: string | null } | null;
  explanation: string | null;
  options: Array<{ label: string; text: string; isCorrect: boolean }>;
  reviewNote: string | null;
  answerVerified: boolean;
  aiSource: string | null;
  validation: { validatorVersion: string; passed: boolean; findings: Array<{ code: string; severity: 'CRITICAL' | 'MAJOR' | 'MINOR'; message: string }>; at: string } | null;
  generation: { batchId: string; route: string | null; confidence: number | null; repairs: number; issues: Array<{ role: string; message: string }>; reason: string | null } | null;
  history: Array<{ from: string | null; to: string; actorKind: string; reasonCode: string | null; note: string | null; at: string }>;
}

/** Same list as the server (apps/api/src/question/reason-codes.ts); the server rejects anything else. */
export const REASON_CODE_LABELS: Record<string, string> = {
  ANSWER_WRONG: 'The answer key is wrong',
  ANSWER_AMBIGUOUS: 'More than one answer could be right',
  OFF_CURRICULUM: 'Outside the curriculum',
  EXPLANATION_WRONG: 'The explanation is wrong',
  EXPLANATION_WEAK: 'The explanation is weak',
  DISTRACTOR_WEAK: 'The wrong options are weak',
  DIFFICULTY_MISMATCH: 'Difficulty does not match',
  COGNITIVE_MISMATCH: 'Cognitive level does not match',
  DUPLICATE_OR_NEAR_DUPLICATE: 'Duplicate or near duplicate',
  LANGUAGE_OR_READABILITY: 'Language or readability',
  UNSAFE_OR_INAPPROPRIATE: 'Unsafe or inappropriate',
  LIVE_PERFORMANCE_SIGNAL: 'Students\' answers suggest a problem',
  OTHER: 'Other',
};

export interface QuestionUploadResult {
  ok: boolean;
  written: boolean;
  counts: { CREATE: number; UPDATE: number; NEW_REVISION: number; UNCHANGED: number };
  issues: Array<{ where: string; message: string }>;
}

export interface UploadResult {
  ok: boolean;
  written: boolean;
  counts: { chapters: number; topics: number; concepts: number; objectives: number };
  issues: Array<{ where: string; message: string }>;
  findings: Array<{ severity: 'ERROR' | 'WARNING'; rule: string; path: string; message: string }>;
  state?: string;
}

export interface ExamUnit {
  subjectVersionId: string;
  curriculumCode: string;
  versionLabel: string;
  gradeCode: string;
  subjectCode: string;
  subjectName: string;
  usableQuestions: number;
  chosenChapters: number;
  /** Quick 10 can be built now. */
  ready: boolean;
  /** Every test this subject offers (Step 10). The student screen shows only Quick 10 until Step 12. */
  tests: Array<{ code: string; name: string; total: number; ready: boolean }>;
}

export interface MyAssessment {
  assessmentId: string;
  mode: 'TEST' | 'PRACTICE';
  status: ExamStatus;
  subjectCode: string;
  subjectName: string;
  gradeCode: string;
  blueprint: string;
  startedAt: string;
  submittedAt: string | null;
  expiresAt: string;
  correct: number | null;
  total: number | null;
}

/** INVALIDATED: every question in it was removed, so it does not count (Step 11). */
export type ExamStatus = 'IN_PROGRESS' | 'SUBMITTED' | 'VOID' | 'INVALIDATED';

export interface ExamView {
  assessmentId: string;
  mode: 'TEST' | 'PRACTICE';
  status: ExamStatus;
  expiresAt: string;
  total: number;
  answered: number;
  /** Questions taken out of this test (technical problem or found to be wrong). They do not count. */
  removed: number;
  phase: 'QUESTION' | 'SUMMARY' | 'ENDED';
  question?: { position: number; total: number; pass: 'MAIN' | 'REVISIT'; stem: string; options: Array<{ slot: number; text: string }> };
  summary?: { answered: number; unanswered: number; canReviewSkipped: boolean };
}

export interface ExamLockResult {
  locked: true;
  reveal?: { correct: boolean; correctSlot: number; explanation: string | null };
}

export interface ExamResult {
  assessmentId: string;
  mode: 'TEST' | 'PRACTICE';
  total: number;
  correct: number;
  unanswered: number;
  removed: number;
  corrected: boolean;
  byDifficulty: Record<'EASY' | 'MEDIUM' | 'HARD', { total: number; correct: number }>;
  competitiveEligible: boolean;
  items: Array<{
    position: number;
    difficulty: 'EASY' | 'MEDIUM' | 'HARD';
    stem: string;
    outcome: 'CORRECT' | 'INCORRECT' | 'UNANSWERED' | 'EXCLUDED';
    excludedReason: 'TECHNICAL_FAILURE' | 'INVALIDATED' | null;
    explanation: string | null;
    options: Array<{ slot: number; text: string; isCorrect: boolean; chosen: boolean }>;
  }>;
}

export interface GuardianStatus {
  approvalNeeded: boolean;
  approved: boolean;
  pending: { maskedEmail: string; relationshipType: string; expiresAt: string; canResendAt: string } | null;
}

export interface GuardianPreview {
  relationshipType: string;
  expiresAt: string;
  consent: { version: number; title: string; paragraphs: string[]; draft: boolean };
}

export interface GuardianApproval {
  consentRecordId: string;
  studentId: string;
  displayName: string | null;
  grantedAt: string;
}

export const GUARDIAN_TOKEN_KEY = 'guardian_invite_token';

/** The approval link's token lives only in this tab's sessionStorage (never in a URL or cookie). */
export function rememberGuardianToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(GUARDIAN_TOKEN_KEY, token);
    else sessionStorage.removeItem(GUARDIAN_TOKEN_KEY);
  } catch {
    /* storage unavailable: the link still works from the address bar fragment */
  }
}
export function recalledGuardianToken(): string | null {
  try {
    return sessionStorage.getItem(GUARDIAN_TOKEN_KEY);
  } catch {
    return null;
  }
}

export interface CohortOption {
  curriculumCode: string;
  gradeCode: string;
  label: string;
}

export interface AcademicView {
  cohortOptions: CohortOption[];
  grade: CohortOption | null;
  school: { state: string; name: string; branchName: string | null; awaitingReview: boolean } | null;
}

export interface SchoolHit {
  id: string;
  name: string;
  city: string | null;
  branches: Array<{ id: string; name: string }>;
}

// ── Test designs (Step 10) ─────────────────────────────────────────────────

export type BlueprintDifficulty = 'EASY' | 'MEDIUM' | 'HARD';
export type BlueprintScopeMode = 'WHOLE_SUBJECT' | 'CHAPTERS' | 'STUDENT_FOCUS';

export interface BlueprintDesign {
  totalQuestions: number;
  difficulty: Record<BlueprintDifficulty, number>;
  types: Array<{ type: 'MCQ'; count: number }>;
  scope: { mode: BlueprintScopeMode; strict: boolean; chapters: string[] };
  cells: Array<{ chapterCode: string | null; difficulty: BlueprintDifficulty | null; cognitive: 'C1' | 'C2' | 'C3' | 'C4' | null; minCount: number }>;
  preferUnseen: boolean;
  openingDifficulty: BlueprintDifficulty | null;
  notes: string | null;
}

export interface BlueprintSubject {
  curriculumCode: string;
  gradeCode: string;
  subjectCode: string;
}

export interface BlueprintSummary {
  id: string;
  code: string;
  name: string;
  description: string | null;
  enabled: boolean;
  subject: BlueprintSubject | null;
  published: { versionId: string; version: number; totalQuestions: number; publishedAt: string | null } | null;
  draft: { versionId: string; version: number } | null;
}

export interface BlueprintDetail extends BlueprintSummary {
  versions: Array<{
    versionId: string;
    version: number;
    status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
    design: BlueprintDesign;
    createdAt: string;
    publishedAt: string | null;
    retiredAt: string | null;
    testsBuilt: number;
  }>;
}

export type BlueprintRelaxation =
  | { kind: 'DIFFICULTY_SUBSTITUTED'; wanted: BlueprintDifficulty; got: BlueprintDifficulty; count: number }
  | { kind: 'CELL_MINIMUM_UNMET'; cell: number; wanted: number; got: number }
  | { kind: 'SCOPE_WIDENED'; reason: 'NO_FOCUS_CHAPTERS' | 'TOO_FEW_IN_SCOPE'; outOfScope: number }
  | { kind: 'SEEN_QUESTIONS_USED'; count: number }
  | { kind: 'HEALTH_WATCH_USED'; count: number };

export interface BlueprintPreviewHead {
  blueprint: string;
  version: number;
  status: 'DRAFT' | 'PUBLISHED' | 'RETIRED';
  unitId: string;
  seed: string;
  note: string | null;
}

export type BlueprintPreview =
  | (BlueprintPreviewHead & {
      ok: true;
      report: {
        requested: Record<BlueprintDifficulty, number>;
        delivered: Record<BlueprintDifficulty, number>;
        relaxations: BlueprintRelaxation[];
        chapters: number;
        objectives: number;
        cognitive: Record<'C1' | 'C2' | 'C3' | 'C4' | 'UNTAGGED', number>;
        pool: { offered: number; duplicates: number; wrongType: number; outOfScope: number; eligible: number };
      };
      items: Array<{
        position: number;
        code: string;
        stem: string;
        chapter: string;
        objectivePath: string;
        difficulty: BlueprintDifficulty;
        cognitive: string | null;
        health: string;
        requirement: 'CELL' | 'DIFFICULTY' | 'SUBSTITUTE';
        reasons: string[];
        candidates: number;
      }>;
    })
  | (BlueprintPreviewHead & { ok: false; available: number; needed: number });

// ── Removing a wrong question from tests already taken (Step 11) ─────────────

export interface InvalidationImpact {
  revisionId: string;
  code: string;
  state: string;
  items: number;
  inProgress: number;
  submitted: number;
  other: number;
  blockers: string[];
  already: { invalidationId: string; at: string; reasonCode: string; note: string } | null;
}

export interface InvalidationSummary {
  invalidationId: string;
  revisionId: string;
  itemsAffected: number;
  resultsRescored: number;
  sessionsInvalidated: number;
  repeated: boolean;
}

// ── Home (Step 12) ───────────────────────────────────────────────────────

export type NextAction =
  | { kind: 'RESUME'; assessmentId: string; subjectName: string; mode: 'TEST' | 'PRACTICE'; reason: string }
  | { kind: 'FINISH_PROFILE'; reason: string }
  | { kind: 'COMING_SOON'; reason: string }
  | { kind: 'NOT_READY'; reason: string }
  | { kind: 'FIRST_TEST' | 'TAKE_TEST'; subjectVersionId: string; subjectName: string; blueprint: string; mode: 'TEST'; reason: string };

export interface HomeSubject {
  subjectVersionId: string;
  subjectCode: string;
  subjectName: string;
  ready: boolean;
  chosenChapters: number;
  tests: Array<{ code: string; name: string; total: number; ready: boolean }>;
  lastResult: { assessmentId: string; correct: number; total: number; mode: 'TEST' | 'PRACTICE'; at: string } | null;
  completed: number;
}

export interface HomeView {
  displayName: string | null;
  cohort: { curriculumCode: string; gradeCode: string } | null;
  supported: boolean;
  nextAction: NextAction;
  firstExperience: boolean;
  firstExperienceMessage: string;
  subjects: HomeSubject[];
  inProgress: MyAssessment[];
}

/** "GRADE_8" -> "Grade 8". */
export function gradeLabel(code: string): string {
  return code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}
