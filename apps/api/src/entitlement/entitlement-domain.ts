/**
 * Pure rules for plans and entitlements (Step 18; spec DOMAIN_MAP 17 "Entitlements & Subscription"; DECISION_09: free
 * complete core loop, paid depth/frequency/insight, never academic or competitive advantage).
 *
 * Entitlements control ACCESS only. They are never read by mastery, claims, competition or privacy: a plan cannot
 * change a score, a label, CP, or who may see a student's data (INVARIANTS: payment never creates privacy authority).
 */

export type EntitlementKey = 'SELF_TESTS_PER_DAY' | 'LONG_TESTS' | 'PARENT_REPORT_WEEKS';
export const ENTITLEMENT_KEYS: EntitlementKey[] = ['SELF_TESTS_PER_DAY', 'LONG_TESTS', 'PARENT_REPORT_WEEKS'];

/** LIMIT: a whole number, or null for unlimited. BOOLEAN: true or false. */
export const ENTITLEMENT_KIND: Record<EntitlementKey, 'LIMIT' | 'BOOLEAN'> = {
  SELF_TESTS_PER_DAY: 'LIMIT',
  LONG_TESTS: 'BOOLEAN',
  PARENT_REPORT_WEEKS: 'LIMIT',
};

export type EntitlementValues = { SELF_TESTS_PER_DAY: number | null; LONG_TESTS: boolean; PARENT_REPORT_WEEKS: number | null };

/** PROVISIONAL free limits (seeded as plan FREE by the Step 18 migration; a unit test checks they match). */
export const FREE_VALUES: EntitlementValues = { SELF_TESTS_PER_DAY: 3, LONG_TESTS: false, PARENT_REPORT_WEEKS: 4 };
export const UNLIMITED_VALUES: EntitlementValues = { SELF_TESTS_PER_DAY: null, LONG_TESTS: true, PARENT_REPORT_WEEKS: null };

/** A test with at least this many questions is a "long" test (Subject 20 and 25 today). */
export const LONG_TEST_QUESTIONS = 20;
/** Days for the daily limit run midnight to midnight in this offset (India time, as the weekly boards). */
export const DAY_UTC_OFFSET_MINUTES = 330;

export function parseValues(raw: unknown): EntitlementValues {
  const v = raw as Record<string, unknown>;
  const limit = (x: unknown) => x === null || (Number.isInteger(x) && (x as number) >= 0 && (x as number) <= 1000);
  if (!v || typeof v !== 'object' || !limit(v.SELF_TESTS_PER_DAY) || typeof v.LONG_TESTS !== 'boolean' || !limit(v.PARENT_REPORT_WEEKS)) {
    throw new Error('plan values are not valid');
  }
  if (Object.keys(v).some((k) => !(ENTITLEMENT_KEYS as string[]).includes(k))) throw new Error('plan values name an unknown entitlement');
  return v as unknown as EntitlementValues;
}

/** The value of one key from a grant (same rules as a plan's value for that key). */
export function parseGrantValue(key: EntitlementKey, raw: unknown): number | null | boolean {
  if (ENTITLEMENT_KIND[key] === 'BOOLEAN') {
    if (typeof raw !== 'boolean') throw new Error(`${key} takes true or false`);
    return raw;
  }
  if (raw === null || (Number.isInteger(raw) && (raw as number) >= 0 && (raw as number) <= 1000)) return raw as number | null;
  throw new Error(`${key} takes a whole number or null (unlimited)`);
}

/** The most generous of several values: null (unlimited) beats any number; true beats false. */
export function mostGenerous(values: EntitlementValues[]): EntitlementValues {
  const out: EntitlementValues = { ...values[0] };
  for (const v of values.slice(1)) {
    out.SELF_TESTS_PER_DAY = maxLimit(out.SELF_TESTS_PER_DAY, v.SELF_TESTS_PER_DAY);
    out.PARENT_REPORT_WEEKS = maxLimit(out.PARENT_REPORT_WEEKS, v.PARENT_REPORT_WEEKS);
    out.LONG_TESTS = out.LONG_TESTS || v.LONG_TESTS;
  }
  return out;
}
function maxLimit(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.max(a, b);
}

/** Applies single-key grants on top (a grant only ever widens, like a plan). */
export function withGrants(base: EntitlementValues, grants: Array<{ key: EntitlementKey; value: number | null | boolean }>): EntitlementValues {
  let out = { ...base };
  for (const g of grants) out = mostGenerous([out, { ...out, [g.key]: g.value } as EntitlementValues]);
  return out;
}

export function activeAt(row: { status: string; startsAt: Date; endsAt: Date | null }, now: Date): boolean {
  return row.status === 'ACTIVE' && row.startsAt <= now && (row.endsAt === null || row.endsAt > now);
}

/** Midnight-to-midnight day (in the offset) containing `at`. */
export function dayOf(at: Date, utcOffsetMinutes = DAY_UTC_OFFSET_MINUTES): { start: Date; end: Date } {
  const off = utcOffsetMinutes * 60_000;
  const local = new Date(at.getTime() + off);
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  return { start: new Date(startLocal - off), end: new Date(startLocal - off + 86_400_000) };
}

export type StartRefusal = 'LONG_TESTS' | 'DAILY_LIMIT';

/** Whether a student may START a test or practice set they chose themselves (recommended practice, retests and challenges are never limited). */
export function startRefusal(v: EntitlementValues, input: { totalQuestions: number; startedToday: number }): StartRefusal | null {
  if (input.totalQuestions >= LONG_TEST_QUESTIONS && !v.LONG_TESTS) return 'LONG_TESTS';
  if (v.SELF_TESTS_PER_DAY !== null && input.startedToday >= v.SELF_TESTS_PER_DAY) return 'DAILY_LIMIT';
  return null;
}

export const REFUSAL_TEXT: Record<StartRefusal, string> = {
  LONG_TESTS: 'Longer tests are not included in your plan.',
  DAILY_LIMIT: "You've started all the tests your plan includes today. Your recommended practice and retests are still open, and you can start more tests tomorrow.",
};

/** Report history a parent may open: the latest N weeks (null = all). */
export function reportsWithin<T extends { weekStart: Date }>(reports: T[], weeks: number | null): T[] {
  if (weeks === null) return reports;
  return [...reports].sort((a, b) => b.weekStart.getTime() - a.weekStart.getTime()).slice(0, weeks);
}

export function parseBetaUntil(raw: string | undefined, now: Date): Date | null {
  const s = raw?.trim();
  if (!s) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error('BETA_GRANT_UNTIL must be a date like 2027-03-31');
  // The grant runs to the END of that day, India time.
  const end = dayOf(new Date(`${s}T12:00:00Z`)).end;
  if (Number.isNaN(end.getTime())) throw new Error('BETA_GRANT_UNTIL must be a date like 2027-03-31');
  return end > now ? end : null;
}
