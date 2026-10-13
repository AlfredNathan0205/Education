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
  state: 'DRAFT' | 'IN_REVIEW' | 'CHANGES_REQUIRED' | 'APPROVED' | 'RETIRED' | 'SUPERSEDED';
  revision: number;
  origin: 'HUMAN' | 'AI_DRAFT';
}

export interface QuestionDetail extends QuestionRow {
  explanation: string | null;
  options: Array<{ label: string; text: string; isCorrect: boolean }>;
  reviewNote: string | null;
  answerVerified: boolean;
  aiSource: string | null;
  history: Array<{ from: string | null; to: string; actorKind: string; note: string | null; at: string }>;
}

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
  subjectName: string;
  usableQuestions: number;
  ready: boolean;
}

export interface MyAssessment {
  assessmentId: string;
  mode: 'TEST' | 'PRACTICE';
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'VOID';
  subjectName: string;
  gradeCode: string;
  startedAt: string;
  expiresAt: string;
  correct: number | null;
  total: number | null;
}

export interface ExamView {
  assessmentId: string;
  mode: 'TEST' | 'PRACTICE';
  status: 'IN_PROGRESS' | 'SUBMITTED' | 'VOID';
  expiresAt: string;
  total: number;
  answered: number;
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
  byDifficulty: Record<'EASY' | 'MEDIUM' | 'HARD', { total: number; correct: number }>;
  competitiveEligible: boolean;
  items: Array<{
    position: number;
    difficulty: 'EASY' | 'MEDIUM' | 'HARD';
    stem: string;
    outcome: 'CORRECT' | 'INCORRECT' | 'UNANSWERED';
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
