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
  /** Step 17: the display name, else the student's own sign-in address, masked. */
  label?: string;
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
export type BlueprintScopeMode = 'WHOLE_SUBJECT' | 'CHAPTERS' | 'STUDENT_FOCUS' | 'OBJECTIVES';

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
  | { kind: 'FIRST_TEST' | 'TAKE_TEST'; subjectVersionId: string; subjectName: string; blueprint: string; mode: 'TEST'; reason: string }
  | { kind: 'RETEST' | 'PRACTICE'; recommendationId: string; subjectName: string; objectives: number; reason: string };

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
  /** Step 14: open practice and retest recommendations ("Focus next"). */
  focus: RecommendationView[];
}

// ── Competition (Step 15) ────────────────────────────────────────────────

export interface CompeteBoard {
  scope: 'COHORT' | 'SUBJECT';
  title: string;
  subjectCode: string | null;
  entries: Array<{ rank: number; handle: string; cp: number; you: boolean }>;
  rankedCount: number;
  you: { cp: number; qualified: number; eligibleQuestions: number; rank: number | null; needs: { tests: number; questions: number } };
}

export interface CompeteView {
  policy: string;
  week: { start: string; end: string };
  handle: string;
  shownToOthers: boolean;
  canChangeVisibility: boolean;
  xp: { week: number; total: number };
  boards: CompeteBoard[];
  pending: number;
}

// ── Friends and challenges (Step 16; off unless switched on) ─────────────

export type ReportReason = 'UNWANTED_CONTACT' | 'CHALLENGE_SPAM' | 'SUSPECTED_CHEATING' | 'MADE_ME_UNCOMFORTABLE' | 'OTHER';
export const REPORT_REASON_TEXT: Record<ReportReason, string> = {
  UNWANTED_CONTACT: 'Unwanted contact',
  CHALLENGE_SPAM: 'Too many challenges',
  SUSPECTED_CHEATING: 'I think they cheated',
  MADE_ME_UNCOMFORTABLE: 'They made me uncomfortable',
  OTHER: 'Something else',
};

export interface SocialFriend {
  friendshipId: string;
  handle: string;
  status: 'PENDING_GUARDIAN' | 'ACTIVE';
  waitingFor: Array<'YOUR_GUARDIAN' | 'THEIR_GUARDIAN'>;
}

export interface SocialChallenge {
  id: string;
  role: 'CHALLENGER' | 'OPPONENT';
  status: 'PENDING' | 'ACTIVE' | 'DECLINED' | 'EXPIRED' | 'COMPLETED' | 'CANCELLED';
  subjectName: string;
  opponentHandle: string;
  expiresAt: string;
  myAssessmentId: string | null;
  myState: 'NOT_STARTED' | 'IN_PROGRESS' | 'FINISHED';
  result: { mine: { correct: number; total: number }; theirs: { correct: number; total: number }; outcome: 'WIN' | 'LOSS' | 'DRAW' } | null;
}

export interface SocialView {
  enabled: boolean;
  restricted?: boolean;
  handle?: string;
  code?: { code: string; expiresAt: string } | null;
  friends?: SocialFriend[];
  challenges?: SocialChallenge[];
  subjects?: Array<{ subjectVersionId: string; subjectName: string }>;
}

// ── Recommendations (Step 14) ────────────────────────────────────────────

export type RecommendationReason = 'NEEDS_ATTENTION' | 'DEVELOPING' | 'MISSED_MORE_THAN_RIGHT' | 'MISSED_IN_TEST' | 'PRACTISED';

/** Why an objective was chosen, in the student's terms. Factual: never "weak", never a number from the model. */
export const REASON_TEXT: Record<RecommendationReason, string> = {
  NEEDS_ATTENTION: 'Marked Needs attention in your progress',
  DEVELOPING: 'Still developing',
  MISSED_MORE_THAN_RIGHT: 'You have missed more of these than you got right so far',
  MISSED_IN_TEST: 'You missed these in a test',
  PRACTISED: 'You practised these',
};

export interface RecommendationView {
  id: string;
  kind: 'PRACTICE' | 'RETEST';
  status: 'OPEN' | 'STARTED';
  source: 'MASTERY' | 'RESULT' | 'PRACTICE_DONE';
  subjectVersionId: string;
  subjectCode: string;
  subjectName: string;
  objectives: Array<{ path: string; statement: string; chapterTitle: string }>;
  reasons: Array<{ path: string; code: RecommendationReason; missed?: number }>;
  inProgressAssessmentId: string | null;
  createdAt: string;
}

/** "GRADE_8" -> "Grade 8". */
export function gradeLabel(code: string): string {
  return code.replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
}

// ── Mastery (Step 13) ────────────────────────────────────────────────────

export type MasteryLabel = 'NOT_STARTED' | 'BUILDING_EVIDENCE' | 'NEEDS_ATTENTION' | 'DEVELOPING' | 'SECURE' | 'STRONG';

export const MASTERY_LABEL: Record<MasteryLabel, string> = {
  NOT_STARTED: 'Not started',
  BUILDING_EVIDENCE: 'Building evidence',
  NEEDS_ATTENTION: 'Needs attention',
  DEVELOPING: 'Developing',
  SECURE: 'Secure',
  STRONG: 'Strong',
};

export interface MasteryView {
  policy: string;
  pending: number;
  subjects: Array<{
    subjectVersionId: string;
    subjectCode: string;
    subjectName: string;
    objectives: number;
    started: number;
    reportable: number;
    chapters: Array<{
      code: string;
      title: string;
      label: MasteryLabel;
      objectives: number;
      started: number;
      reportable: number;
      items: Array<{ path: string; code: string; statement: string; label: MasteryLabel; answers: number }>;
    }>;
  }>;
}

