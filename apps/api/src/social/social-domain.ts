/**
 * Friends and ranked challenges (Step 16). Pure rules: no database, no clock beyond the `now` passed in.
 *
 * Spec (COMPETITION_CHALLENGES): Ranked Challenge needs the same grade and an academically compatible curriculum and
 * scope; exact/equivalent challenge sets respect exposure and bank readiness; opponent answers and progress are hidden
 * until completion; no CP loss, wagering, paid entry or purchasable advantage. Minor defaults: Friends Only, no free
 * chat or custom taunts, safe public profile ID, rate limits, block and report. Friends and Ranked Challenge start
 * CONTROLLED (feature-flagged).
 *
 * PM decisions (Step 16): a friend is added only with a one-time code shown in person; when either student is a minor,
 * each minor's guardian must approve the friendship; a report ends the friendship at once and goes to an admin queue;
 * the whole feature is off by default. The numbers below (code length and lifetime, rate limits, challenge expiry) are
 * PROVISIONAL.
 */

export const SOCIAL_V1 = {
  code: { length: 6, ttlMinutes: 15, perHour: 5 },
  /** Wrong codes allowed per student per hour, against guessing. */
  failedRedeemsPerHour: 10,
  challenge: { expiresHours: 48, perDay: 10, questions: 10, mix: { EASY: 5, MEDIUM: 3, HARD: 2 } },
} as const;

/** Upper case without look-alikes (no I, L, O, 0, 1). */
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newFriendCode(random: () => number, length = SOCIAL_V1.code.length): string {
  let s = '';
  for (let i = 0; i < length; i++) s += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  return s;
}

/** What a student typed, tidied: spaces and dashes dropped, upper case. Null when it cannot be a code. */
export function normaliseCode(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/[\s-]/g, '').toUpperCase();
  return new RegExp(`^[${CODE_ALPHABET}]{${SOCIAL_V1.code.length}}$`).test(s) ? s : null;
}

/** Friendships are stored once per pair, lowest id first. */
export function pairOf(a: string, b: string): { low: string; high: string } {
  return a < b ? { low: a, high: b } : { low: b, high: a };
}

export type FriendshipStatus = 'PENDING_GUARDIAN' | 'ACTIVE' | 'ENDED';

/** A new friendship is active at once between adults; with a minor it waits for each minor's guardian. */
export function startingStatus(minors: string[]): { status: FriendshipStatus; approvalsNeeded: string[] } {
  return minors.length ? { status: 'PENDING_GUARDIAN', approvalsNeeded: [...minors].sort() } : { status: 'ACTIVE', approvalsNeeded: [] };
}

/** After a guardian decision: any decline ends it; all approved activates it; otherwise it keeps waiting. */
export function afterGuardianDecision(approvals: Array<{ status: 'PENDING' | 'APPROVED' | 'DECLINED' }>): FriendshipStatus {
  if (approvals.some((a) => a.status === 'DECLINED')) return 'ENDED';
  if (approvals.every((a) => a.status === 'APPROVED')) return 'ACTIVE';
  return 'PENDING_GUARDIAN';
}

export type ReportReason = 'UNWANTED_CONTACT' | 'CHALLENGE_SPAM' | 'SUSPECTED_CHEATING' | 'MADE_ME_UNCOMFORTABLE' | 'OTHER';
export const REPORT_REASONS: ReportReason[] = ['UNWANTED_CONTACT', 'CHALLENGE_SPAM', 'SUSPECTED_CHEATING', 'MADE_ME_UNCOMFORTABLE', 'OTHER'];
export const isReportReason = (v: unknown): v is ReportReason => typeof v === 'string' && (REPORT_REASONS as string[]).includes(v);

export type ReportResolution = 'NO_ACTION' | 'RESTRICTED';

/** Why two students may not interact, or null when they may. Checked for every friend and challenge action. */
export function interactionBlocked(facts: {
  blockedEitherWay: boolean;
  restricted: string[];
  self: string;
  other: string;
}): 'BLOCKED' | 'YOU_ARE_RESTRICTED' | 'THEY_ARE_RESTRICTED' | null {
  if (facts.restricted.includes(facts.self)) return 'YOU_ARE_RESTRICTED';
  if (facts.blockedEitherWay) return 'BLOCKED';
  if (facts.restricted.includes(facts.other)) return 'THEY_ARE_RESTRICTED';
  return null;
}

// ── challenges ──────────────────────────────────────────────────────────────

export type ChallengeStatus = 'PENDING' | 'ACTIVE' | 'DECLINED' | 'EXPIRED' | 'COMPLETED' | 'CANCELLED';

/** The status as of `now`: an open challenge past its expiry is EXPIRED, whatever is stored. */
export function effectiveStatus(c: { status: ChallengeStatus; expiresAt: Date }, now: Date): ChallengeStatus {
  if ((c.status === 'PENDING' || c.status === 'ACTIVE') && c.expiresAt <= now) return 'EXPIRED';
  return c.status;
}

export type Outcome = 'WIN' | 'LOSS' | 'DRAW';

/**
 * A finished challenge: more correct answers wins; equal is a draw. Speed plays no part (spec). Removed questions
 * (invalidated) are out of both scores because both answered the same questions.
 */
export function outcomeFor(mine: { correct: number }, theirs: { correct: number }): Outcome {
  return mine.correct > theirs.correct ? 'WIN' : mine.correct < theirs.correct ? 'LOSS' : 'DRAW';
}

/** Who may challenge whom, in what. Same curriculum, grade and subject is enforced by building one set for both. */
export function challengeRefusal(f: {
  friendshipActive: boolean;
  sameCohort: boolean;
  openBetweenThem: number;
  sentToday: number;
}): string | null {
  if (!f.friendshipActive) return 'You can only challenge a friend whose friendship is active';
  if (!f.sameCohort) return 'Ranked challenges are only between students of the same curriculum and grade';
  if (f.openBetweenThem > 0) return 'You already have an open challenge with this friend';
  if (f.sentToday >= SOCIAL_V1.challenge.perDay) return `You can send at most ${SOCIAL_V1.challenge.perDay} challenges a day`;
  return null;
}
