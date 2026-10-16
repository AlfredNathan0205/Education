import { createHash, createHmac } from 'node:crypto';

/**
 * Pure rules for analytics (Step 19; spec ANALYTICS_QA_RELEASE: North Star = weekly active learners completing a
 * qualified assessment; track activation, completion, weekly frequency, D7/D30 return, review -> practice -> retest,
 * improvement, parent engagement, competition. Do NOT optimise for screen time. DOMAIN_MAP 19: downstream, pseudonymous).
 *
 * PM decisions (15 October): server events plus a few client events; an internal admin page only; a SEPARATE consent
 * purpose (PRODUCT_ANALYTICS), so a student is counted only while that consent is valid (a minor's guardian decides);
 * an experiments foundation with nothing using it yet.
 */

export const ANALYTICS_PURPOSE = 'PRODUCT_ANALYTICS';

/** Every analytics event name. Nothing else can be recorded. No page views, no durations, no screen time. */
export const SERVER_EVENTS = [
  'SIGNED_UP',
  'ASSESSMENT_STARTED',
  'ASSESSMENT_COMPLETED',
  'QUALIFIED_TEST',
  'RECOMMENDATION_STARTED',
  'RECOMMENDATION_COMPLETED',
  'MASTERY_UPDATED',
  'PARENT_VIEWED',
  'PARENT_SHARING_STARTED',
] as const;
export const CLIENT_EVENTS = ['RESULTS_OPENED', 'PRACTISE_MISSED_CLICKED', 'PROGRESS_OPENED', 'PARENT_PREVIEW_OPENED', 'COMPETE_OPENED'] as const;
export type ServerEvent = (typeof SERVER_EVENTS)[number];
export type ClientEvent = (typeof CLIENT_EVENTS)[number];
export type AnalyticsEventName = ServerEvent | ClientEvent;

export function isClientEvent(x: unknown): x is ClientEvent {
  return typeof x === 'string' && (CLIENT_EVENTS as readonly string[]).includes(x);
}

/** At most this many client events per student per day are kept (protects the store from a misbehaving client). */
export const MAX_CLIENT_EVENTS_PER_DAY = 200;

/** Props allowed per event: booleans, small whole numbers and codes from fixed lists. Anything else is dropped. */
const PROPS: Partial<Record<AnalyticsEventName, Record<string, (v: unknown) => boolean>>> = {
  ASSESSMENT_STARTED: { mode: isMode, blueprint: isCode, fromRecommendation: isBool },
  ASSESSMENT_COMPLETED: { mode: isMode, reason: isCode },
  QUALIFIED_TEST: {},
  RECOMMENDATION_STARTED: { kind: isCode },
  RECOMMENDATION_COMPLETED: { kind: isCode },
  MASTERY_UPDATED: { improvedObjectives: isSmallInt },
  PARENT_VIEWED: { basis: isCode },
};
function isMode(v: unknown) {
  return v === 'TEST' || v === 'PRACTICE';
}
function isCode(v: unknown) {
  return typeof v === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(v);
}
function isBool(v: unknown) {
  return typeof v === 'boolean';
}
function isSmallInt(v: unknown) {
  return Number.isInteger(v) && (v as number) >= 0 && (v as number) <= 1000;
}

export function cleanProps(name: AnalyticsEventName, props: Record<string, unknown> | undefined): Record<string, unknown> | null {
  const allowed = PROPS[name];
  if (!allowed || !props) return null;
  const out: Record<string, unknown> = {};
  for (const [k, check] of Object.entries(allowed)) if (k in props && check(props[k])) out[k] = props[k];
  return Object.keys(out).length ? out : null;
}

/** The pseudonym: HMAC-SHA256 of the student id under a secret key, 32 hex characters. */
export function subjectKey(studentId: string, secret: string): string {
  return createHmac('sha256', secret).update(`student:${studentId}`).digest('hex').slice(0, 32);
}

/**
 * The de-duplication key of a row, keyed under the same secret. The raw reference (an outbox event id, or a student id
 * for SIGNED_UP) must never be stored: an outbox id joins back to outbox_event, whose payload names the student.
 */
export function sourceRefKey(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(`ref:${raw}`).digest('hex').slice(0, 40);
}

export function analyticsSecret(env: Record<string, string | undefined> = process.env): string {
  const s = env.ANALYTICS_PSEUDONYM_KEY?.trim() ?? '';
  if (s.length >= 32) return s;
  if (env.NODE_ENV === 'production') throw new Error('ANALYTICS_PSEUDONYM_KEY must be set (at least 32 characters) in production');
  return 'development-only-analytics-pseudonym-key-000';
}

export function analyticsEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.ANALYTICS_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('ANALYTICS_ENABLED must be "true" or "false"');
}

