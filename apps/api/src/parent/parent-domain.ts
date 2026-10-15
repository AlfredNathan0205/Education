import type { Label } from '../mastery/mastery-domain';

/**
 * Pure rules for what may be said to a parent (spec CLAIM_GATING_PARENT; INVARIANTS 19: parent claims require
 * claim-gate approval). No database and no clock.
 *
 * The mastery gate (Step 13) already decides which LABEL an objective may carry. This layer decides which CLAIMS may be
 * made from those labels, how many, and with which fixed wording:
 * - STRENGTH: only an objective labelled STRONG (the spec's strong gate).
 * - FOCUS: only an objective labelled NEEDS_ATTENTION (the stricter weak gate). One bad test is never a focus area.
 * - IMPROVEMENT (a trend claim, stricter): the label at the start AND at the end of the period both passed the gate,
 *   the band rose, and the student answered on that objective in at least `minPeriodSessions` tests in the period.
 * Everything a candidate was refused for is recorded as a suppressed claim with a reason.
 * Language AI may rephrase approved claims only; Release 1 uses the fixed templates below and no AI at all.
 */

export type ClaimKind = 'STRENGTH' | 'FOCUS' | 'IMPROVEMENT';
export type SuppressReason =
  | 'STRONG_GATE_NOT_MET'
  | 'WEAK_GATE_NOT_MET'
  | 'NO_EARLIER_CLAIM'
  | 'TREND_GATE_NOT_MET'
  | 'OVER_LIMIT';

export interface ClaimPolicy {
  limits: { strengths: number; focus: number; improvements: number };
  improvement: { minPeriodSessions: number };
  /** Bands are read from the mastery policy; these only say which band a candidate would have claimed. */
  templates: { STRENGTH: string; FOCUS: string; IMPROVEMENT: string };
  /** Weekly reports use the same weeks as the leaderboards: Monday 00:00 in this offset (India time). */
  week: { utcOffsetMinutes: number };
}

/** PROVISIONAL limits and wording; lives in the versioned policy row (seeded by the Step 17 migration). */
export const CLAIM_V1: ClaimPolicy = {
  limits: { strengths: 5, focus: 3, improvements: 5 },
  improvement: { minPeriodSessions: 1 },
  templates: {
    STRENGTH: 'STRENGTH_V1',
    FOCUS: 'FOCUS_V1',
    IMPROVEMENT: 'IMPROVEMENT_V1',
  },
  week: { utcOffsetMinutes: 330 },
};

/** The fixed wording for each template. `{statement}`, `{from}` and `{to}` are filled in; nothing else is generated. */
export const TEMPLATE_TEXT: Record<string, string> = {
  STRENGTH_V1: 'Shows strong understanding: {statement}',
  FOCUS_V1: 'Worth more practice: {statement}',
  IMPROVEMENT_V1: 'Moved from {from} to {to}: {statement}',
};

export const LABEL_TEXT: Record<Label, string> = {
  NOT_STARTED: 'Not started',
  BUILDING_EVIDENCE: 'Building evidence',
  NEEDS_ATTENTION: 'Needs attention',
  DEVELOPING: 'Developing',
  SECURE: 'Secure',
  STRONG: 'Strong',
};

export function parseClaimPolicy(raw: unknown): ClaimPolicy {
  const p = raw as ClaimPolicy;
  const ok =
    !!p &&
    typeof p === 'object' &&
    [p.limits?.strengths, p.limits?.focus, p.limits?.improvements, p.improvement?.minPeriodSessions].every(
      (n) => Number.isInteger(n) && (n as number) >= 0 && (n as number) <= 50,
    ) &&
    (['STRENGTH', 'FOCUS', 'IMPROVEMENT'] as const).every((k) => typeof p.templates?.[k] === 'string' && p.templates[k] in TEMPLATE_TEXT) &&
    Number.isInteger(p.week?.utcOffsetMinutes) &&
    Math.abs(p.week.utcOffsetMinutes) <= 14 * 60;
  if (!ok) throw new Error('claim policy params are not valid');
  return p;
}

const RANK: Partial<Record<Label, number>> = { NEEDS_ATTENTION: 1, DEVELOPING: 2, SECURE: 3, STRONG: 4 };

/** What the claim layer needs about one objective at one moment (from the mastery gate). */
export interface ObjectiveSnapshot {
  label: Label;
  reportable: boolean;
  /** 0..1, used only to order and to name what a refused candidate would have claimed. Never shown. */
  mastery: number;
  evidenceCount: number;
}

export interface ObjectiveInput {
  subjectId: string;
  path: string;
  start: ObjectiveSnapshot | null;
  end: ObjectiveSnapshot;
  /** Distinct tests or practice sets in the period that gave evidence on this objective. */
  periodSessions: number;
}

export interface ApprovedClaim {
  kind: ClaimKind;
  subjectId: string;
  path: string;
  label: Label;
  fromLabel: Label | null;
  template: string;
}

export interface Suppressed {
  kind: ClaimKind;
  subjectId: string;
  path: string;
  reason: SuppressReason;
}

export interface ClaimResult {
  strengths: ApprovedClaim[];
  focus: ApprovedClaim[];
  improvements: ApprovedClaim[];
  suppressed: Suppressed[];
}

/**
 * Evaluates every candidate claim. `bands` are the mastery policy's bands (0..100) so a refused candidate can be told
 * apart from no candidate at all.
 */
