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