/** An outbox event mapped to an analytics event, or null if analytics does not use it. */
export interface Projected {
  studentId: string;
  name: ServerEvent;
  props: Record<string, unknown> | null;
}

/**
 * 'FORGET': analytics consent was withdrawn, delete the student's rows. 'CONSENTED': analytics consent was granted,
 * record SIGNED_UP at the student's creation time (sign-up itself happens before anyone can consent).
 */
export function project(eventType: string, payload: any): Projected | 'FORGET' | 'CONSENTED' | null {
  const p = payload ?? {};
  switch (eventType) {
    case 'privacy.consent.granted.v1':
      return p.purposeCode === ANALYTICS_PURPOSE ? 'CONSENTED' : null;
    case 'assessment.started.v1':
      return { studentId: p.studentId, name: 'ASSESSMENT_STARTED', props: cleanProps('ASSESSMENT_STARTED', { mode: p.mode, blueprint: p.blueprint, fromRecommendation: !!p.recommendationId }) };
    case 'assessment.submitted.v1':
      return { studentId: p.studentId, name: 'ASSESSMENT_COMPLETED', props: cleanProps('ASSESSMENT_COMPLETED', { mode: p.mode, reason: p.reason }) };
    case 'competition.cp_recorded.v1':
      // The first AWARD for a test is the moment it qualified; corrections are not new qualified tests.
      return p.kind === 'AWARD' ? { studentId: p.studentId, name: 'QUALIFIED_TEST', props: null } : null;
    case 'recommendation.started.v1':
      return { studentId: p.studentId, name: 'RECOMMENDATION_STARTED', props: cleanProps('RECOMMENDATION_STARTED', { kind: p.kind }) };
    case 'recommendation.completed.v1':
      return { studentId: p.studentId, name: 'RECOMMENDATION_COMPLETED', props: cleanProps('RECOMMENDATION_COMPLETED', { kind: p.kind }) };
    case 'mastery.updated.v1':
      return { studentId: p.studentId, name: 'MASTERY_UPDATED', props: null };
    case 'parent.sharing_started.v1':
      return { studentId: p.studentId, name: 'PARENT_SHARING_STARTED', props: null };
    case 'privacy.consent.withdrawn.v1':
      return p.purposeCode === ANALYTICS_PURPOSE ? 'FORGET' : null;
    default:
      return null;
  }
}

/** An improvement in an objective's label, both ends gated (the same order as the parent claim gate). */
const RANK: Record<string, number> = { NEEDS_ATTENTION: 1, DEVELOPING: 2, SECURE: 3, STRONG: 4 };
export function improvedCount(changes: Array<{ before: string | null; after: string }>): number {
  return changes.filter((c) => c.before && RANK[c.before] && RANK[c.after] && RANK[c.after] > RANK[c.before]).length;
}

// ── metrics ───────────────────────────────────────────────────────────────────

/** Counts below this are shown as "<5" (small groups could identify someone). */
export const MIN_GROUP = 5;
export function suppress(n: number): number | '<5' {
  return n > 0 && n < MIN_GROUP ? '<5' : n;
}

export interface Ev {
  subject: string;
  name: string;
  at: Date;
  props?: Record<string, unknown> | null;
}

const DAY = 86_400_000;

export function weekStart(at: Date, utcOffsetMinutes = 330): Date {
  const off = utcOffsetMinutes * 60_000;
  const local = new Date(at.getTime() + off);
  const day = (local.getUTCDay() + 6) % 7;
  return new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day) - off);
}

export interface WeekMetrics {
  weekStart: string;
  /** North Star: learners who completed at least one qualified test that week. */
  activeQualified: number;
  /** Qualified tests per active learner (one decimal). */
  intensity: number | null;
  activeLearners: number;
  started: number;
  completed: number;
  /** Completed / started, 0..1 (two decimals), or null with no starts. */
  completionRate: number | null;
  signups: number;
  /** Of that week's sign-ups, how many completed a test within 7 days. */
  activated: number;
  loop: { resultsOpened: number; practiseMissed: number; practiceFromRecommendation: number; retestsCompleted: number };
  improvedObjectives: number;
  parentViews: number;
  studentsWithParentViews: number;
}

