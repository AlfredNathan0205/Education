import { Injectable, Logger } from '@nestjs/common';
import { maskIdentifier, type IdentityKind } from './identifier';

/** Delivers a one-time code. A real email/SMS provider implements this later. */
export interface OtpSender {
  send(kind: IdentityKind, identifierNormalized: string, code: string): Promise<void>;
}

export const OTP_SENDER = Symbol('OTP_SENDER');

/**
 * A code could not be delivered. The message is safe to log: it never contains the code,
 * the address, or the provider's response body.
 */
export class OtpDeliveryError extends Error {
  constructor(message = 'the sign-in code could not be delivered') {
    super(message);
    this.name = 'OtpDeliveryError';
  }
}

/**
 * Development-only sender: writes the code to the server log so the flow can be
 * exercised locally. It refuses to run in production, so a missing provider
 * configuration fails loudly instead of silently logging real users' codes.
 */
@Injectable()
export class ConsoleOtpSender implements OtpSender {
  private readonly logger = new Logger(ConsoleOtpSender.name);

  async send(kind: IdentityKind, identifierNormalized: string, code: string): Promise<void> {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(
        'ConsoleOtpSender must not be used in production: configure a real OtpSender',
      );
    }
    this.logger.warn(
      `[DEV ONLY] code for ${maskIdentifier(kind, identifierNormalized)} is ${code}`,
    );
  }
}
