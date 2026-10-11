import type { DatabaseService } from '../database/database.service';
import { AuthzError, AuthzService } from './authz.service';

function makeFakes() {
  const client: Record<string, any> = {
    role_assignment: { findMany: jest.fn().mockResolvedValue([]), findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn() },
    role: { upsert: jest.fn().mockResolvedValue({ id: 'r1' }) },
    account: { findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }) },
    authentication_identity: { findUnique: jest.fn() },
    audit_event: { create: jest.fn() },
  };
  client.$transaction = jest.fn((cb: any) => cb(client));
  return { client, service: new AuthzService({ client } as unknown as DatabaseService) };
}

describe('AuthzService.curriculumRolesFor', () => {
  it('reads only active, unrevoked assignments of ACTIVE accounts', async () => {
    const { client, service } = makeFakes();
    client.role_assignment.findMany.mockResolvedValue([{ role: { code: 'CURRICULUM_REVIEWER' } }, { role: { code: 'other' } }]);
    await expect(service.curriculumRolesFor('a')).resolves.toEqual(['REVIEWER']);
    expect(client.role_assignment.findMany.mock.calls[0][0].where).toMatchObject({ revoked_at: null, account: { status: 'ACTIVE' } });
  });
});

describe('AuthzService.findAccountId', () => {
  it('normalizes the identifier and never creates an account', async () => {
    const { client, service } = makeFakes();
    client.authentication_identity.findUnique.mockResolvedValue({ account_id: 'acc' });
    await expect(service.findAccountId('EMAIL', '  Alfred@Nevodia.COM ')).resolves.toBe('acc');
    expect(client.authentication_identity.findUnique.mock.calls[0][0].where.kind_identifier_normalized.identifier_normalized).toBe('alfred@nevodia.com');
  });
  it('returns null when unknown', async () => {
    const { client, service } = makeFakes();
    client.authentication_identity.findUnique.mockResolvedValue(null);
    await expect(service.findAccountId('EMAIL', 'x@y.com')).resolves.toBeNull();
  });
});

describe('AuthzService.grantRole', () => {
  const base = { targetAccountId: 't', roleCode: 'CURRICULUM_APPROVER' };
  it('rejects unknown roles, including AI_RESEARCH', async () => {
    const { service } = makeFakes();
    await expect(service.grantRole({ ...base, roleCode: 'AI_RESEARCH', actorAccountId: null, operator: 'op' })).rejects.toBeInstanceOf(AuthzError);
  });
  it('bootstrap path needs an operator', async () => {
    const { service } = makeFakes();
    await expect(service.grantRole({ ...base, actorAccountId: null })).rejects.toBeInstanceOf(AuthzError);
  });
  it('an account actor must hold SUPER_ADMIN', async () => {
    const { client, service } = makeFakes();
    client.role_assignment.findMany.mockResolvedValue([{ role: { code: 'CURRICULUM_APPROVER' } }]);
    await expect(service.grantRole({ ...base, actorAccountId: 'actor' })).rejects.toThrow(/SUPER_ADMIN/);
    expect(client.role_assignment.create).not.toHaveBeenCalled();
  });
  it('a SUPER_ADMIN can grant; the grant is audited with the granter', async () => {
    const { client, service } = makeFakes();
    client.role_assignment.findMany.mockResolvedValue([{ role: { code: 'SUPER_ADMIN' } }]);
    client.role_assignment.findFirst.mockResolvedValue(null);
    await expect(service.grantRole({ ...base, actorAccountId: 'actor' })).resolves.toEqual({ granted: true });
    expect(client.role_assignment.create.mock.calls[0][0].data).toMatchObject({ account_id: 't', granted_by_account_id: 'actor' });
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });
  it('is idempotent', async () => {
    const { client, service } = makeFakes();
    client.role_assignment.findFirst.mockResolvedValue({ id: 'x' });
    await expect(service.grantRole({ ...base, actorAccountId: null, operator: 'op' })).resolves.toEqual({ granted: false });
    expect(client.role_assignment.create).not.toHaveBeenCalled();
  });
  it('refuses a missing or inactive target account', async () => {
    const { client, service } = makeFakes();
    client.account.findUnique.mockResolvedValue({ status: 'SUSPENDED' });
    await expect(service.grantRole({ ...base, actorAccountId: null, operator: 'op' })).rejects.toBeInstanceOf(AuthzError);
  });
});

describe('AuthzService.revokeRole', () => {
  it('revokes and audits; reports when nothing was held', async () => {
    const { client, service } = makeFakes();
    client.role_assignment.updateMany.mockResolvedValue({ count: 1 });
    await expect(service.revokeRole({ targetAccountId: 't', roleCode: 'CURRICULUM_EDITOR', actorAccountId: null, operator: 'op' })).resolves.toEqual({ revoked: true });
    client.role_assignment.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.revokeRole({ targetAccountId: 't', roleCode: 'CURRICULUM_EDITOR', actorAccountId: null, operator: 'op' })).resolves.toEqual({ revoked: false });
    expect(client.audit_event.create).toHaveBeenCalledTimes(1);
  });
});
