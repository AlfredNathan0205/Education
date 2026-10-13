
export const SESSION_COOKIE = 'exam_session';
export const API_URL = process.env.API_URL ?? 'http://localhost:3001';

/** Only these API routes may be reached through the browser-facing proxy. */
const ALLOWED: ReadonlyArray<{ method: string; path: string }> = [
  { method: 'POST', path: 'identity/otp/request' },
  { method: 'POST', path: 'identity/otp/verify' },
  { method: 'POST', path: 'students/me' },
  { method: 'GET', path: 'students/me' },
  { method: 'PUT', path: 'students/me/date-of-birth' },
  { method: 'PUT', path: 'students/me/display-name' },
  { method: 'GET', path: 'students/me/academic' },
  { method: 'PUT', path: 'students/me/grade' },
  { method: 'POST', path: 'students/me/schools/search' },
  { method: 'PUT', path: 'students/me/school' },
  { method: 'POST', path: 'students/me/school/leave' },
];

export function isAllowed(method: string, path: string): boolean {
  return ALLOWED.some((a) => a.method === method && a.path === path);
}

export async function callApi(
  method: string,
  path: string,
  token: string | null,
  body?: unknown,
): Promise<Response> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return fetch(`${API_URL}/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
}