export function evaluateClaims(objectives: ObjectiveInput[], policy: ClaimPolicy, bands: { strong: number; developing: number }): ClaimResult {
  const strengths: Array<ApprovedClaim & { order: number }> = [];
  const focus: Array<ApprovedClaim & { order: number }> = [];
  const improvements: Array<ApprovedClaim & { order: number }> = [];
  const suppressed: Suppressed[] = [];
  const sorted = [...objectives].sort((a, b) => `${a.subjectId}/${a.path}`.localeCompare(`${b.subjectId}/${b.path}`));

  for (const o of sorted) {
    const { end } = o;
    if (end.evidenceCount === 0) continue;
    const m = end.mastery * 100;
    const base = { subjectId: o.subjectId, path: o.path };

    if (end.label === 'STRONG') strengths.push({ ...base, kind: 'STRENGTH', label: 'STRONG', fromLabel: null, template: policy.templates.STRENGTH, order: -end.mastery });
    else if (m >= bands.strong) suppressed.push({ ...base, kind: 'STRENGTH', reason: 'STRONG_GATE_NOT_MET' });

    if (end.label === 'NEEDS_ATTENTION') focus.push({ ...base, kind: 'FOCUS', label: 'NEEDS_ATTENTION', fromLabel: null, template: policy.templates.FOCUS, order: end.mastery });
    else if (!end.reportable && m < bands.developing) suppressed.push({ ...base, kind: 'FOCUS', reason: 'WEAK_GATE_NOT_MET' });

    const to = RANK[end.label];
    const from = o.start ? RANK[o.start.label] : undefined;
    if (to !== undefined && end.reportable) {
      if (from === undefined || !o.start?.reportable) {
        // Newly reportable is not an improvement: there was nothing to improve on that could be said.
        if (o.start && o.start.evidenceCount > 0 && o.periodSessions > 0) suppressed.push({ ...base, kind: 'IMPROVEMENT', reason: 'NO_EARLIER_CLAIM' });
      } else if (to > from) {
        if (o.periodSessions >= policy.improvement.minPeriodSessions) {
          improvements.push({ ...base, kind: 'IMPROVEMENT', label: end.label, fromLabel: o.start!.label, template: policy.templates.IMPROVEMENT, order: -(to - from) });
        } else suppressed.push({ ...base, kind: 'IMPROVEMENT', reason: 'TREND_GATE_NOT_MET' });
      }
    }
  }

  const cap = (list: Array<ApprovedClaim & { order: number }>, n: number): ApprovedClaim[] => {
    const ordered = [...list].sort((a, b) => a.order - b.order || `${a.subjectId}/${a.path}`.localeCompare(`${b.subjectId}/${b.path}`));
    for (const c of ordered.slice(n)) suppressed.push({ kind: c.kind, subjectId: c.subjectId, path: c.path, reason: 'OVER_LIMIT' });
    return ordered.slice(0, n).map(({ order: _o, ...c }) => c);
  };
  return {
    strengths: cap(strengths, policy.limits.strengths),
    focus: cap(focus, policy.limits.focus),
    improvements: cap(improvements, policy.limits.improvements),
    suppressed,
  };
}

/** The approved claim's sentence, from its fixed template. */
export function claimText(c: { template: string; label: Label; fromLabel: Label | null }, statement: string): string {
  const t = TEMPLATE_TEXT[c.template] ?? '{statement}';
  return t
    .replace('{statement}', statement)
    .replace('{from}', c.fromLabel ? LABEL_TEXT[c.fromLabel].toLowerCase() : '')
    .replace('{to}', LABEL_TEXT[c.label].toLowerCase());
}

/** Counts of objectives per label for a subject picture. */
export function labelCounts(labels: Label[]): Record<Label, number> {
  const out: Record<Label, number> = { NOT_STARTED: 0, BUILDING_EVIDENCE: 0, NEEDS_ATTENTION: 0, DEVELOPING: 0, SECURE: 0, STRONG: 0 };
  for (const l of labels) out[l]++;
  return out;
}

/** Activity facts for a period. These are facts, not claims, so they need no gate. Scores are not shown to parents. */
export interface Activity {
  tests: number;
  practice: number;
  questionsAnswered: number;
  activeDays: number;
}

export function activityOf(
  sessions: Array<{ mode: 'TEST' | 'PRACTICE'; submittedAt: Date; answered: number }>,
  utcOffsetMinutes: number,
): Activity {
  const days = new Set(
    sessions.map((s) => new Date(s.submittedAt.getTime() + utcOffsetMinutes * 60_000).toISOString().slice(0, 10)),
  );
  return {
    tests: sessions.filter((s) => s.mode === 'TEST').length,
    practice: sessions.filter((s) => s.mode === 'PRACTICE').length,
    questionsAnswered: sessions.reduce((a, s) => a + s.answered, 0),
    activeDays: days.size,
  };
}

/** A report needs a new version when a correction to that week's evidence happened after its latest version. */
export function needsNewVersion(latestGeneratedAt: Date, corrections: Array<{ at: Date; sessionSubmittedAt: Date | null }>, weekEnd: Date): boolean {
  return corrections.some((c) => c.at > latestGeneratedAt && c.sessionSubmittedAt !== null && c.sessionSubmittedAt < weekEnd);
}

/** The week containing `at`: Monday 00:00 to the next Monday 00:00 in the policy's offset. */
export function weekOf(at: Date, utcOffsetMinutes: number): { start: Date; end: Date } {
  const off = utcOffsetMinutes * 60_000;
  const local = new Date(at.getTime() + off);
  const day = (local.getUTCDay() + 6) % 7; // Monday = 0
  const startLocal = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() - day);
  return { start: new Date(startLocal - off), end: new Date(startLocal - off + 7 * 86_400_000) };
}

/** Who a parent-side viewer is to the student. */
export type ViewBasis = 'GUARDIAN' | 'STUDENT_SHARE';
