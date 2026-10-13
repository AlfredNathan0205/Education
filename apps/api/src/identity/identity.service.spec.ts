import type { DatabaseService } from '../database/database.service';
import type { OutboxService } from '../outbox/outbox.service';
import { IdentityService, InvalidOtpError } from './identity.service';
import { OtpDeliveryError } from './otp-sender.port';
import { OTP_RESEND_COOLDOWN_MS, hashOtpCode, hashSessionToken } from './otp';
import type { OtpSender } from './otp-sender.port';

/**
 * Runs the service against an in-memory fake of the Prisma client: verifies the
 * security behaviour (hash-only storage, attempt counting, generic errors), not
 * real SQL. Prisma typing is verified by CI; real queries need a database.
 */

const SECRET = 'a'.repeat(40);
const EMAIL = 'student@example.com';
const NOW = new Date('2026-10-11T12:00:00Z');

function makeFakes() {
  const client: Record<string, any> = {
    otp_challenge: { findFirst: jest.fn(), create: jest.fn(), updateMany: jest.fn(), deleteMany: jest.fn().mockResolvedValue({ count: 1 }) },
    authentication_identity: { findUnique: jest.fn(), update: jest.fn() },
    account: { create: jest.fn() },
    auth_session: { create: jest.fn(), findUnique: jest.fn(), updateMany: jest.fn() },
    audit_event: { create: jest.fn() },
  };
  client.$transaction = jest.fn((cb: (tx: unknown) => unknown) => cb(client));
  const outbox = { publish: jest.fn() };
  const sender: jest.Mocked<OtpSender> = { send: jest.fn().mockResolvedValue(undefined) };
  const service = new IdentityService(
    { client } as unknown as DatabaseService,
    outbox as unknown as OutboxService,
    sender,
  );
  return { client, outbox, sender, service };
}

const challenge = (over: Record<string, unknown> = {}) => ({
  id: 'ch-1',
  code_hash: hashOtpCode('123456', EMAIL, SECRET),
  expires_at: new Date(NOW.getTime() + 60_000),
  attempts: 0,
  max_attempts: 5,
  consumed_at: null,
  ...over,
});

beforeEach(() => {
  process.env.OTP_HMAC_SECRET = SECRET;
});
afterAll(() => {
  delete process.env.OTP_HMAC_SECRET;
});

