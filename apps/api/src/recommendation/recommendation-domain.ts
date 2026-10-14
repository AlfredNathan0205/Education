/**
 * Recommendations, practice and retest (Step 14). Pure: no database and no clock beyond the `now` passed in.
 *
 * Spec: the core loop is Test -> Score -> Understand mistakes -> Practice -> Retest -> See progress (MASTER_SPEC), and
 * "recommendations must be traceable to structured academic evidence, not arbitrary opaque LLM judgement" (handoff
 * section 20). The spec names the kinds of next action but no selection rules. The rules below are PROVISIONAL and
 * live in a versioned policy row (recommendation_policy_version), not in code constants.
 *
 * A recommendation is never a claim about the student. It says what to practise next and why, in factual terms
 * ("you missed these", "marked Needs attention"), and mastery alone decides what the evidence means afterwards.
 */

import type { Label } from '../mastery/mastery-domain';

export type Kind = 'PRACTICE' | 'RETEST';
export type Status = 'OPEN' | 'STARTED' | 'COMPLETED' | 'DISMISSED' | 'SUPERSEDED';
export type Source = 'MASTERY' | 'RESULT' | 'PRACTICE_DONE';
export type ReasonCode = 'NEEDS_ATTENTION' | 'DEVELOPING' | 'MISSED_MORE_THAN_RIGHT' | 'MISSED_IN_TEST' | 'PRACTISED';
export const REASON_CODES: ReasonCode[] = ['NEEDS_ATTENTION', 'DEVELOPING', 'MISSED_MORE_THAN_RIGHT', 'MISSED_IN_TEST', 'PRACTISED'];

export interface RecommendationPolicy {
  practice: {
    /** At most this many objectives in one practice recommendation. */
    maxObjectives: number;
    /** An objective below every gate needs at least this many answers before low mastery makes it a candidate. */
    minEvidence: number;
    /** ...and a posterior mastery below this. */
    lowMastery: number;
  };
  fromResult: { maxObjectives: number };
  retest: {
    /** A practice set counts as done (and a retest is offered) with at least this many locked answers. */
    minPracticeAnswers: number;
  };
  /** After "not now", the same objectives are not recommended again for this many days. */
  dismissDays: number;
  blueprints: { practice: string; retest: string };
}

export const RECO_V1: RecommendationPolicy = {
  practice: { maxObjectives: 3, minEvidence: 2, lowMastery: 0.5 },
  fromResult: { maxObjectives: 3 },
  retest: { minPracticeAnswers: 5 },
  dismissDays: 7,
  blueprints: { practice: 'PRACTICE10', retest: 'RETEST10' },
};

const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
const code = (v: unknown) => typeof v === 'string' && /^[A-Z][A-Z0-9_]{1,31}$/.test(v);

export function parseRecommendationPolicy(raw: unknown): RecommendationPolicy {
  const p = raw as RecommendationPolicy;
  const need: Array<[string, unknown, (v: unknown) => boolean]> = [
    ['practice.maxObjectives', p?.practice?.maxObjectives, num],
    ['practice.minEvidence', p?.practice?.minEvidence, num],
    ['practice.lowMastery', p?.practice?.lowMastery, num],
    ['fromResult.maxObjectives', p?.fromResult?.maxObjectives, num],
    ['retest.minPracticeAnswers', p?.retest?.minPracticeAnswers, num],
    ['dismissDays', p?.dismissDays, num],
    ['blueprints.practice', p?.blueprints?.practice, code],
    ['blueprints.retest', p?.blueprints?.retest, code],
  ];
  const bad = need.filter(([, v, ok]) => !ok(v)).map(([k]) => k);
  if (bad.length) throw new Error(`recommendation policy is missing or has bad values for: ${bad.join(', ')}`);
  if (p.practice.maxObjectives < 1 || p.fromResult.maxObjectives < 1) throw new Error('recommendation policy must allow at least one objective');
  if (p.practice.lowMastery <= 0 || p.practice.lowMastery >= 1) throw new Error('recommendation policy lowMastery must be between 0 and 1');
  return p;
}

// ── choosing objectives ─────────────────────────────────────────────────────

export interface ObjectiveFacts {
  path: string;
  label: Label;
  reportable: boolean;
  mastery: number;
  evidenceCount: number;
  lastEvidenceAt: Date | null;
}

export interface Target {
  path: string;
  code: ReasonCode;
  facts: Record<string, unknown>;
}

const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');

/**
 * Objectives worth practising, best first. In order: those the gates already mark Needs attention, then Developing,
 * then those below every gate where the student has missed more than they got right (at least `minEvidence`
 * answers). Secure, Strong, not-started and one-answer objectives are never chosen. Objectives the student put off
 * ("not now") within `dismissDays` are left out.
 */
