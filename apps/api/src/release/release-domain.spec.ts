import { canSee, gatingEnabled, rank, releaseBlocks, type ReleaseChangeFacts } from './release-domain';

const NOW = new Date('2026-10-16T12:00:00Z');
const goodReport = (over: Partial<NonNullable<ReleaseChangeFacts['report']>> = {}): NonNullable<ReleaseChangeFacts['report']> => ({
  sameSubject: true,
  forCurrentRevision: true,
  generatedAt: new Date(NOW.getTime() - 3_600_000),
  policyIsActive: true,
  policySignedOff: true,
  passes: () => true,
  ...over,
});
const facts = (over: Partial<ReleaseChangeFacts> = {}): ReleaseChangeFacts => ({ from: 'FOUNDATION_ONLY', to: 'INTERNAL', note: 'Checked by the academic lead', actorMayRelease: true, report: goodReport(), now: NOW, ...over });

describe('who sees a subject', () => {
  it.each([
    ['FOUNDATION_ONLY', null, false],
    ['FOUNDATION_ONLY', 'INTERNAL', false],
    ['INTERNAL', null, false],
    ['INTERNAL', 'CONTROLLED', false],
    ['INTERNAL', 'INTERNAL', true],
    ['CONTROLLED', null, false],
    ['CONTROLLED', 'CONTROLLED', true],
    ['CONTROLLED', 'INTERNAL', true],
    ['GENERAL', null, true],
  ] as const)('%s to %s: %s', (tier, audience, yes) => expect(canSee(tier, audience)).toBe(yes));

  it('gating is on unless switched off, and cannot be switched off in production', () => {
    expect(gatingEnabled({})).toBe(true);
    expect(gatingEnabled({ RELEASE_GATING_ENABLED: 'false' })).toBe(false);
    expect(() => gatingEnabled({ RELEASE_GATING_ENABLED: 'false', NODE_ENV: 'production' })).toThrow(/not allowed in production/);
    expect(() => gatingEnabled({ RELEASE_GATING_ENABLED: 'off' })).toThrow(/"true" or "false"/);
  });
});

describe('changing a release', () => {
  it('a promotion one step up, on a fresh passing report from the active policy, is allowed', () => {
    expect(releaseBlocks(facts())).toEqual([]);
    expect(releaseBlocks(facts({ from: 'INTERNAL', to: 'CONTROLLED' }))).toEqual([]);
    expect(releaseBlocks(facts({ from: 'CONTROLLED', to: 'GENERAL' }))).toEqual([]);
  });

  it('refuses skipping a tier, no report, a stale, foreign or failing report, or an old revision or policy', () => {
    expect(releaseBlocks(facts({ to: 'CONTROLLED' })).join(' ')).toMatch(/one step at a time.*INTERNAL/);
    expect(releaseBlocks(facts({ report: null }))).toContain('A readiness report is required');
    expect(releaseBlocks(facts({ report: goodReport({ generatedAt: new Date(NOW.getTime() - 25 * 3_600_000) }) })).join(' ')).toMatch(/more than 24 hours old/);
    expect(releaseBlocks(facts({ report: goodReport({ sameSubject: false }) })).join(' ')).toMatch(/another subject/);
    expect(releaseBlocks(facts({ report: goodReport({ forCurrentRevision: false }) })).join(' ')).toMatch(/older curriculum revision/);
    expect(releaseBlocks(facts({ report: goodReport({ policyIsActive: false }) })).join(' ')).toMatch(/no longer active/);
    expect(releaseBlocks(facts({ report: goodReport({ passes: () => false }) })).join(' ')).toMatch(/does not pass the INTERNAL checks/);
  });

  it('CONTROLLED and GENERAL need a signed-off policy; INTERNAL does not', () => {
    const provisional = goodReport({ policySignedOff: false });
    expect(releaseBlocks(facts({ report: provisional }))).toEqual([]);
    expect(releaseBlocks(facts({ from: 'INTERNAL', to: 'CONTROLLED', report: provisional })).join(' ')).toMatch(/signed off by an academic lead/);
    expect(releaseBlocks(facts({ from: 'CONTROLLED', to: 'GENERAL', report: provisional })).join(' ')).toMatch(/signed off/);
  });

  it('a demotion, to any lower tier, needs only an approver and a note', () => {
    expect(releaseBlocks(facts({ from: 'GENERAL', to: 'FOUNDATION_ONLY', report: null }))).toEqual([]);
    expect(releaseBlocks(facts({ from: 'GENERAL', to: 'INTERNAL', report: null }))).toEqual([]);
    expect(releaseBlocks(facts({ from: 'GENERAL', to: 'INTERNAL', report: null, note: 'oops' })).join(' ')).toMatch(/at least 10 characters/);
  });

  it('only approvers, and never to the same tier', () => {
    expect(releaseBlocks(facts({ actorMayRelease: false }))[0]).toMatch(/Only an approver/);
    expect(releaseBlocks(facts({ from: 'INTERNAL', to: 'INTERNAL' })).join(' ')).toMatch(/already INTERNAL/);
    expect(rank('GENERAL')).toBeGreaterThan(rank('CONTROLLED'));
  });
});
