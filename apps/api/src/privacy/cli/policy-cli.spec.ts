import { CliUsageError, runPolicyCli } from './policy-cli';

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
