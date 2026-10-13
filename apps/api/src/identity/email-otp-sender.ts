import { Logger } from '@nestjs/common';
import { maskIdentifier, type IdentityKind } from './identifier';
import { OTP_TTL_MS } from './otp';
import { ConsoleOtpSender, OtpDeliveryError, type OtpSender } from './otp-sender.port';

const RESEND_URL = 'https://api.resend.com/emails';
const DEFAULT_TIMEOUT_MS = 8_000;

export interface EmailOtpSenderConfig {
  apiKey: string;
  /** "Exam App <signin@your-verified-domain>" or a bare address on a domain verified with the provider. */
  from: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/** Builds the message. The code is in the body only, never the subject (subjects show in lock-screen previews and logs). */
export function buildSignInEmail(code: string): { subject: string; text: string; html: string } {
  const minutes = Math.round(OTP_TTL_MS / 60_000);
  const text = [
    `Your Exam App sign-in code is ${code}.`,
    '',
    `It expires in ${minutes} minutes and works once.`,
    "If you didn't ask for this, you can ignore this email. Nobody can sign in without the code.",
  ].join('\n');
  const html =
    `<p>Your Exam App sign-in code is:</p>` +
    `<p style="font-size:28px;letter-spacing:6px;font-weight:700;margin:12px 0">${code}</p>` +
    `<p>It expires in ${minutes} minutes and works once.</p>` +
    `<p style="color:#555">If you didn't ask for this, you can ignore this email. Nobody can sign in without the code.</p>`;
  return { subject: 'Your Exam App sign-in code', text, html };
}

/**
 * Sends sign-in codes by email through Resend's HTTP API (no SDK dependency). It only ever logs the
 * masked address and an HTTP status: never the code, the full address, the API key or the response body.
 */
export class EmailOtpSender implements OtpSender {
  private readonly logger = new Logger(EmailOtpSender.name);
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly config: EmailOtpSenderConfig) {
    this.timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  async send(kind: IdentityKind, to: string, code: string): Promise<void> {
    if (kind !== 'EMAIL') throw new OtpDeliveryError('the email sender cannot deliver to a phone number');
    const masked = maskIdentifier(kind, to);
    const message = buildSignInEmail(code);
    let response: Response;
    try {
      response = await this.fetchImpl(RESEND_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.config.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: this.config.from, to: [to], ...message }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? 'timed out' : 'network error';
      this.logger.error(`sign-in email to ${masked} failed: ${reason}`);
      throw new OtpDeliveryError(`email provider ${reason}`);
    }
    if (!response.ok) {
      this.logger.error(`sign-in email to ${masked} rejected by the provider (HTTP ${response.status})`);
      throw new OtpDeliveryError(`email provider rejected the request (HTTP ${response.status})`);
    }
  }
}

/** Phone codes have no provider yet. Refusing is honest: the person is told it failed and can use email. */
export class UnavailablePhoneOtpSender implements OtpSender {
  async send(): Promise<void> {
    throw new OtpDeliveryError('phone (SMS) sign-in is not available yet');
  }
}

/** Sends each kind of identifier through its own sender. */
export class RoutingOtpSender implements OtpSender {
  constructor(
    private readonly email: OtpSender,
    private readonly phone: OtpSender,
  ) {}
  send(kind: IdentityKind, identifierNormalized: string, code: string): Promise<void> {
    return (kind === 'EMAIL' ? this.email : this.phone).send(kind, identifierNormalized, code);
  }
}

type Env = Record<string, string | undefined>;

/**
 * Chooses the sender from the environment, and fails at STARTUP (not at the first sign-in) when
 * the configuration is unsafe.
 *  - EMAIL_PROVIDER=resend needs RESEND_API_KEY and EMAIL_FROM.
 *  - EMAIL_PROVIDER=console writes codes to the server log: development only, refused in production.
 *  - Unset: console outside production, resend in production (so forgetting is loud).
 */
export function createOtpSender(env: Env = process.env, fetchImpl?: typeof fetch): OtpSender {
  const production = env.NODE_ENV === 'production';
  const provider = (env.EMAIL_PROVIDER ?? (production ? 'resend' : 'console')).toLowerCase();

  if (provider === 'console') {
    if (production) throw new Error('EMAIL_PROVIDER=console is not allowed in production');
    const dev = new ConsoleOtpSender();
    return new RoutingOtpSender(dev, dev);
  }
  if (provider === 'resend') {
    const apiKey = (env.RESEND_API_KEY ?? '').trim();
    const from = (env.EMAIL_FROM ?? '').trim();
    if (apiKey === '') throw new Error('RESEND_API_KEY must be set when EMAIL_PROVIDER=resend');
    if (from === '') throw new Error('EMAIL_FROM must be set when EMAIL_PROVIDER=resend');
    if (/[\r\n]/.test(from) || !from.includes('@')) throw new Error('EMAIL_FROM must be an address, e.g. "Exam App <signin@example.com>"');
    const email = new EmailOtpSender({ apiKey, from, fetchImpl });
    return new RoutingOtpSender(email, production ? new UnavailablePhoneOtpSender() : new ConsoleOtpSender());
  }
  throw new Error(`EMAIL_PROVIDER must be "resend" or "console" (got "${provider}")`);
}
