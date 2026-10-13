import { MethodNotAcceptedError } from '../privacy/privacy.errors';
import { DEV_DRAFT_WORDING_REFERENCE } from './consent-texts';
import { INVITE_COOLDOWN_MS, INVITE_TTL_MS, hashInviteToken } from './guardian-domain';
import { GuardianMailDeliveryError } from './guardian-mailer';
import {
  GuardianConflictError,
  GuardianInputError,
  GuardianNotFoundError,
  GuardianNotPermittedError,
  GuardianRateLimitedError,
  GuardianUnavailableError,
} from './guardian.errors';
import { GuardianService } from './guardian.service';

const NOW = new Date('2026-10-13T12:00:00Z');
const STUDENT_ACCT = 'student-acct';
const STUDENT = 'stud-1';
const GUARDIAN_ACCT = 'guardian-acct';
const GUARDIAN_EMAIL = 'mum@example.com';
const BASE = 'https://app.example.com';

interface Opts {
  classified?: boolean;
  requires?: boolean;
  satisfied?: boolean;
  wording?: boolean;
  guardianHasIdentity?: boolean;
  studentOwnEmail?: string;
  mailFails?: boolean;
}

function build(opts: Opts = {}) {
  let n = 0;
  const invitations: any[] = [];
  const audits: any[] = [];
  const published: any[] = [];
  const sent: Array<{ to: string; link: string }> = [];

  const client: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: STUDENT }]),
    account_student_access: {
      findFirst: jest.fn(async ({ where }: any) => (where.account_id === STUDENT_ACCT ? { student_id: STUDENT } : null)),
    },
    authentication_identity: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.account_id === STUDENT_ACCT) return where.identifier_normalized === opts.studentOwnEmail ? { id: 'i1' } : null;
        if (where.account_id === GUARDIAN_ACCT && (opts.guardianHasIdentity ?? true) && where.identifier_normalized === GUARDIAN_EMAIL) return { id: 'i2' };
        return null;
      }),
    },
    guardian_invitation: {
      findMany: jest.fn(async ({ where }: any) =>
        invitations
          .filter((i) => (where.student_id ? i.student_id === where.student_id : i.guardian_email_normalized === where.guardian_email_normalized) && i.created_at > where.created_at.gt)
          .map((i) => ({ created_at: i.created_at })),
      ),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hits = invitations.filter(
          (i) =>
            (!where.id || i.id === where.id) &&
            (!where.student_id || i.student_id === where.student_id) &&
            (!where.status || i.status === where.status) &&
            (!where.expires_at || i.expires_at > where.expires_at.gt),
        );
        hits.forEach((h) => Object.assign(h, data));
        return { count: hits.length };
      }),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `inv-${++n}`, status: 'PENDING', created_at: new Date(NOW), resolved_at: null, ...data };
        invitations.push(row);
        return row;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        invitations.filter((i) => i.student_id === where.student_id && i.status === where.status && i.expires_at > where.expires_at.gt).slice(-1)[0] ?? null,
      ),
      findUnique: jest.fn(async ({ where }: any) => invitations.find((i) => i.token_hash === where.token_hash) ?? null),
    },
    consent_purpose: { findUnique: jest.fn(async () => (opts.wording === false ? null : { id: 'purpose-1' })) },
    consent_policy_version: {
      findFirst: jest.fn(async () => (opts.wording === false ? null : { version: 3, text_reference: DEV_DRAFT_WORDING_REFERENCE })),
    },
    audit_event: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
  };
  client.$transaction = jest.fn(async (cb: any) => {
    // a real transaction rolls back on error: snapshot and restore
    const snap = JSON.parse(JSON.stringify(invitations));
    try {
      return await cb(client);
    } catch (e) {
      invitations.splice(0, invitations.length, ...snap.map((r: any) => ({ ...r, created_at: new Date(r.created_at), expires_at: new Date(r.expires_at) })));
      throw e;
    }
  });

  const privacy: any = {
    getClassificationSummary: jest.fn(async () => ({
      classified: opts.classified ?? true,
      requiresGuardianConsent: opts.requires ?? true,
      consentSatisfied: opts.satisfied ?? false,
      basis: 'POLICY',
    })),
    establishGuardianApproval: jest.fn(async () => ({ consentRecordId: 'rec-1', guardianAuthorityId: 'auth-1' })),
    listGuardianApprovals: jest.fn(async () => [{ consentRecordId: 'rec-1', studentId: STUDENT, displayName: null, grantedAt: NOW }]),
    withdrawConsent: jest.fn(async () => undefined),
  };
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  const mailer: any = {
    sendInvitation: jest.fn(async (to: string, link: string) => {
      if (opts.mailFails) throw new GuardianMailDeliveryError();
      sent.push({ to, link });
    }),
  };
  const service = new GuardianService({ client } as any, privacy, outbox, mailer, BASE);
  const tokenOf = () => sent[sent.length - 1].link.split('#t=')[1];
  return { service, client, privacy, outbox, mailer, invitations, audits, published, sent, tokenOf };
}

