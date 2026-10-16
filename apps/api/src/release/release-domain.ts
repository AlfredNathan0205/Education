/**
 * Step 21: release tiers (spec MASTER_SPEC: FOUNDATION_ONLY → INTERNAL → CONTROLLED → GENERAL; "code readiness never
 * bypasses academic/privacy/safety/operational readiness"). Pure rules; the services do the I/O.
 */

export const TIERS = ['FOUNDATION_ONLY', 'INTERNAL', 'CONTROLLED', 'GENERAL'] as const;
export type Tier = (typeof TIERS)[number];
export type ReleasedTier = Exclude<Tier, 'FOUNDATION_ONLY'>;
/** The audiences an account can be given: internal (staff, alpha) or controlled (private beta). */
export const AUDIENCES = ['INTERNAL', 'CONTROLLED'] as const;
export type Audience = (typeof AUDIENCES)[number];

export const isTier = (v: unknown): v is Tier => typeof v === 'string' && (TIERS as readonly string[]).includes(v);
export const isAudience = (v: unknown): v is Audience => typeof v === 'string' && (AUDIENCES as readonly string[]).includes(v);
export const rank = (t: Tier) => TIERS.indexOf(t);

/** Who sees a subject at a tier: nobody, internal only, internal and controlled, or everyone in the cohort. */
export function canSee(tier: Tier, audience: Audience | null): boolean {
  switch (tier) {
    case 'GENERAL':
      return true;
    case 'CONTROLLED':
      return audience === 'CONTROLLED' || audience === 'INTERNAL';
    case 'INTERNAL':
      return audience === 'INTERNAL';
    default:
      return false;
  }
}

/**
 * RELEASE_GATING_ENABLED (default true). Off = every served subject is visible (local development with data made before
 * Step 21). It cannot be switched off in production.
 */
export function gatingEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.RELEASE_GATING_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'true') return true;
  if (raw !== 'false') throw new Error('RELEASE_GATING_ENABLED must be "true" or "false"');
  if (env.NODE_ENV === 'production') throw new Error('RELEASE_GATING_ENABLED=false is not allowed in production');
  return false;
}

/** A report counts for a release for this long. */
export const REPORT_FRESH_MS = 24 * 3_600_000;
export const MIN_NOTE = 10;
/** Roles that may change a release (spec: only authorised human activation). */
export const RELEASE_ROLES = ['APPROVER', 'SUPER_ADMIN'] as const;

export interface ReleaseChangeFacts {
  from: Tier;
  to: Tier;
  note: string;
  actorMayRelease: boolean;
  /** For a promotion: the report the approver relies on. */
  report: null | {
    sameSubject: boolean;
    forCurrentRevision: boolean;
    generatedAt: Date;
    policyIsActive: boolean;
    policySignedOff: boolean;
    passes: (t: ReleasedTier) => boolean;
  };
  now: Date;
}

/**
 * Why a release change is refused (empty = allowed). Promotions go one tier at a time, on a fresh passing report from
 * the active policy, which must be signed off for CONTROLLED and GENERAL. Demotions (to any lower tier) need only an
 * approver and a note: taking a subject away must never wait for paperwork.
 */
export function releaseBlocks(f: ReleaseChangeFacts): string[] {
  const out: string[] = [];
  if (!f.actorMayRelease) out.push('Only an approver can change what students see');
  if (f.to === f.from) out.push(`This subject is already ${f.to}`);
  if (f.note.trim().length < MIN_NOTE) out.push(`Write a sign-off note of at least ${MIN_NOTE} characters`);
  if (rank(f.to) > rank(f.from)) {
    if (rank(f.to) !== rank(f.from) + 1) out.push(`Release one step at a time: from ${f.from} the next step is ${TIERS[rank(f.from) + 1]}`);
    const r = f.report;
    if (!r) out.push('A readiness report is required');
    else {
      if (!r.sameSubject) out.push('That report is for another subject');
      if (!r.forCurrentRevision) out.push('That report is for an older curriculum revision: check readiness again');
      if (f.now.getTime() - r.generatedAt.getTime() > REPORT_FRESH_MS) out.push('That report is more than 24 hours old: check readiness again');
      if (!r.policyIsActive) out.push('That report used a policy that is no longer active: check readiness again');
      if ((f.to === 'CONTROLLED' || f.to === 'GENERAL') && !r.policySignedOff) out.push(`Releasing to ${f.to} needs a readiness policy signed off by an academic lead`);
      if (f.to !== 'FOUNDATION_ONLY' && !r.passes(f.to)) out.push(`The report does not pass the ${f.to} checks`);
    }
  }
  return out;
}