// ── Step 17: parent view and sharing ─────────────────────────────────────────

export type ViewBasis = 'GUARDIAN' | 'STUDENT_SHARE' | 'SELF_PREVIEW';

export interface ParentChild {
  studentId: string;
  label: string;
  basis: 'GUARDIAN' | 'STUDENT_SHARE';
}

export interface ParentClaim {
  kind: 'STRENGTH' | 'FOCUS' | 'IMPROVEMENT';
  subjectName: string;
  chapterTitle: string;
  statement: string;
  label: MasteryLabel;
  fromLabel: MasteryLabel | null;
  text: string;
}

export interface ParentSubjectPicture {
  subjectName: string;
  objectives: number;
  reportable: number;
  counts: Record<MasteryLabel, number>;
  chapters: Array<{ title: string; label: MasteryLabel }>;
}

export interface ParentSummaryContent {
  period: { start: string; end: string };
  activity: { tests: number; practice: number; questionsAnswered: number; activeDays: number };
  subjects: ParentSubjectPicture[];
  strengths: ParentClaim[];
  focus: ParentClaim[];
  improvements: ParentClaim[];
  claimPolicy: string;
}

export interface ParentDashboard extends ParentSummaryContent {
  child: { studentId: string; label: string };
  basis: ViewBasis;
  pending: boolean;
  lastActiveAt: string | null;
  reports: Array<{ id: string; weekStart: string; weekEnd: string; version: number }>;
}

export interface ParentReport extends ParentSummaryContent {
  id: string;
  version: number;
  reason: 'WEEK_ENDED' | 'EVIDENCE_CHANGED';
  generatedAt: string;
}

export interface SharingStatus {
  canShare: boolean;
  refusal: string | null;
  isMinor: boolean;
  guardianViewers: number;
  viewers: Array<{ grantId: string; maskedEmail: string; since: string }>;
  pending: { maskedEmail: string; expiresAt: string } | null;
  consent: { version: number; title: string; paragraphs: string[]; draft: boolean } | null;
}

export const SHARE_TOKEN_KEY = 'parent_share_token';

/** The sharing link's token lives only in this tab's sessionStorage (never in a URL or cookie). */
export function rememberShareToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(SHARE_TOKEN_KEY, token);
    else sessionStorage.removeItem(SHARE_TOKEN_KEY);
  } catch {
    /* storage unavailable: the link still works from the address bar fragment */
  }
}
export function recalledShareToken(): string | null {
  try {
    return sessionStorage.getItem(SHARE_TOKEN_KEY);
  } catch {
    return null;
  }
}

// ── Step 18: plans and entitlements ─────────────────────────────────────────

export interface EntitlementValues {
  SELF_TESTS_PER_DAY: number | null;
  LONG_TESTS: boolean;
  PARENT_REPORT_WEEKS: number | null;
}

export interface MyPlan {
  planName: string;
  sources: Array<{ planName: string; source: string; endsAt: string | null }>;
  values: EntitlementValues;
  startedToday: number;
  leftToday: number | null;
}

export interface StaffPlanView {
  studentId: string;
  label: string;
  effective: EntitlementValues;
  subscriptions: Array<{ id: string; planCode: string; source: string; status: string; startsAt: string; endsAt: string | null; holder: string | null; events: Array<{ type: string; at: string; reason: string | null }> }>;
  grants: Array<{ id: string; key: string; value: unknown; endsAt: string; reason: string; revoked: boolean }>;
  plans: Array<{ code: string; name: string; isDefault: boolean }>;
}

/** Tests of this many questions or more are "long" (mirrors the API's LONG_TEST_QUESTIONS). */
export const LONG_TEST_QUESTIONS = 20;

// ── Step 19: analytics (consented, pseudonymous) ─────────────────────────────

export type ClientAnalyticsEvent = 'RESULTS_OPENED' | 'PRACTISE_MISSED_CLICKED' | 'PROGRESS_OPENED' | 'PARENT_PREVIEW_OPENED' | 'COMPETE_OPENED';

/**
 * Sends one UI event. Fire and forget: never awaited, never shown, never retried. The API keeps it only if the student's
 * analytics consent is valid, and the response is the same either way. No page views, no timings.
 */
export function track(name: ClientAnalyticsEvent): void {
  void fetch('/api/bff/analytics/events', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) }).catch(() => undefined);
}

export interface ConsentWording {
  version: number;
  title: string;
  paragraphs: string[];
  draft: boolean;
}

export interface MyAnalyticsConsent {
  decidedBy: 'SELF' | 'GUARDIAN';
  granted: boolean;
  consent: ConsentWording | null;
}

export interface GuardianAnalyticsConsents {
  children: Array<{ studentId: string; label: string; granted: boolean }>;
  consent: ConsentWording | null;
}

type MetricValue = number | '<5' | null;
export interface AdminMetrics {
  generatedAt: string;
  coverage: { consenting: MetricValue; students: MetricValue };
  weeks: Array<{
    weekStart: string;
    northStar: MetricValue;
    intensity: number | null;
    activeLearners: MetricValue;
    started: MetricValue;
    completed: MetricValue;
    completionRate: number | null;
    signups: MetricValue;
    activated: MetricValue;
    loop: { resultsOpened: MetricValue; practiseMissed: MetricValue; practiceFromRecommendation: MetricValue; retestsCompleted: MetricValue };
    improvedObjectives: MetricValue;
    parentViews: MetricValue;
    studentsWithParentViews: MetricValue;
  }>;
  returns: { d7: { eligible: MetricValue; returned: MetricValue; rate: number | null }; d30: { eligible: MetricValue; returned: MetricValue; rate: number | null } };
}
