
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
  // Guardian approval. The invitation token travels in the request body, never in the path.
  { method: 'GET', path: 'guardian/status' },
  { method: 'POST', path: 'guardian/invitations' },
  { method: 'POST', path: 'guardian/invitations/cancel' },
  { method: 'POST', path: 'guardian/invitations/preview' },
  { method: 'POST', path: 'guardian/invitations/accept' },
  { method: 'POST', path: 'guardian/invitations/decline' },
  { method: 'GET', path: 'guardian/approvals' },
  // School and grade selection (Block 005).
  { method: 'GET', path: 'students/me/academic' },
  { method: 'PUT', path: 'students/me/grade' },
  { method: 'POST', path: 'students/me/schools/search' },
  { method: 'PUT', path: 'students/me/school' },
  { method: 'POST', path: 'students/me/school/leave' },
  // Chapter focus and school-plan suggestion (Step 5).
  { method: 'GET', path: 'students/me/chapters' },
  { method: 'PUT', path: 'students/me/chapters' },
  // Home (Step 12).
  { method: 'GET', path: 'home' },
  // Mastery (Step 13): the student's own, labels only.
  { method: 'GET', path: 'mastery' },
  // Recommendations (Step 14): the student's own.
  { method: 'GET', path: 'recommendations' },
  // Competition (Step 15): this week's boards and the student's own visibility.
  { method: 'GET', path: 'compete' },
  { method: 'PUT', path: 'compete/visibility' },
  // Friends and challenges (Step 16): 404 from the API while switched off.
  { method: 'GET', path: 'social' },
  { method: 'POST', path: 'social/code' },
  { method: 'POST', path: 'social/friends' },
  { method: 'POST', path: 'social/challenges' },
  { method: 'GET', path: 'guardian/friendships' },
  { method: 'GET', path: 'admin/safety/reports' },
  // Parent view and sharing (Step 17). Invitation tokens travel in the request body, never in the path.
  { method: 'GET', path: 'parent/children' },
  { method: 'POST', path: 'parent/invitations/preview' },
  { method: 'POST', path: 'parent/invitations/accept' },
  { method: 'POST', path: 'parent/invitations/decline' },
  { method: 'GET', path: 'parent-sharing' },
  { method: 'POST', path: 'parent-sharing/invitations' },
  { method: 'POST', path: 'parent-sharing/invitations/cancel' },
  { method: 'GET', path: 'parent-sharing/preview' },
  // Plans (Step 18): the student's own; and administration (SUPER_ADMIN, enforced by the API).
  { method: 'GET', path: 'entitlements' },
  { method: 'POST', path: 'admin/entitlements/lookup' },
  // Analytics (Step 19): the student's own choice and UI events; a guardian's choices; administrators' totals.
  { method: 'GET', path: 'analytics/consent' },
  { method: 'PUT', path: 'analytics/consent' },
  { method: 'POST', path: 'analytics/events' },
  { method: 'GET', path: 'guardian/analytics-consent' },
  { method: 'GET', path: 'admin/analytics/metrics' },
  { method: 'GET', path: 'admin/analytics/experiments' },
];

