import {
  BadRequestException,
  Body,
  Controller,
  HttpCode,
  Post,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InvalidIdentifierError, type IdentityKind } from './identifier';
import { IdentityService, InvalidOtpError } from './identity.service';
import { OtpDeliveryError } from './otp-sender.port';

const KINDS: readonly IdentityKind[] = ['EMAIL', 'PHONE'];
const CODE_PATTERN = /^\d{6}$/;

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseIdentity(body: Record<string, unknown>): { kind: IdentityKind; identifier: string } {
  const { kind, identifier } = body;
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    throw new BadRequestException('kind must be EMAIL or PHONE');
  }
  if (typeof identifier !== 'string') throw new BadRequestException('identifier must be a string');
  return { kind: kind as IdentityKind, identifier };
}

@Controller('identity')
export class IdentityController {
  constructor(private readonly identity: IdentityService) {}

  /** Always 202 for a well-formed request, whether or not the identity exists. */
  @Post('otp/request')
  @HttpCode(202)
  async requestOtp(@Body() body: unknown): Promise<{ status: 'accepted' }> {
    const { kind, identifier } = parseIdentity(asObject(body));
    try {
      await this.identity.requestOtp(kind, identifier);
    } catch (error) {
      if (error instanceof InvalidIdentifierError) throw new BadRequestException(error.message);
      if (error instanceof OtpDeliveryError) {
        throw new ServiceUnavailableException(
          kind === 'PHONE'
            ? "Phone sign-in isn't available yet. Please use your email address."
            : 'We could not send the code. Please try again in a moment.',
        );
      }
      throw error;
    }
    return { status: 'accepted' };
  }

  @Post('otp/verify')
  @HttpCode(200)
  async verifyOtp(
    @Body() body: unknown,
  ): Promise<{ sessionToken: string; expiresAt: string; isNewAccount: boolean }> {
    const obj = asObject(body);
    const { kind, identifier } = parseIdentity(obj);
    if (typeof obj.code !== 'string' || !CODE_PATTERN.test(obj.code)) {
      throw new BadRequestException('code must be 6 digits');
    }
    try {
      const login = await this.identity.verifyOtp(kind, identifier, obj.code);
      return {
        sessionToken: login.sessionToken,
        expiresAt: login.expiresAt.toISOString(),
        isNewAccount: login.isNewAccount,
      };
    } catch (error) {
      if (error instanceof InvalidIdentifierError) throw new BadRequestException(error.message);
      if (error instanceof InvalidOtpError)
        throw new UnauthorizedException('Invalid or expired code');
      throw error;
    }
  }
}
