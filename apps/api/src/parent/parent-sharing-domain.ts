/**
 * Pure rules for an adult student sharing their progress summary with a parent (Step 17, PM decision 15 October:
 * guardians of minors see it through their approval; adult students may invite a parent, with their own consent,
 * which they can withdraw at any time).
 */

export const SHARING_PURPOSE = 'PARENT_REPORT_SHARING';
export const SHARE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** PROVISIONAL: how many parents an adult student may share with at once (open and pending together). */
export const MAX_VIEWERS = 2;

export type ShareRefusal = 'NOT_CLASSIFIED' | 'MINOR' | 'TOO_MANY_VIEWERS' | 'OWN_ADDRESS' | 'ALREADY_SHARED';

/**
 * Whether this student may send a sharing invitation now. Minors cannot: their guardian already sees the summary
 * through the guardian approval, and adding other viewers for a child is not in Release 1.
 */
export function shareRefusal(input: {
  classified: boolean;
  requiresGuardianConsent: boolean;
  activeViewers: number;
  pendingInvitations: number;
  ownAddress: boolean;
  alreadySharedWithAddress: boolean;
}): ShareRefusal | null {
  if (!input.classified) return 'NOT_CLASSIFIED';
  if (input.requiresGuardianConsent) return 'MINOR';
  if (input.ownAddress) return 'OWN_ADDRESS';
  if (input.alreadySharedWithAddress) return 'ALREADY_SHARED';
  if (input.activeViewers + input.pendingInvitations >= MAX_VIEWERS) return 'TOO_MANY_VIEWERS';
  return null;
}

export const REFUSAL_TEXT: Record<ShareRefusal, string> = {
  NOT_CLASSIFIED: 'Finish your profile first',
  MINOR: 'Your parent or guardian already sees your progress summary through their approval',
  TOO_MANY_VIEWERS: `You can share with up to ${MAX_VIEWERS} people at a time. Stop sharing with someone first.`,
  OWN_ADDRESS: "Enter a parent's own email address, not yours",
  ALREADY_SHARED: 'You already share with this address, or an invitation to it is waiting',
};
