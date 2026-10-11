import { CliUsageError, runRolesCli } from './roles-cli';

function deps(account: string | null = 'acc') {
  const authz = {
    findAccountId: jest.fn().mockResolvedValue(account),
    grantRole: jest.fn().mockResolvedValue({ granted: true }),
    revokeRole: jest.fn().mockResolvedValue({ revoked: true }),
    curriculumRolesFor: jest.fn().mockResolvedValue(['EDITOR']),
  };
  return { authz, d: { authz, operator: 'ops' } as never };
}

describe('runRolesCli', () => {
  it('requires an operator', async () => {
    const { authz } = deps();
    await expect(runRolesCli(['list', 'email', 'a@b.com'], { authz, operator: '' } as never)).rejects.toBeInstanceOf(CliUsageError);
  });
  it('grant uses the bootstrap path (no actor account) with the operator recorded', async () => {
    const { authz, d } = deps();
    await runRolesCli(['grant', 'email', 'alfred@nevodia.com', 'CURRICULUM_REVIEWER'], d);
    expect(authz.grantRole).toHaveBeenCalledWith({ targetAccountId: 'acc', roleCode: 'CURRICULUM_REVIEWER', actorAccountId: null, operator: 'ops' });
  });
  it('tells the operator to have the person sign in first when no account exists, and grants nothing', async () => {
    const { authz, d } = deps(null);
    await expect(runRolesCli(['grant', 'email', 'new@x.com', 'SUPER_ADMIN'], d)).rejects.toThrow(/sign in once/);
    expect(authz.grantRole).not.toHaveBeenCalled();
  });
  it('lists and revokes', async () => {
    const { d } = deps();
    expect(await runRolesCli(['list', 'email', 'a@b.com'], d)).toMatch(/EDITOR/);
    expect(await runRolesCli(['revoke', 'email', 'a@b.com', 'CURRICULUM_EDITOR'], d)).toMatch(/Revoked/);
  });
  it.each([[[]], [['grant']], [['grant', 'fax', 'x', 'R']], [['grant', 'email', 'a@b.com']], [['bogus', 'email', 'a@b.com']]])('rejects bad args %p', async (argv) => {
    const { d } = deps();
    await expect(runRolesCli(argv as string[], d)).rejects.toBeInstanceOf(CliUsageError);
  });
});