describe('IdentityService.requestOtp: delivery failure', () => {
  it('removes the stored code and reports a delivery error, so the person can retry straight away', async () => {
    const { client, sender, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(null);
    client.otp_challenge.create.mockResolvedValue({ id: 'ch-9' });
    sender.send.mockRejectedValue(new OtpDeliveryError('email provider timed out'));

    await expect(service.requestOtp('EMAIL', EMAIL, NOW)).rejects.toBeInstanceOf(OtpDeliveryError);
    expect(client.otp_challenge.deleteMany).toHaveBeenCalledWith({ where: { id: 'ch-9' } });
  });

  it('turns an unexpected sender error into a delivery error without leaking its text', async () => {
    const { client, sender, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(null);
    client.otp_challenge.create.mockResolvedValue({ id: 'ch-9' });
    sender.send.mockRejectedValue(new Error('secret provider detail'));

    const err = await service.requestOtp('EMAIL', EMAIL, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(OtpDeliveryError);
    expect(String(err.message)).not.toContain('secret');
  });

  it('still reports the delivery error if cleaning up the stored code fails', async () => {
    const { client, sender, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(null);
    client.otp_challenge.create.mockResolvedValue({ id: 'ch-9' });
    client.otp_challenge.deleteMany.mockRejectedValue(new Error('db down'));
    sender.send.mockRejectedValue(new OtpDeliveryError());

    await expect(service.requestOtp('EMAIL', EMAIL, NOW)).rejects.toBeInstanceOf(OtpDeliveryError);
  });
});

describe('IdentityService.requestOtp', () => {
  it('stores only a hash of the code and sends the code itself to the sender', async () => {
    const { client, sender, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(null);

    await service.requestOtp('EMAIL', '  Student@Example.com ', NOW);

    const stored = client.otp_challenge.create.mock.calls[0][0].data;
    const [, sentTo, code] = sender.send.mock.calls[0];
    expect(sentTo).toBe(EMAIL);
    expect(code).toMatch(/^\d{6}$/);
    expect(stored.identifier_normalized).toBe(EMAIL);
    expect(stored.code_hash).toBe(hashOtpCode(code, EMAIL, SECRET));
    expect(JSON.stringify(stored)).not.toContain(code);
  });

  it('silently sends nothing inside the resend cooldown (same outward behaviour)', async () => {
    const { client, sender, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue({
      created_at: new Date(NOW.getTime() - (OTP_RESEND_COOLDOWN_MS - 1000)),
    });
    await expect(service.requestOtp('EMAIL', EMAIL, NOW)).resolves.toBeUndefined();
    expect(client.otp_challenge.create).not.toHaveBeenCalled();
    expect(sender.send).not.toHaveBeenCalled();
  });

  it('never looks up whether the identity is registered', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(null);
    await service.requestOtp('EMAIL', EMAIL, NOW);
    expect(client.authentication_identity.findUnique).not.toHaveBeenCalled();
  });

  it('refuses to run without a strong secret', async () => {
    const { service } = makeFakes();
    process.env.OTP_HMAC_SECRET = 'short';
    await expect(service.requestOtp('EMAIL', EMAIL, NOW)).rejects.toThrow(/OTP_HMAC_SECRET/);
  });
});

describe('IdentityService.verifyOtp', () => {
  it('rejects when there is no challenge', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(null);
    await expect(service.verifyOtp('EMAIL', EMAIL, '123456', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
  });

  it('does not even check the code once attempts are exhausted', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge({ attempts: 5 }));
    await expect(service.verifyOtp('EMAIL', EMAIL, '123456', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
    expect(client.otp_challenge.updateMany).not.toHaveBeenCalled();
    expect(client.$transaction).not.toHaveBeenCalled();
  });

  it('rejects an expired challenge', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(
      challenge({ expires_at: new Date(NOW.getTime() - 1) }),
    );
    await expect(service.verifyOtp('EMAIL', EMAIL, '123456', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
  });

  it('counts a wrong guess, then rejects it without opening a transaction', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge());
    client.otp_challenge.updateMany.mockResolvedValue({ count: 1 });

    await expect(service.verifyOtp('EMAIL', EMAIL, '000000', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );

    expect(client.otp_challenge.updateMany).toHaveBeenCalledWith({
      where: { id: 'ch-1', consumed_at: null, attempts: { lt: 5 } },
      data: { attempts: { increment: 1 } },
    });
    expect(client.$transaction).not.toHaveBeenCalled();
    expect(client.auth_session.create).not.toHaveBeenCalled();
  });

  it('rejects when the atomic attempt cap was lost to a concurrent guess', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge());
    client.otp_challenge.updateMany.mockResolvedValue({ count: 0 });
    await expect(service.verifyOtp('EMAIL', EMAIL, '123456', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
  });

  it('creates an account, an outbox event, an audit row and a session on a correct first login', async () => {
    const { client, outbox, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge());
    client.otp_challenge.updateMany.mockResolvedValue({ count: 1 });
    client.authentication_identity.findUnique.mockResolvedValue(null);
    client.account.create.mockResolvedValue({ id: 'acct-1' });
    client.auth_session.create.mockResolvedValue({ id: 'sess-1' });

    const login = await service.verifyOtp('EMAIL', EMAIL, '123456', NOW);

    expect(login).toMatchObject({ accountId: 'acct-1', isNewAccount: true });
    expect(login.expiresAt.getTime()).toBeGreaterThan(NOW.getTime());
    expect(outbox.publish).toHaveBeenCalledTimes(1);
    expect(client.audit_event.create).toHaveBeenCalledTimes(2); // account.created + session.created

    // Only the hash of the session token is persisted.
    const storedSession = client.auth_session.create.mock.calls[0][0].data;
    expect(storedSession.token_hash).toBe(hashSessionToken(login.sessionToken));
    expect(JSON.stringify(storedSession)).not.toContain(login.sessionToken);

    // The identifier is kept out of the event and audit payloads.
    const emitted = JSON.stringify([
      outbox.publish.mock.calls,
      client.audit_event.create.mock.calls,
    ]);
    expect(emitted).not.toContain(EMAIL);
  });

  it('reuses the existing account on a repeat login and emits no account-created event', async () => {
    const { client, outbox, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge());
    client.otp_challenge.updateMany.mockResolvedValue({ count: 1 });
    client.authentication_identity.findUnique.mockResolvedValue({
      id: 'idn-1',
      account_id: 'acct-9',
      verified_at: NOW,
      account: { status: 'ACTIVE' },
    });
    client.auth_session.create.mockResolvedValue({ id: 'sess-2' });

    const login = await service.verifyOtp('EMAIL', EMAIL, '123456', NOW);

    expect(login).toMatchObject({ accountId: 'acct-9', isNewAccount: false });
    expect(client.account.create).not.toHaveBeenCalled();
    expect(outbox.publish).not.toHaveBeenCalled();
  });

  it('refuses to log in a suspended account, with the same generic error', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge());
    client.otp_challenge.updateMany.mockResolvedValue({ count: 1 });
    client.authentication_identity.findUnique.mockResolvedValue({
      id: 'idn-1',
      account_id: 'acct-9',
      verified_at: NOW,
      account: { status: 'SUSPENDED' },
    });
    await expect(service.verifyOtp('EMAIL', EMAIL, '123456', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
    expect(client.auth_session.create).not.toHaveBeenCalled();
  });

  it('rejects if another verification consumed the challenge first', async () => {
    const { client, service } = makeFakes();
    client.otp_challenge.findFirst.mockResolvedValue(challenge());
    client.otp_challenge.updateMany
      .mockResolvedValueOnce({ count: 1 }) // attempt counted
      .mockResolvedValueOnce({ count: 0 }); // consume lost the race
    await expect(service.verifyOtp('EMAIL', EMAIL, '123456', NOW)).rejects.toBeInstanceOf(
      InvalidOtpError,
    );
    expect(client.auth_session.create).not.toHaveBeenCalled();
  });
});

describe('IdentityService.authenticate', () => {
  const session = (over: Record<string, unknown> = {}) => ({
    id: 's1',
    account_id: 'a1',
    revoked_at: null,
    expires_at: new Date(NOW.getTime() + 1000),
    account: { status: 'ACTIVE' },
    ...over,
  });

  it('looks the session up by token hash, never by the raw token', async () => {
    const { client, service } = makeFakes();
    client.auth_session.findUnique.mockResolvedValue(session());
    await service.authenticate('raw-token', NOW);
    expect(client.auth_session.findUnique.mock.calls[0][0].where).toEqual({
      token_hash: hashSessionToken('raw-token'),
    });
  });

  it('returns the account for a live session', async () => {
    const { client, service } = makeFakes();
    client.auth_session.findUnique.mockResolvedValue(session());
    expect(await service.authenticate('t', NOW)).toEqual({ accountId: 'a1', sessionId: 's1' });
  });

  it.each([
    ['unknown', null],
    ['revoked', session({ revoked_at: NOW })],
    ['expired', session({ expires_at: new Date(NOW.getTime() - 1) })],
    ['suspended account', session({ account: { status: 'SUSPENDED' } })],
  ])('returns null for a %s session', async (_label, row) => {
    const { client, service } = makeFakes();
    client.auth_session.findUnique.mockResolvedValue(row);
    expect(await service.authenticate('t', NOW)).toBeNull();
  });
});