/** Weekly metrics over the last `weeks` weeks, oldest first. Raw counts: the caller suppresses small numbers. */
export function weekly(events: Ev[], now: Date, weeks: number): WeekMetrics[] {
  const out: WeekMetrics[] = [];
  const current = weekStart(now);
  const firstCompleted = new Map<string, Date>();
  for (const e of events) if (e.name === 'ASSESSMENT_COMPLETED' && (!firstCompleted.has(e.subject) || e.at < firstCompleted.get(e.subject)!)) firstCompleted.set(e.subject, e.at);
  for (let i = weeks - 1; i >= 0; i--) {
    const start = new Date(current.getTime() - i * 7 * DAY);
    const end = new Date(start.getTime() + 7 * DAY);
    const inWeek = events.filter((e) => e.at >= start && e.at < end);
    const by = (n: string) => inWeek.filter((e) => e.name === n);
    const qualified = by('QUALIFIED_TEST');
    const activeQualified = new Set(qualified.map((e) => e.subject)).size;
    const started = by('ASSESSMENT_STARTED').length;
    const completed = by('ASSESSMENT_COMPLETED').length;
    const signups = by('SIGNED_UP');
    const activated = signups.filter((s) => {
      const f = firstCompleted.get(s.subject);
      return !!f && f.getTime() - s.at.getTime() <= 7 * DAY && f >= s.at;
    }).length;
    out.push({
      weekStart: start.toISOString(),
      activeQualified,
      intensity: activeQualified ? Math.round((qualified.length / activeQualified) * 10) / 10 : null,
      activeLearners: new Set(by('ASSESSMENT_COMPLETED').map((e) => e.subject)).size,
      started,
      completed,
      completionRate: started ? Math.round((completed / started) * 100) / 100 : null,
      signups: signups.length,
      activated,
      loop: {
        resultsOpened: by('RESULTS_OPENED').length,
        practiseMissed: by('PRACTISE_MISSED_CLICKED').length,
        practiceFromRecommendation: by('ASSESSMENT_STARTED').filter((e) => e.props?.fromRecommendation === true && e.props?.mode === 'PRACTICE').length,
        retestsCompleted: by('RECOMMENDATION_COMPLETED').filter((e) => e.props?.kind === 'RETEST').length,
      },
      improvedObjectives: by('MASTERY_UPDATED').reduce((a, e) => a + (Number(e.props?.improvedObjectives) || 0), 0),
      parentViews: by('PARENT_VIEWED').length,
      studentsWithParentViews: new Set(by('PARENT_VIEWED').map((e) => e.subject)).size,
    });
  }
  return out;
}

/** D7 and D30 return: of learners whose first completed test was in the window, how many completed another 7-13 / 30-36 days later. */
export function returnRates(events: Ev[], now: Date): { d7: { eligible: number; returned: number }; d30: { eligible: number; returned: number } } {
  const bySubject = new Map<string, Date[]>();
  for (const e of events) if (e.name === 'ASSESSMENT_COMPLETED') (bySubject.get(e.subject) ?? bySubject.set(e.subject, []).get(e.subject)!).push(e.at);
  const rate = (from: number, to: number) => {
    let eligible = 0;
    let returned = 0;
    for (const ats of bySubject.values()) {
      const first = ats.reduce((a, b) => (b < a ? b : a));
      if (now.getTime() - first.getTime() < to * DAY) continue; // not enough time has passed to know
      eligible++;
      if (ats.some((t) => t.getTime() - first.getTime() >= from * DAY && t.getTime() - first.getTime() < to * DAY)) returned++;
    }
    return { eligible, returned };
  };
  return { d7: rate(7, 14), d30: rate(30, 37) };
}

// ── experiments ─────────────────────────────────────────────────────────────

export interface Variant {
  key: string;
  weight: number;
  isControl: boolean;
}

export function validateVariants(variants: unknown): Variant[] {
  if (!Array.isArray(variants) || variants.length < 2 || variants.length > 6) throw new Error('an experiment needs 2 to 6 variants');
  const out = variants.map((v: any) => ({ key: v?.key, weight: v?.weight, isControl: !!v?.isControl }));
  if (out.some((v) => typeof v.key !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(v.key) || !Number.isInteger(v.weight) || v.weight < 1 || v.weight > 100)) {
    throw new Error('each variant needs a key (lower_snake_case) and a whole-number weight from 1 to 100');
  }
  if (new Set(out.map((v) => v.key)).size !== out.length) throw new Error('variant keys must be different');
  if (out.filter((v) => v.isControl).length !== 1) throw new Error('exactly one variant must be the control');
  return out;
}

/** Stable, weighted assignment from the pseudonym and the experiment key (same inputs, same variant). */
export function assignVariant(subject: string, experimentKey: string, variants: Variant[]): string {
  const h = createHash('sha256').update(`${experimentKey}:${subject}`).digest();
  const total = variants.reduce((a, v) => a + v.weight, 0);
  let point = h.readUInt32BE(0) % total;
  for (const v of variants) {
    if (point < v.weight) return v.key;
    point -= v.weight;
  }
  return variants[variants.length - 1].key;
}
