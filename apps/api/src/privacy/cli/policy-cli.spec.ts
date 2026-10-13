import {
  CliUsageError,
  DEV_TEST_JURISDICTION,
  DEV_TEST_POLICY_CONFIG,
  DEV_TEST_REVIEW_REF,
  assertDevEnvironment,
  runPolicyCli,
} from './policy-cli';

function deps(over: Record<string, unknown> = {}) {
  const service = {
    createJurisdictionPolicyDraft: jest.fn().mockResolvedValue({ id: 'p1', version: 2 }),
    markPolicyCounselReviewed: jest.fn().mockResolvedValue(undefined),
    activateJurisdictionPolicy: jest.fn().mockResolvedValue(undefined),
  };
  return {
    service,
    d: { service, operator: 'ops@example.com', readFile: () => '{"a":1}', ...over } as never,
  };
}

const devEnv = { NODE_ENV: 'development', ALLOW_DEV_TEST_POLICY: 'true' };

describe('runPolicyCli', () => {
  it('requires an operator for the audit trail', async () => {
    const { d } = deps({ operator: ' ' });
    await expect(runPolicyCli(['activate', 'p1'], d)).rejects.toBeInstanceOf(CliUsageError);
  });

  it('draft passes parsed JSON and operator, and never claims review or activation', async () => {
    const { service, d } = deps();
    const msg = await runPolicyCli(['draft', 'AE', 'c.json'], d);
    expect(service.createJurisdictionPolicyDraft).toHaveBeenCalledWith(
      { jurisdictionCode: 'AE', config: { a: 1 } },
      null,
      'ops@example.com',
    );
    expect(msg).toMatch(/Not reviewed, not active/);
  });

  it('draft reports unreadable JSON as a usage error', async () => {
    const { d } = deps({ readFile: () => 'nope' });
    await expect(runPolicyCli(['draft', 'AE', 'c.json'], d)).rejects.toBeInstanceOf(CliUsageError);
  });

  it('review joins a multi-word reference', async () => {
    const { service, d } = deps();
    await runPolicyCli(['review', 'p1', 'memo', '2026-11', 'v2'], d);
    expect(service.markPolicyCounselReviewed).toHaveBeenCalledWith(
      'p1',
      'memo 2026-11 v2',
      null,
      'ops@example.com',
    );
  });

  it('activate delegates to the legal gate', async () => {
    const { service, d } = deps();
    await runPolicyCli(['activate', 'p1'], d);
    expect(service.activateJurisdictionPolicy).toHaveBeenCalledWith('p1', null);
  });

  it.each([[[]], [['bogus']], [['draft', 'AE']], [['review', 'p1']], [['activate']]])(
    'rejects bad arguments %p',
    async (argv) => {
      const { d } = deps();
      await expect(runPolicyCli(argv as string[], d)).rejects.toBeInstanceOf(CliUsageError);
    },
  );
});

describe('seed-dev-policy', () => {
  it('refuses when NODE_ENV=production', async () => {
    const { d } = deps({ env: { NODE_ENV: 'production', ALLOW_DEV_TEST_POLICY: 'true' } });
    await expect(runPolicyCli(['seed-dev-policy'], d)).rejects.toThrow(/production/);
  });

  it('refuses without ALLOW_DEV_TEST_POLICY=true', async () => {
    const { d } = deps({ env: { NODE_ENV: 'development' } });
    await expect(runPolicyCli(['seed-dev-policy'], d)).rejects.toThrow(/ALLOW_DEV_TEST_POLICY/);
  });

  it('refuses ALLOW_DEV_TEST_POLICY=false', async () => {
    const { d } = deps({ env: { NODE_ENV: 'development', ALLOW_DEV_TEST_POLICY: 'false' } });
    await expect(runPolicyCli(['seed-dev-policy'], d)).rejects.toThrow(/ALLOW_DEV_TEST_POLICY/);
  });

  it('creates, reviews, and activates a test policy for jurisdiction XX', async () => {
    const { service, d } = deps({ env: devEnv });
    const msg = await runPolicyCli(['seed-dev-policy'], d);

    expect(service.createJurisdictionPolicyDraft).toHaveBeenCalledWith(
      { jurisdictionCode: DEV_TEST_JURISDICTION, config: DEV_TEST_POLICY_CONFIG },
      null,
      'ops@example.com',
    );
    expect(service.markPolicyCounselReviewed).toHaveBeenCalledWith(
      'p1',
      DEV_TEST_REVIEW_REF,
      null,
      'ops@example.com',
    );
    expect(service.activateJurisdictionPolicy).toHaveBeenCalledWith('p1', null);
    expect(msg).toMatch(/DEV TEST POLICY/);
    expect(msg).toMatch(/NOT A LEGAL VALUE/);
  });

  it('rejects extra arguments', async () => {
    const { d } = deps({ env: devEnv });
    await expect(runPolicyCli(['seed-dev-policy', 'extra'], d)).rejects.toBeInstanceOf(CliUsageError);
  });
});

describe('assertDevEnvironment', () => {
  it('passes in development with flag', () => {
    expect(() => assertDevEnvironment({ env: devEnv } as never)).not.toThrow();
  });

  it('passes when NODE_ENV is undefined (not production)', () => {
    expect(() =>
      assertDevEnvironment({ env: { ALLOW_DEV_TEST_POLICY: 'true' } } as never),
    ).not.toThrow();
  });

  it('rejects production even with flag', () => {
    expect(() =>
      assertDevEnvironment({
        env: { NODE_ENV: 'production', ALLOW_DEV_TEST_POLICY: 'true' },
      } as never),
    ).toThrow(CliUsageError);
  });

  it('rejects without flag', () => {
    expect(() =>
      assertDevEnvironment({ env: { NODE_ENV: 'development' } } as never),
    ).toThrow(CliUsageError);
  });
});
