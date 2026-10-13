import { BadRequestException, ConflictException, ForbiddenException, HttpException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { GuardianController } from './guardian.controller';
import { GuardianConflictError, GuardianInputError, GuardianNotFoundError, GuardianNotPermittedError, GuardianRateLimitedError, GuardianUnavailableError } from './guardian.errors';

const req: any = { accountId: 'acct' };
const TOKEN = 'A'.repeat(43);
const ID = '11111111-2222-4333-8444-555555555555';

function make() {
  const g: any = {
    createInvitation: jest.fn().mockResolvedValue({ maskedEmail: 'm***@x.com', expiresAt: 'x' }),
    status: jest.fn().mockResolvedValue({}),
    cancelInvitation: jest.fn().mockResolvedValue(undefined),
    preview: jest.fn().mockResolvedValue({}),
    accept: jest.fn().mockResolvedValue(undefined),
    decline: jest.fn().mockResolvedValue(undefined),
    listApprovals: jest.fn().mockResolvedValue([]),
    withdraw: jest.fn().mockResolvedValue(undefined),
  };
  return { g, c: new GuardianController(g) };
}

describe('GuardianController input checks', () => {
  it('every guardian-side route needs a well-formed token in the body', async () => {
    const { c, g } = make();
    for (const raw of [null, {}, { token: 'short' }, { token: 'A'.repeat(44) }, { token: 123 }, []]) {
      await expect(c.preview(req, raw)).rejects.toBeInstanceOf(BadRequestException);
      await expect(c.accept(req, raw)).rejects.toBeInstanceOf(BadRequestException);
      await expect(c.decline(req, raw)).rejects.toBeInstanceOf(BadRequestException);
    }
    expect(g.preview).not.toHaveBeenCalled();
    expect(g.accept).not.toHaveBeenCalled();
  });
  it('passes the token, version and attestation through to accept', async () => {
    const { c, g } = make();
    await c.accept(req, { token: TOKEN, consentVersion: 2, attested: true });
    expect(g.accept).toHaveBeenCalledWith('acct', { token: TOKEN, consentVersion: 2, attested: true });
  });
  it('create passes the raw fields for the service to validate', async () => {
    const { c, g } = make();
    await c.create(req, { email: 'a@b.co', relationshipType: 'MOTHER' });
    expect(g.createInvitation).toHaveBeenCalledWith('acct', { email: 'a@b.co', relationshipType: 'MOTHER' });
    await expect(c.create(req, 'text')).rejects.toBeInstanceOf(BadRequestException);
  });
  it('withdraw needs a UUID', async () => {
    const { c } = make();
    await expect(c.withdraw(req, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.withdraw(req, ID)).resolves.toEqual({ status: 'withdrawn' });
  });
});

describe('GuardianController error mapping', () => {
  const cases: Array<[Error, new (...a: any[]) => Error, number?]> = [
    [new GuardianNotFoundError('x'), NotFoundException],
    [new GuardianNotPermittedError('x'), ForbiddenException],
    [new GuardianConflictError('x'), ConflictException],
    [new GuardianInputError('x'), BadRequestException],
    [new GuardianUnavailableError('x'), ServiceUnavailableException],
  ];
  it.each(cases)('maps %p', async (err, cls) => {
    const { c, g } = make();
    g.preview.mockRejectedValue(err);
    await expect(c.preview(req, { token: TOKEN })).rejects.toBeInstanceOf(cls);
  });
  it('maps a rate limit to 429', async () => {
    const { c, g } = make();
    g.createInvitation.mockRejectedValue(new GuardianRateLimitedError('slow down'));
    const e = await c.create(req, { email: 'a@b.co', relationshipType: 'MOTHER' }).catch((x) => x);
    expect(e).toBeInstanceOf(HttpException);
    expect(e.getStatus()).toBe(429);
  });
  it('does not swallow unexpected errors', async () => {
    const { c, g } = make();
    g.status.mockRejectedValue(new Error('db down'));
    await expect(c.status(req)).rejects.toThrow('db down');
  });
});
