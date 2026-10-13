import { Injectable, Logger } from '@nestjs/common';
import { maskIdentifier } from '../identity/identifier';
import { INVITE_TTL_MS } from './guardian-domain';

/** Delivers the approval link to a guardian. */
export interface GuardianMailer {
  sendInvitation(toEmailNormalized: string, link: string): Promise<void>;
}
export const GUARDIAN_MAILER = Symbol('GUARDIAN_MAILER');

export class GuardianMailDeliveryError extends Error {
  constructor(message = 'the approval email could not be delivered') {
    super(message);
    this.name = 'GuardianMailDeliveryError';
  }
}

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * The message deliberately says nothing about the student: not a name, not an age. It names the
 * service, says what is being asked, how long the link lasts, and what to do if it is unexpected.
 */
export function buildInvitationEmail(link: string): { subject: string; text: string; html: string } {
  const days = Math.round(INVITE_TTL_MS / (24 * 60 * 60 * 1000));
  const text = [
    'Someone has asked you to approve their Exam App account.',
    '',
    'Exam App is a service where school students take practice tests. A student under the age set by local rules needs a parent or guardian to approve before they can use it.',
    '',
    `To read what you would be approving, and to approve or decline, open this link:`,
    link,
    '',
    `The link works for ${days} days. You will be asked to sign in with this email address.`,
    "If you don't recognise this request, ignore this email. Nothing happens unless you open the link and approve.",
  ].join('\n');
  const html =
    `<p>Someone has asked you to approve their Exam App account.</p>` +
    `<p>Exam App is a service where school students take practice tests. A student under the age set by local rules needs a parent or guardian to approve before they can use it.</p>` +
    `<p><a href="${link}">Read what you would be approving, and approve or decline</a></p>` +
    `<p>The link works for ${days} days. You will be asked to sign in with this email address.</p>` +
    `<p style="color:#555">If you don't recognise this request, ignore this email. Nothing happens unless you open the link and approve.</p>`;
  return { subject: 'Please review an Exam App approval request', text, html };
}

/** Development only: prints the link to the server log. Refuses to run in production. */
@Injectable()
export class ConsoleGuardianMailer implements GuardianMailer {
  private readonly logger = new Logger(ConsoleGuardianMailer.name);
  async sendInvitation(to: string, link: string): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('ConsoleGuardianMailer must not be used in production');
    }
    this.logger.warn(`[DEV ONLY] approval link for ${maskIdentifier('EMAIL', to)}: ${link}`);
  }
}

export class ResendGuardianMailer implements GuardianMailer {
  private readonly logger = new Logger(ResendGuardianMailer.name);
  constructor(
    private readonly config: { apiKey: string; from: string; timeoutMs?: number; fetchImpl?: typeof fetch },
  ) {}

  async sendInvitation(to: string, link: string): Promise<void> {
    const masked = maskIdentifier('EMAIL', to);
    const doFetch = this.config.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.config.from, to: [to], ...buildInvitationEmail(link) }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 8_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
      this.logger.error(`approval email to ${masked} failed: ${reason}`);
      throw new GuardianMailDeliveryError(`email provider ${reason}`);
    }
    if (!response.ok) {
      this.logger.error(`approval email to ${masked} rejected by the provider (HTTP ${response.status})`);
      throw new GuardianMailDeliveryError(`email provider rejected the request (HTTP ${response.status})`);
    }
  }
}

type Env = Record<string, string | undefined>;

/** Same provider settings as sign-in codes, plus WEB_BASE_URL (required in production) for the link. */
export function createGuardianMailer(env: Env = process.env, fetchImpl?: typeof fetch): GuardianMailer {
  const production = env.NODE_ENV === 'production';
  const provider = (env.EMAIL_PROVIDER ?? (production ? 'resend' : 'console')).toLowerCase();
  if (provider === 'console') {
    if (production) throw new Error('EMAIL_PROVIDER=console is not allowed in production');
    return new ConsoleGuardianMailer();
  }
  if (provider === 'resend') {
    const apiKey = (env.RESEND_API_KEY ?? '').trim();
    const from = (env.EMAIL_FROM ?? '').trim();
    if (apiKey === '') throw new Error('RESEND_API_KEY must be set when EMAIL_PROVIDER=resend');
    if (from === '' || /[\r\n]/.test(from) || !from.includes('@')) throw new Error('EMAIL_FROM must be an address');
    return new ResendGuardianMailer({ apiKey, from, fetchImpl });
  }
  throw new Error(`EMAIL_PROVIDER must be "resend" or "console" (got "${provider}")`);
}

/** Where the guardian lands. In production this must be set explicitly, and must be https. */
export function webBaseUrl(env: Env = process.env): string {
  const raw = (env.WEB_BASE_URL ?? '').trim().replace(/\/+$/, '');
  if (raw === '') {
    if (env.NODE_ENV === 'production') throw new Error('WEB_BASE_URL must be set in production');
    return 'http://localhost:3000';
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('WEB_BASE_URL must be a full URL such as https://app.example.com');
  }
  if (env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('WEB_BASE_URL must use https in production');
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('WEB_BASE_URL must be http(s)');
  return raw;
}

/** The token goes in the URL fragment, which browsers never send to servers, so it stays out of server and proxy logs. */
export function invitationLink(baseUrl: string, token: string): string {
  return `${baseUrl}/guardian/approve#t=${token}`;
}
