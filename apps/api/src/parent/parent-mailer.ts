import { Injectable, Logger } from '@nestjs/common';
import { maskIdentifier } from '../identity/identifier';
import { GuardianMailDeliveryError } from '../guardian/guardian-mailer';
import { SHARE_TTL_MS } from './parent-sharing-domain';

/** Delivers an adult student's invitation to a parent to see their progress summary. */
export interface ParentShareMailer {
  sendShareInvitation(toEmailNormalized: string, link: string): Promise<void>;
}
export const PARENT_SHARE_MAILER = Symbol('PARENT_SHARE_MAILER');

const RESEND_URL = 'https://api.resend.com/emails';

/** Like the guardian email, it names no student: the link and the sign-in check carry the identity. */
export function buildShareEmail(link: string): { subject: string; text: string; html: string } {
  const days = Math.round(SHARE_TTL_MS / (24 * 60 * 60 * 1000));
  const text = [
    'A student has invited you to see a summary of their progress on Exam App.',
    '',
    'Exam App is a service where school students take practice tests. The summary shows what they have practised and their progress labels; it does not show their answers or scores.',
    '',
    'To accept or decline, open this link:',
    link,
    '',
    `The link works for ${days} days. You will be asked to sign in with this email address.`,
    "If you don't recognise this, ignore this email. Nothing happens unless you open the link and accept.",
  ].join('\n');
  const html =
    `<p>A student has invited you to see a summary of their progress on Exam App.</p>` +
    `<p>Exam App is a service where school students take practice tests. The summary shows what they have practised and their progress labels; it does not show their answers or scores.</p>` +
    `<p><a href="${link}">Accept or decline</a></p>` +
    `<p>The link works for ${days} days. You will be asked to sign in with this email address.</p>` +
    `<p style="color:#555">If you don't recognise this, ignore this email. Nothing happens unless you open the link and accept.</p>`;
  return { subject: 'You have been invited to see a progress summary', text, html };
}

/** Development only: prints the link to the server log. Refuses to run in production. */
@Injectable()
export class ConsoleParentShareMailer implements ParentShareMailer {
  private readonly logger = new Logger(ConsoleParentShareMailer.name);
  async sendShareInvitation(to: string, link: string): Promise<void> {
    if (process.env.NODE_ENV === 'production') throw new Error('ConsoleParentShareMailer must not be used in production');
    this.logger.warn(`[DEV ONLY] progress-sharing link for ${maskIdentifier('EMAIL', to)}: ${link}`);
  }
}

export class ResendParentShareMailer implements ParentShareMailer {
  private readonly logger = new Logger(ResendParentShareMailer.name);
  constructor(private readonly config: { apiKey: string; from: string; timeoutMs?: number; fetchImpl?: typeof fetch }) {}

  async sendShareInvitation(to: string, link: string): Promise<void> {
    const masked = maskIdentifier('EMAIL', to);
    const doFetch = this.config.fetchImpl ?? fetch;
    let response: Response;
    try {
      response = await doFetch(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.config.from, to: [to], ...buildShareEmail(link) }),
        signal: AbortSignal.timeout(this.config.timeoutMs ?? 8_000),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
      this.logger.error(`sharing email to ${masked} failed: ${reason}`);
      throw new GuardianMailDeliveryError(`email provider ${reason}`);
    }
    if (!response.ok) {
      this.logger.error(`sharing email to ${masked} rejected by the provider (HTTP ${response.status})`);
      throw new GuardianMailDeliveryError(`email provider rejected the request (HTTP ${response.status})`);
    }
  }
}

/** Same provider settings as sign-in codes and guardian approvals. */
export function createParentShareMailer(env: Record<string, string | undefined> = process.env, fetchImpl?: typeof fetch): ParentShareMailer {
  const production = env.NODE_ENV === 'production';
  const provider = (env.EMAIL_PROVIDER ?? (production ? 'resend' : 'console')).toLowerCase();
  if (provider === 'console') {
    if (production) throw new Error('EMAIL_PROVIDER=console is not allowed in production');
    return new ConsoleParentShareMailer();
  }
  if (provider === 'resend') {
    const apiKey = (env.RESEND_API_KEY ?? '').trim();
    const from = (env.EMAIL_FROM ?? '').trim();
    if (apiKey === '') throw new Error('RESEND_API_KEY must be set when EMAIL_PROVIDER=resend');
    if (from === '' || /[\r\n]/.test(from) || !from.includes('@')) throw new Error('EMAIL_FROM must be an address');
    return new ResendParentShareMailer({ apiKey, from, fetchImpl });
  }
  throw new Error(`EMAIL_PROVIDER must be "resend" or "console" (got "${provider}")`);
}

/** The token goes in the URL fragment, which browsers never send to servers. */
export function shareLink(baseUrl: string, token: string): string {
  return `${baseUrl}/parent/accept#t=${token}`;
}
