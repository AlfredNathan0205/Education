import {
  CODE_ALPHABET,
  SOCIAL_V1,
  afterGuardianDecision,
  challengeRefusal,
  effectiveStatus,
  interactionBlocked,
  isReportReason,
  newFriendCode,
  normaliseCode,
  outcomeFor,
  pairOf,
  startingStatus,
} from './social-domain';

describe('friend codes', () => {
  it('six characters from an alphabet without look-alikes', () => {
    expect(CODE_ALPHABET).not.toMatch(/[IL0O1]/);
    let i = 0;
    const code = newFriendCode(() => [0, 0.5, 0.99, 0.25, 0.75, 0.1][i++]);
    expect(code).toHaveLength(6);
    expect([...code].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
  });

  it('accepts what a person would type, refuses what cannot be a code', () => {
    expect(normaliseCode(' ab3-x7k ')).toBe('AB3X7K');
    expect(normaliseCode('AB3X7')).toBeNull();
    expect(normaliseCode('AB3X7O')).toBeNull(); // O is not in the alphabet
    expect(normaliseCode(123456)).toBeNull();
  });
});

describe('friendships', () => {
  it('are stored once per pair', () => {
    expect(pairOf('b', 'a')).toEqual({ low: 'a', high: 'b' });
    expect(pairOf('a', 'b')).toEqual({ low: 'a', high: 'b' });
  });

  it('between adults are active at once; with a minor they wait for each minor\'s guardian', () => {
    expect(startingStatus([])).toEqual({ status: 'ACTIVE', approvalsNeeded: [] });
    expect(startingStatus(['kid2', 'kid1'])).toEqual({ status: 'PENDING_GUARDIAN', approvalsNeeded: ['kid1', 'kid2'] });
  });

  it('one decline ends it; all approvals activate it', () => {
    expect(afterGuardianDecision([{ status: 'APPROVED' }, { status: 'PENDING' }])).toBe('PENDING_GUARDIAN');
    expect(afterGuardianDecision([{ status: 'APPROVED' }, { status: 'APPROVED' }])).toBe('ACTIVE');
    expect(afterGuardianDecision([{ status: 'APPROVED' }, { status: 'DECLINED' }])).toBe('ENDED');
  });

  it('report reasons are a fixed list (no free text)', () => {
    expect(isReportReason('UNWANTED_CONTACT')).toBe(true);
    expect(isReportReason('he said something rude')).toBe(false);
  });
});

describe('interactionBlocked', () => {
  const base = { blockedEitherWay: false, restricted: [] as string[], self: 'me', other: 'them' };
  it('restriction and blocks stop every interaction', () => {
    expect(interactionBlocked(base)).toBeNull();
    expect(interactionBlocked({ ...base, blockedEitherWay: true })).toBe('BLOCKED');
    expect(interactionBlocked({ ...base, restricted: ['me'] })).toBe('YOU_ARE_RESTRICTED');
    expect(interactionBlocked({ ...base, restricted: ['them'] })).toBe('THEY_ARE_RESTRICTED');
  });
});

describe('challenges', () => {
  const now = new Date('2026-10-15T10:00:00Z');
  it('expire when their time is up, whatever is stored', () => {
    expect(effectiveStatus({ status: 'PENDING', expiresAt: new Date('2026-10-15T09:59:59Z') }, now)).toBe('EXPIRED');
    expect(effectiveStatus({ status: 'ACTIVE', expiresAt: new Date('2026-10-16T00:00:00Z') }, now)).toBe('ACTIVE');
    expect(effectiveStatus({ status: 'COMPLETED', expiresAt: new Date('2026-10-14T00:00:00Z') }, now)).toBe('COMPLETED');
  });

  it('more correct answers wins; equal is a draw; speed is not an input', () => {
    expect(outcomeFor({ correct: 7 }, { correct: 6 })).toBe('WIN');
    expect(outcomeFor({ correct: 6 }, { correct: 7 })).toBe('LOSS');
    expect(outcomeFor({ correct: 6 }, { correct: 6 })).toBe('DRAW');
  });

  it('only active friends of the same cohort, one open challenge per pair, a daily limit', () => {
    const ok = { friendshipActive: true, sameCohort: true, openBetweenThem: 0, sentToday: 0 };
    expect(challengeRefusal(ok)).toBeNull();
    expect(challengeRefusal({ ...ok, friendshipActive: false })).toMatch(/friend/);
    expect(challengeRefusal({ ...ok, sameCohort: false })).toMatch(/same curriculum and grade/);
    expect(challengeRefusal({ ...ok, openBetweenThem: 1 })).toMatch(/already/);
    expect(challengeRefusal({ ...ok, sentToday: SOCIAL_V1.challenge.perDay })).toMatch(/at most 10/);
  });
});
