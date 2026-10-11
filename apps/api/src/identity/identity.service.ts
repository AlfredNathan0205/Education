import { Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@exam-app/database';
import { DatabaseService } from '../database/database.service';
import { OutboxService } from '../outbox/outbox.service';
import { normalizeIdentifier, type IdentityKind } from './identifier';
import {
  OTP_MAX_ATTEMPTS,
  OTP_TTL_MS,
  SESSION_TTL_MS,
  canIssueOtp,
  generateOtpCode,
  generateSessionToken,
  hashOtpCode,
  hashSessionToken,
  precheckOtpAttempt,
  verifyOtpCode,
} from './otp';
import { OTP_SENDER, type OtpSender } from './otp-sender.port';

/**
 * Deliberately one generic error for every failure (unknown identity, wrong code,
 * expired, locked, consumed, suspended account) so callers cannot tell them apart.
 */
export class InvalidOtpError extends Error {
  constructor() {
    super('Invalid or expired code');
    this.name = 'InvalidOtpError';
  }
}

export interface VerifiedLogin {
  sessionToken: string;
  accountId: string;
  isNewAccount: boolean;
  expiresAt: Date;
}

/**
 * Domain 01a — Accounts & Sessions. Passwordless (OTP) only.
 * Owns: account, authentication_identity, otp_challenge, auth_session.
 * Never writes consent or age state (that is 01b, see D11).
 */
@Injectable()
export class IdentityService {
  constructor(
    private readonly db: DatabaseService,
    private readonly outbox: OutboxService,
    @Inject(OTP_SENDER) private readonly sender: OtpSender,
  ) {}

  /** Read lazily so the app (and its module-compile test) boots without the secret. */
  private secret(): string {
    const secret = process.env.OTP_HMAC_SECRET;
    if (!secret || secret.length < 32) {
      throw new Error('OTP_HMAC_SECRET must be set to at least 32 characters');
    }
    return secret;
  }

  /**
   * Issue a code. Resolves identically whether or not the identity already
   * exists, and whether or not the resend cooldown suppressed a new code, so the
   * response never reveals which identities are registered.
   */
  async requestOtp(
    kind: IdentityKind,
    rawIdentifier: string,
    now: Date = new Date(),
  ): Promise<void> {
    const identifier = normalizeIdentifier(kind, rawIdentifier);
    const secret = this.secret();
    const client = this.db.client;

    const latest = await client.otp_challenge.findFirst({
      where: { kind, identifier_normalized: identifier },
      orderBy: { created_at: 'desc' },
      select: { created_at: true },
    });
    if (!canIssueOtp(latest?.created_at ?? null, now)) return;

    const code = generateOtpCode();
    await client.otp_challenge.create({
      data: {
        kind,
        identifier_normalized: identifier,
        code_hash: hashOtpCode(code, identifier, secret),
        expires_at: new Date(now.getTime() + OTP_TTL_MS),
        max_attempts: OTP_MAX_ATTEMPTS,
      },
    });
    await this.sender.send(kind, identifier, code);
  }

  /** Verify a code; on success find-or-create the account and open a session. */
  async verifyOtp(
    kind: IdentityKind,
    rawIdentifier: string,
    code: string,
    now: Date = new Date(),
  ): Promise<VerifiedLogin> {
    const identifier = normalizeIdentifier(kind, rawIdentifier);
    const secret = this.secret();
    const client = this.db.client;

    const challenge = await client.otp_challenge.findFirst({
      where: { kind, identifier_normalized: identifier, consumed_at: null },
      orderBy: { created_at: 'desc' },
    });
    if (!challenge) throw new InvalidOtpError();

    const precheck = precheckOtpAttempt(
      {
        expiresAt: challenge.expires_at,
        attempts: challenge.attempts,
        maxAttempts: challenge.max_attempts,
        consumedAt: challenge.consumed_at,
      },
      now,
    );
    if (precheck !== 'ALLOWED') throw new InvalidOtpError();

    // Count the attempt BEFORE checking the code, and outside the transaction
    // below, so a wrong guess is always recorded even though it then throws.
    // The WHERE clause makes the cap atomic under concurrent guesses.
    const counted = await client.otp_challenge.updateMany({
      where: { id: challenge.id, consumed_at: null, attempts: { lt: challenge.max_attempts } },
      data: { attempts: { increment: 1 } },
    });
    if (counted.count === 0) throw new InvalidOtpError();

    if (!verifyOtpCode(code, challenge.code_hash, identifier, secret)) throw new InvalidOtpError();

    return client.$transaction(async (tx: Prisma.TransactionClient) => {
      const consumed = await tx.otp_challenge.updateMany({
        where: { id: challenge.id, consumed_at: null },
        data: { consumed_at: now },
      });
      if (consumed.count === 0) throw new InvalidOtpError(); // lost a race with another verify

      const existing = await tx.authentication_identity.findUnique({
        where: { kind_identifier_normalized: { kind, identifier_normalized: identifier } },
        include: { account: { select: { status: true } } },
      });

      let accountId: string;
      let isNewAccount = false;

      if (existing) {
        if (existing.account.status !== 'ACTIVE') throw new InvalidOtpError();
        accountId = existing.account_id;
        if (!existing.verified_at) {
          await tx.authentication_identity.update({
            where: { id: existing.id },
            data: { verified_at: now },
          });
        }
      } else {
        const account = await tx.account.create({
          data: {
            identities: { create: { kind, identifier_normalized: identifier, verified_at: now } },
          },
        });
        accountId = account.id;
        isNewAccount = true;

        // The identifier itself is intentionally NOT put in the event or audit payload.
        await this.outbox.publish(tx, {
          aggregateType: 'account',
          aggregateId: account.id,
          eventType: 'identity.account.created.v1',
          payload: { accountId: account.id, identityKind: kind },
          idempotencyKey: `account-created:${account.id}`,
        });
        await tx.audit_event.create({
          data: {
            actor_account_id: account.id,
            action: 'identity.account.created',
            subject_type: 'account',
            subject_id: account.id,
            metadata: { identityKind: kind },
          },
        });
      }

      const sessionToken = generateSessionToken();
      const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
      const session = await tx.auth_session.create({
        data: {
          account_id: accountId,
          token_hash: hashSessionToken(sessionToken),
          expires_at: expiresAt,
        },
      });
      await tx.audit_event.create({
        data: {
          actor_account_id: accountId,
          action: 'identity.session.created',
          subject_type: 'auth_session',
          subject_id: session.id,
        },
      });

      return { sessionToken, accountId, isNewAccount, expiresAt };
    });
  }

  /** Resolve a bearer token to an account, or null if invalid, expired, revoked or suspended. */
  async authenticate(
    token: string,
    now: Date = new Date(),
  ): Promise<{ accountId: string; sessionId: string } | null> {
    const session = await this.db.client.auth_session.findUnique({
      where: { token_hash: hashSessionToken(token) },
      include: { account: { select: { status: true } } },
    });
    if (!session) return null;
    if (session.revoked_at !== null) return null;
    if (session.expires_at.getTime() <= now.getTime()) return null;
    if (session.account.status !== 'ACTIVE') return null;
    return { accountId: session.account_id, sessionId: session.id };
  }

  async revokeSession(token: string, now: Date = new Date()): Promise<void> {
    await this.db.client.auth_session.updateMany({
      where: { token_hash: hashSessionToken(token), revoked_at: null },
      data: { revoked_at: now },
    });
  }
}
