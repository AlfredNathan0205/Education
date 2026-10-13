import { ServiceUnavailableException } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { OtpDeliveryError } from './otp-sender.port';

describe('IdentityController.requestOtp delivery failure', () => {
  const make = () => {
    const identity = { requestOtp: jest.fn().mockRejectedValue(new OtpDeliveryError('x')) };
    return new IdentityController(identity as any);
  };

  it('answers 503 with a retry message for email', async () => {
    const err = await make().requestOtp({ kind: 'EMAIL', identifier: 'a@b.co' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toMatch(/try again/i);
  });

  it('tells a phone user to use email instead', async () => {
    const err = await make().requestOtp({ kind: 'PHONE', identifier: '+971501234567' }).catch((e) => e);
    expect(err).toBeInstanceOf(ServiceUnavailableException);
    expect(err.message).toMatch(/email/i);
  });
});