/** Admin curriculum routes carry a unit id, so they are matched by an exact pattern, never a prefix. */
const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const ALLOWED_PATTERNS: ReadonlyArray<{ method: string; pattern: RegExp }> = [
  { method: 'GET', pattern: /^admin\/curriculum\/units$/ },
  { method: 'POST', pattern: new RegExp(`^admin/curriculum/units/${UUID}/content/preview$`) },
  { method: 'PUT', pattern: new RegExp(`^admin/curriculum/units/${UUID}/content$`) },
  { method: 'POST', pattern: new RegExp(`^admin/curriculum/units/${UUID}/submit$`) },
  { method: 'GET', pattern: /^admin\/questions\/units$/ },
  { method: 'GET', pattern: new RegExp(`^admin/questions/units/${UUID}/questions$`) },
  { method: 'POST', pattern: new RegExp(`^admin/questions/units/${UUID}/preview$`) },
  { method: 'PUT', pattern: new RegExp(`^admin/questions/units/${UUID}/questions$`) },
  { method: 'GET', pattern: new RegExp(`^admin/questions/revisions/${UUID}$`) },
  { method: 'POST', pattern: new RegExp(`^admin/questions/revisions/${UUID}/(submit|approve|request-changes|retire|quarantine|restore)$`) },
  { method: 'GET', pattern: new RegExp(`^admin/publication/units/${UUID}/summary$`) },
  { method: 'POST', pattern: new RegExp(`^admin/publication/units/${UUID}/publish-all$`) },
  { method: 'POST', pattern: new RegExp(`^admin/publication/revisions/${UUID}/(publish|withdraw|health)$`) },
  // Removing a wrong question from tests already taken (Step 11).
  { method: 'GET', pattern: new RegExp(`^admin/assessment-items/revisions/${UUID}/impact$`) },
  { method: 'POST', pattern: new RegExp(`^admin/assessment-items/revisions/${UUID}/invalidate$`) },
  // Test designs (Step 10).
  { method: 'GET', pattern: /^admin\/blueprints$/ },
  { method: 'POST', pattern: /^admin\/blueprints$/ },
  { method: 'GET', pattern: new RegExp(`^admin/blueprints/${UUID}$`) },
  { method: 'PUT', pattern: new RegExp(`^admin/blueprints/${UUID}/draft$`) },
  { method: 'POST', pattern: new RegExp(`^admin/blueprints/${UUID}/(draft/discard|draft/publish|enabled)$`) },
  { method: 'POST', pattern: new RegExp(`^admin/blueprints/versions/${UUID}/preview$`) },
  // Student tests. Ids are matched as UUIDs and the question position as one or two digits.
  { method: 'GET', pattern: /^exam\/units$/ },
  { method: 'GET', pattern: /^exam\/assessments$/ },
  { method: 'POST', pattern: /^exam\/assessments$/ },
  { method: 'POST', pattern: new RegExp(`^exam/assessments/${UUID}/(present|review-skipped|submit)$`) },
  { method: 'POST', pattern: new RegExp(`^exam/assessments/${UUID}/questions/\\d{1,2}/(lock|skip)$`) },
  { method: 'GET', pattern: new RegExp(`^exam/assessments/${UUID}/result$`) },
  { method: 'POST', pattern: new RegExp(`^guardian/approvals/${UUID}/withdraw$`) },
  // Practice and retest (Step 14).
  { method: 'POST', pattern: new RegExp(`^recommendations/${UUID}/(start|dismiss)$`) },
  { method: 'POST', pattern: new RegExp(`^recommendations/from-result/${UUID}$`) },
  // Friends and challenges (Step 16).
  { method: 'POST', pattern: new RegExp(`^social/friends/${UUID}/(unfriend|block|report)$`) },
  { method: 'POST', pattern: new RegExp(`^social/challenges/${UUID}/(accept|decline|start|report)$`) },
  { method: 'POST', pattern: new RegExp(`^guardian/friendships/${UUID}/(approve|decline)$`) },
  { method: 'POST', pattern: new RegExp(`^admin/safety/reports/${UUID}/resolve$`) },
  // Parent view and sharing (Step 17).
  { method: 'GET', pattern: new RegExp(`^parent/children/${UUID}$`) },
  { method: 'GET', pattern: new RegExp(`^parent/children/${UUID}/reports/${UUID}$`) },
  { method: 'POST', pattern: new RegExp(`^parent/children/${UUID}/leave$`) },
  { method: 'POST', pattern: new RegExp(`^parent-sharing/viewers/${UUID}/stop$`) },
  { method: 'GET', pattern: new RegExp(`^parent-sharing/preview/reports/${UUID}$`) },
  // Plans administration (Step 18).
  { method: 'GET', pattern: new RegExp(`^admin/entitlements/students/${UUID}$`) },
  { method: 'POST', pattern: new RegExp(`^admin/entitlements/students/${UUID}/(subscriptions|grants)$`) },
  { method: 'POST', pattern: new RegExp(`^admin/entitlements/(subscriptions|grants)/${UUID}/(end|revoke)$`) },
  // Analytics (Step 19).
  { method: 'PUT', pattern: new RegExp(`^guardian/analytics-consent/${UUID}$`) },
];

export function isAllowed(method: string, path: string): boolean {
  return (
    ALLOWED.some((a) => a.method === method && a.path === path) ||
    ALLOWED_PATTERNS.some((a) => a.method === method && a.pattern.test(path))
  );
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