export function practiceTargets(objectives: ObjectiveFacts[], putOff: ReadonlySet<string>, policy: RecommendationPolicy): Target[] {
  const tierOf = (o: ObjectiveFacts): number | null => {
    if (o.label === 'NEEDS_ATTENTION') return 0;
    if (o.label === 'DEVELOPING') return 1;
    if (!o.reportable && o.evidenceCount >= policy.practice.minEvidence && o.mastery < policy.practice.lowMastery) return 2;
    return null;
  };
  const CODES: ReasonCode[] = ['NEEDS_ATTENTION', 'DEVELOPING', 'MISSED_MORE_THAN_RIGHT'];
  return objectives
    .filter((o) => !putOff.has(o.path))
    .map((o) => ({ o, tier: tierOf(o) }))
    .filter((x): x is { o: ObjectiveFacts; tier: number } => x.tier !== null)
    .sort(
      (a, b) =>
        a.tier - b.tier ||
        a.o.mastery - b.o.mastery ||
        (b.o.lastEvidenceAt?.getTime() ?? 0) - (a.o.lastEvidenceAt?.getTime() ?? 0) ||
        a.o.path.localeCompare(b.o.path),
    )
    .slice(0, policy.practice.maxObjectives)
    .map(({ o, tier }) => ({ path: o.path, code: CODES[tier], facts: { label: o.label, answers: o.evidenceCount, mastery: Math.round(o.mastery * 1000) / 1000 } }));
}

export interface ResultItem {
  objectivePath: string;
  locked: boolean;
  isCorrect: boolean | null;
  excluded: boolean;
}

/**
 * "Practise what you missed": the objectives of the wrong or unanswered questions in a finished test, most missed
 * first. Excluded questions (technical failure, invalidated) are never the student's miss.
 */
export function missedTargets(items: ResultItem[], assessmentId: string, policy: RecommendationPolicy): Target[] {
  const missed = new Map<string, number>();
  for (const i of items) {
    if (i.excluded) continue;
    if (!i.locked || i.isCorrect === false) missed.set(i.objectivePath, (missed.get(i.objectivePath) ?? 0) + 1);
  }
  return [...missed.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, policy.fromResult.maxObjectives)
    .map(([path, n]) => ({ path, code: 'MISSED_IN_TEST' as const, facts: { assessmentId, missed: n } }));
}

// ── the refresh after a mastery run ─────────────────────────────────────────

export interface ActiveRecommendation {
  id: string;
  kind: Kind;
  status: 'OPEN' | 'STARTED';
  objectivePaths: string[];
  /** The newest session built for it, if any. */
  session: { status: 'IN_PROGRESS' | 'SUBMITTED' | 'VOID' | 'INVALIDATED'; lockedAnswers: number } | null;
}

export type Action =
  | { type: 'COMPLETE'; id: string }
  | { type: 'REOPEN'; id: string }
  | { type: 'SUPERSEDE'; id: string }
  | { type: 'CREATE'; kind: Kind; source: Source; objectivePaths: string[]; reasons: Target[]; parentId: string | null };

/**
 * What one refresh does for one student and subject. At most one recommendation is active (OPEN or STARTED) per
 * subject:
 * - a started practice that is finished with enough answers is completed and a retest on the same objectives offered;
 *   one finished with too few answers, abandoned or cancelled is reopened;
 * - a started retest that is finished is completed, and the subject is looked at afresh; one abandoned is reopened;
 * - anything still in progress is left alone, and so is an open retest (it stands until done or put off);
 * - an open practice is kept if the chosen objectives are the same, replaced if they changed, and withdrawn if
 *   nothing qualifies any more;
 * - otherwise a new practice recommendation is made when something qualifies.
 */
export function planRefresh(active: ActiveRecommendation | null, targets: Target[], policy: RecommendationPolicy): Action[] {
  const fresh = (): Action[] =>
    targets.length ? [{ type: 'CREATE', kind: 'PRACTICE', source: 'MASTERY', objectivePaths: targets.map((t) => t.path), reasons: targets, parentId: null }] : [];

  if (!active) return fresh();

  if (active.status === 'STARTED') {
    const s = active.session;
    if (!s || s.status === 'IN_PROGRESS') return [];
    if (s.status === 'VOID' || s.status === 'INVALIDATED') return [{ type: 'REOPEN', id: active.id }];
    if (active.kind === 'PRACTICE') {
      if (s.lockedAnswers < policy.retest.minPracticeAnswers) return [{ type: 'REOPEN', id: active.id }];
      return [
        { type: 'COMPLETE', id: active.id },
        {
          type: 'CREATE',
          kind: 'RETEST',
          source: 'PRACTICE_DONE',
          objectivePaths: active.objectivePaths,
          reasons: active.objectivePaths.map((path) => ({ path, code: 'PRACTISED' as const, facts: { practiceAnswers: s.lockedAnswers } })),
          parentId: active.id,
        },
      ];
    }
    return [{ type: 'COMPLETE', id: active.id }, ...fresh()];
  }

  if (active.kind === 'RETEST') return [];
  if (targets.length === 0) return [{ type: 'SUPERSEDE', id: active.id }];
  if (sameSet(active.objectivePaths, targets.map((t) => t.path))) return [];
  return [{ type: 'SUPERSEDE', id: active.id }, ...fresh()];
}

/** Objectives put off with "not now" that are still within the policy's quiet period. */
export function putOffObjectives(dismissed: Array<{ objectivePaths: string[]; closedAt: Date }>, now: Date, policy: RecommendationPolicy): Set<string> {
  const since = now.getTime() - policy.dismissDays * 86_400_000;
  return new Set(dismissed.filter((d) => d.closedAt.getTime() >= since).flatMap((d) => d.objectivePaths));
}