const invite = (h: ReturnType<typeof build>, at: Date = NOW, email: unknown = GUARDIAN_EMAIL) =>
  h.service.createInvitation(STUDENT_ACCT, { email, relationshipType: 'MOTHER' }, at);

describe('createInvitation', () => {
  it('stores only a hash of the token, emails the link, and returns a masked address', async () => {
    const h = build();
    const out = await invite(h);
    expect(out.maskedEmail).toBe('m***@example.com');
    expect(out.expiresAt).toBe(new Date(NOW.getTime() + INVITE_TTL_MS).toISOString());
    const token = h.tokenOf();
    expect(h.sent[0].link).toBe(`${BASE}/guardian/approve#t=${token}`);
    expect(h.invitations[0].token_hash).toBe(hashInviteToken(token));
    expect(JSON.stringify(h.invitations)).not.toContain(token);
    expect(JSON.stringify(h.published)).not.toContain(GUARDIAN_EMAIL);
  });

  it('normalises the address', async () => {
    const h = build();
    await invite(h, NOW, '  Mum@Example.COM ');
    expect(h.invitations[0].guardian_email_normalized).toBe(GUARDIAN_EMAIL);
  });

  it('rejects a bad address and an unknown relationship without storing anything', async () => {
    const h = build();
    await expect(invite(h, NOW, 'nope')).rejects.toBeInstanceOf(GuardianInputError);
    await expect(h.service.createInvitation(STUDENT_ACCT, { email: GUARDIAN_EMAIL, relationshipType: 'FRIEND' }, NOW)).rejects.toBeInstanceOf(GuardianInputError);
    expect(h.invitations).toHaveLength(0);
  });

  it("rejects the student's own sign-in address", async () => {
    const h = build({ studentOwnEmail: GUARDIAN_EMAIL });
    await expect(invite(h)).rejects.toThrow(/not yours/);
    expect(h.invitations).toHaveLength(0);
  });

  it('needs a profile, a classification, a requirement for consent, and no approval yet', async () => {
    await expect(build().service.createInvitation('stranger', { email: GUARDIAN_EMAIL, relationshipType: 'MOTHER' }, NOW)).rejects.toBeInstanceOf(GuardianNotPermittedError);
    await expect(invite(build({ classified: false }))).rejects.toBeInstanceOf(GuardianNotPermittedError);
    await expect(invite(build({ requires: false }))).rejects.toBeInstanceOf(GuardianConflictError);
    await expect(invite(build({ satisfied: true }))).rejects.toBeInstanceOf(GuardianConflictError);
  });

  it('a resend replaces the pending invitation, so only the newest link works', async () => {
    const h = build();
    await invite(h);
    const first = h.tokenOf();
    await invite(h, new Date(NOW.getTime() + INVITE_COOLDOWN_MS + 1000));
    expect(h.invitations.map((i) => i.status)).toEqual(['CANCELLED', 'PENDING']);
    await expect(h.service.preview(GUARDIAN_ACCT, first, new Date(NOW.getTime() + INVITE_COOLDOWN_MS + 2000))).rejects.toBeInstanceOf(GuardianConflictError);
    await expect(h.service.preview(GUARDIAN_ACCT, h.tokenOf(), new Date(NOW.getTime() + INVITE_COOLDOWN_MS + 2000))).resolves.toBeDefined();
  });

  it('enforces the cooldown and the daily limits', async () => {
    const h = build();
    await invite(h);
    await expect(invite(h, new Date(NOW.getTime() + 1000))).rejects.toBeInstanceOf(GuardianRateLimitedError);
    await invite(h, new Date(NOW.getTime() + 2 * INVITE_COOLDOWN_MS));
    await invite(h, new Date(NOW.getTime() + 4 * INVITE_COOLDOWN_MS));
    await expect(invite(h, new Date(NOW.getTime() + 6 * INVITE_COOLDOWN_MS))).rejects.toThrow(/limit|can't receive/);
    expect(h.sent).toHaveLength(3);
  });

  it('cancels the invitation and reports unavailable when the email cannot be sent', async () => {
    const h = build({ mailFails: true });
    await expect(invite(h)).rejects.toBeInstanceOf(GuardianUnavailableError);
    expect(h.invitations[0].status).toBe('CANCELLED');
  });

  it('serialises on the student row', async () => {
    const h = build();
    await invite(h);
    expect(h.client.$queryRaw).toHaveBeenCalled();
  });
});

describe('status', () => {
  it('reports a pending request with a masked address', async () => {
    const h = build();
    await invite(h);
    const s = await h.service.status(STUDENT_ACCT, NOW);
    expect(s).toMatchObject({ approvalNeeded: true, approved: false, pending: { maskedEmail: 'm***@example.com', relationshipType: 'MOTHER' } });
  });
  it('reports approved once consent is satisfied', async () => {
    const h = build({ satisfied: true });
    expect(await h.service.status(STUDENT_ACCT, NOW)).toMatchObject({ approvalNeeded: false, approved: true });
  });
  it('does not show an expired request as pending', async () => {
    const h = build();
    await invite(h);
    const later = new Date(NOW.getTime() + INVITE_TTL_MS + 1);
    expect((await h.service.status(STUDENT_ACCT, later)).pending).toBeNull();
  });
  it('cancel clears the pending request', async () => {
    const h = build();
    await invite(h);
    await h.service.cancelInvitation(STUDENT_ACCT, NOW);
    expect((await h.service.status(STUDENT_ACCT, NOW)).pending).toBeNull();
  });
});

describe('preview', () => {
  it('shows the wording, flagged as draft, to the guardian who owns the address', async () => {
    const h = build();
    await invite(h);
    const p = await h.service.preview(GUARDIAN_ACCT, h.tokenOf(), NOW);
    expect(p.consent.draft).toBe(true);
    expect(p.consent.version).toBe(3);
    expect(p.consent.paragraphs.length).toBeGreaterThan(2);
    expect(p.relationshipType).toBe('MOTHER');
  });
  it('refuses an account that does not control the invited address', async () => {
    const h = build({ guardianHasIdentity: false });
    await invite(h);
    await expect(h.service.preview(GUARDIAN_ACCT, h.tokenOf(), NOW)).rejects.toBeInstanceOf(GuardianNotPermittedError);
  });
  it('treats an unknown token as not found', async () => {
    const h = build();
    await expect(h.service.preview(GUARDIAN_ACCT, 'x'.repeat(43), NOW)).rejects.toBeInstanceOf(GuardianNotFoundError);
  });
  it('refuses an expired link', async () => {
    const h = build();
    await invite(h);
    await expect(h.service.preview(GUARDIAN_ACCT, h.tokenOf(), new Date(NOW.getTime() + INVITE_TTL_MS))).rejects.toThrow(/expired/);
  });
  it('is unavailable when no consent wording is live', async () => {
    const h = build({ wording: false });
    await invite(h);
    await expect(h.service.preview(GUARDIAN_ACCT, h.tokenOf(), NOW)).rejects.toBeInstanceOf(GuardianUnavailableError);
  });
  it('is unavailable in production while the wording is an unreviewed draft', async () => {
    const h = build();
    await invite(h);
    const old = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await expect(h.service.preview(GUARDIAN_ACCT, h.tokenOf(), NOW)).rejects.toBeInstanceOf(GuardianUnavailableError);
    } finally {
      process.env.NODE_ENV = old;
    }
  });
});

