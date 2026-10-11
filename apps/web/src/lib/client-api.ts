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
