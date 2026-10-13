import { EmailOtpSender, RoutingOtpSender, UnavailablePhoneOtpSender, buildSignInEmail, createOtpSender } from './email-otp-sender';
import { OtpDeliveryError, type OtpSender } from './otp-sender.port';

const KEY = 're_test_key_123';
const FROM = 'Exam App <signin@example.com>';

function okFetch() {
  return jest.fn().mockResolvedValue({ ok: true, status: 200 } as Response);
}

describe('buildSignInEmail', () => {
  it('puts the code in the body but not the subject, and states the expiry', () => {
    const m = buildSignInEmail('482915');
    expect(m.subject).not.toContain('482915');
    expect(m.text).toContain('482915');
    expect(m.html).toContain('482915');
    expect(m.text).toContain('10 minutes');
  });
});

describe('EmailOtpSender', () => {
  it('posts to the provider with the key in the Authorization header only', async () => {
    const fetchImpl = okFetch();
    await new EmailOtpSender({ apiKey: KEY, from: FROM, fetchImpl }).send('EMAIL', 'student@example.com', '482915');

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.resend.com/emails');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ from: FROM, to: ['student@example.com'], subject: 'Your Exam App sign-in code' });
    expect(init.body).not.toContain(KEY);
  });

  it('throws a delivery error on a provider rejection, without the key, code or address in the message', async () => {
    const fetchImpl = jest.fn().mockResolvedValue({ ok: false, status: 422, text: async () => 'bad student@example.com 482915' } as unknown as Response);
    const err = await new EmailOtpSender({ apiKey: KEY, from: FROM, fetchImpl }).send('EMAIL', 'student@example.com', '482915').catch((e) => e);
    expect(err).toBeInstanceOf(OtpDeliveryError);
    for (const secret of [KEY, '482915', 'student@example.com']) expect(err.message).not.toContain(secret);
    expect(err.message).toContain('422');
  });

  it('throws a delivery error on a network failure and on a timeout', async () => {
    const net = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    await expect(new EmailOtpSender({ apiKey: KEY, from: FROM, fetchImpl: net }).send('EMAIL', 'a@b.co', '111111')).rejects.toThrow(/network error/);

    const timeout = jest.fn().mockRejectedValue(Object.assign(new Error('t'), { name: 'TimeoutError' }));
    await expect(new EmailOtpSender({ apiKey: KEY, from: FROM, fetchImpl: timeout }).send('EMAIL', 'a@b.co', '111111')).rejects.toThrow(/timed out/);
  });

  it('refuses a phone number', async () => {
    const fetchImpl = okFetch();
    await expect(new EmailOtpSender({ apiKey: KEY, from: FROM, fetchImpl }).send('PHONE', '+971501234567', '111111')).rejects.toBeInstanceOf(OtpDeliveryError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('RoutingOtpSender / UnavailablePhoneOtpSender', () => {
  it('sends each kind through its own sender', async () => {
    const email: jest.Mocked<OtpSender> = { send: jest.fn().mockResolvedValue(undefined) };
    const phone: jest.Mocked<OtpSender> = { send: jest.fn().mockResolvedValue(undefined) };
    const r = new RoutingOtpSender(email, phone);
    await r.send('EMAIL', 'a@b.co', '1');
    await r.send('PHONE', '+971501234567', '2');
    expect(email.send).toHaveBeenCalledTimes(1);
    expect(phone.send).toHaveBeenCalledTimes(1);
  });
  it('the unavailable phone sender always fails', async () => {
    await expect(new UnavailablePhoneOtpSender().send()).rejects.toBeInstanceOf(OtpDeliveryError);
  });
});

describe('createOtpSender', () => {
  it('uses the console sender by default outside production', async () => {
    expect(() => createOtpSender({ NODE_ENV: 'development' })).not.toThrow();
  });

  it('refuses the console sender in production', () => {
    expect(() => createOtpSender({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' })).toThrow(/not allowed in production/);
  });

  it('in production with nothing configured, fails at startup asking for the key', () => {
    expect(() => createOtpSender({ NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/);
  });

  it('needs both the key and a sender address for resend', () => {
    expect(() => createOtpSender({ EMAIL_PROVIDER: 'resend', EMAIL_FROM: FROM })).toThrow(/RESEND_API_KEY/);
    expect(() => createOtpSender({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY })).toThrow(/EMAIL_FROM/);
  });

  it('rejects a sender address with a line break (header injection) or no address', () => {
    expect(() => createOtpSender({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'a@b.co\nBcc: x@y.z' })).toThrow(/EMAIL_FROM/);
    expect(() => createOtpSender({ EMAIL_PROVIDER: 'resend', RESEND_API_KEY: KEY, EMAIL_FROM: 'not an address' })).toThrow(/EMAIL_FROM/);
  });

  it('rejects an unknown provider', () => {
    expect(() => createOtpSender({ EMAIL_PROVIDER: 'sendgrid' })).toThrow(/resend/);
  });

  it('with resend in production, email goes to the provider and phone is refused', async () => {
    const fetchImpl = okFetch();
    const sender = createOtpSender({ NODE_ENV: 'production', RESEND_API_KEY: KEY, EMAIL_FROM: FROM }, fetchImpl);
    await sender.send('EMAIL', 'a@b.co', '123456');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await expect(sender.send('PHONE', '+971501234567', '123456')).rejects.toBeInstanceOf(OtpDeliveryError);
  });
});