describe('accept', () => {
  const ok = (h: ReturnType<typeof build>, over: Record<string, unknown> = {}) =>
    h.service.accept(GUARDIAN_ACCT, { token: h.tokenOf(), consentVersion: 3, attested: true, ...over }, NOW);

  it('records the approval through the privacy module, inside the same transaction, using the policy-checked method', async () => {
    const h = build();
    await invite(h);
    await ok(h);
    expect(h.invitations[0].status).toBe('ACCEPTED');
    expect(h.privacy.establishGuardianApproval).toHaveBeenCalledWith(
      expect.objectContaining({ studentId: STUDENT, guardianAccountId: GUARDIAN_ACCT, relationshipType: 'MOTHER', method: 'EMAIL_LINK_ATTESTATION', evidenceReference: 'guardian_invitation:inv-1' }),
      NOW,
      h.client, // the open transaction
    );
    expect(h.published.map((e) => e.eventType)).toContain('guardian.invitation.accepted.v1');
  });

  it('needs the explicit attestation and the wording version', async () => {
    const h = build();
    await invite(h);
    await expect(ok(h, { attested: false })).rejects.toBeInstanceOf(GuardianInputError);
    await expect(ok(h, { attested: 'yes' })).rejects.toBeInstanceOf(GuardianInputError);
    await expect(ok(h, { consentVersion: '3' })).rejects.toBeInstanceOf(GuardianInputError);
    expect(h.privacy.establishGuardianApproval).not.toHaveBeenCalled();
  });

  it('refuses when the wording changed since the guardian read it', async () => {
    const h = build();
    await invite(h);
    await expect(ok(h, { consentVersion: 2 })).rejects.toBeInstanceOf(GuardianConflictError);
    expect(h.invitations[0].status).toBe('PENDING');
  });

  it('stays PENDING and reports unavailable when the policy does not accept the method (rolled back)', async () => {
    const h = build();
    await invite(h);
    h.privacy.establishGuardianApproval.mockRejectedValue(new MethodNotAcceptedError('not accepted'));
    await expect(ok(h)).rejects.toBeInstanceOf(GuardianUnavailableError);
    expect(h.invitations[0].status).toBe('PENDING');
  });

  it('cannot be used twice', async () => {
    const h = build();
    await invite(h);
    await ok(h);
    await expect(ok(h)).rejects.toBeInstanceOf(GuardianConflictError);
    expect(h.privacy.establishGuardianApproval).toHaveBeenCalledTimes(1);
  });

  it('loses cleanly to a concurrent accept: the claim fails, so no approval is recorded', async () => {
    const h = build();
    await invite(h);
    const real = h.client.guardian_invitation.updateMany;
    h.client.guardian_invitation.updateMany = jest.fn(async (args: any) =>
      args.data.status === 'ACCEPTED' ? { count: 0 } : real(args),
    );
    await expect(ok(h)).rejects.toBeInstanceOf(GuardianConflictError);
    expect(h.privacy.establishGuardianApproval).not.toHaveBeenCalled();
  });

  it('refuses an account that does not control the invited address, and writes nothing', async () => {
    const h = build({ guardianHasIdentity: false });
    await invite(h);
    await expect(ok(h)).rejects.toBeInstanceOf(GuardianNotPermittedError);
    expect(h.privacy.establishGuardianApproval).not.toHaveBeenCalled();
  });

  it('maps "student approving themselves" to not permitted', async () => {
    const h = build();
    await invite(h);
    const { PrivacyForbiddenError } = jest.requireActual('../privacy/privacy.errors');
    h.privacy.establishGuardianApproval.mockRejectedValue(new PrivacyForbiddenError('A student cannot approve their own account'));
    await expect(ok(h)).rejects.toBeInstanceOf(GuardianNotPermittedError);
  });
});

describe('decline, approvals and withdraw', () => {
  it('decline marks the request declined and nothing is approved', async () => {
    const h = build();
    await invite(h);
    await h.service.decline(GUARDIAN_ACCT, h.tokenOf(), NOW);
    expect(h.invitations[0].status).toBe('DECLINED');
    expect(h.privacy.establishGuardianApproval).not.toHaveBeenCalled();
    await expect(h.service.preview(GUARDIAN_ACCT, h.tokenOf(), NOW)).rejects.toBeInstanceOf(GuardianConflictError);
  });
  it('withdraw works only for an approval this guardian holds', async () => {
    const h = build();
    await h.service.withdraw(GUARDIAN_ACCT, 'rec-1', NOW);
    expect(h.privacy.withdrawConsent).toHaveBeenCalledWith({ consentRecordId: 'rec-1', actorAccountId: GUARDIAN_ACCT, reasonCode: 'GUARDIAN_WITHDREW' }, NOW);
    await expect(h.service.withdraw(GUARDIAN_ACCT, 'someone-elses', NOW)).rejects.toBeInstanceOf(GuardianNotFoundError);
  });
});
