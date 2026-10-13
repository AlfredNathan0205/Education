import { buildInvitationEmail, createGuardianMailer, invitationLink, ResendGuardianMailer, webBaseUrl, GuardianMailDeliveryError } from './guardian-mailer';

describe('invitation email', () => {
  const link = 'https://app.example.com/guardian/approve#t=abc';
  it('contains the link and says nothing about the student', () => {
    const m = buildInvitationEmail(link);
    expect(m.text).toContain(link);
    expect(m.html).toContain(link);
    expect(m.subject).not.toMatch(/\d/);
    expect(m.text.toLowerCase()).not.toMatch(/born|age \d|date of birth/);
  });
});

describe('invitationLink / webBaseUrl', () => {
  it('puts the token in the fragment, never the query string', () => {
    const l = invitationLink('https://a.example', 'tok');
    expect(l).toBe('https://a.example/guardian/approve#t=tok');
    expect(l).not.toContain('?');
  });
  it('defaults to localhost in development and is required in production', () => {
    expect(webBaseUrl({})).toBe('http://localhost:3000');
    expect(() => webBaseUrl({ NODE_ENV: 'production' })).toThrow(/WEB_BASE_URL/);
  });
  it('requires https in production and trims trailing slashes', () => {
    expect(() => webBaseUrl({ NODE_ENV: 'production', WEB_BASE_URL: 'http://x.example' })).toThrow(/https/);
    expect(webBaseUrl({ NODE_ENV: 'production', WEB_BASE_URL: 'https://x.example///' })).toBe('https://x.example');
  });
  it('rejects junk and non-http schemes', () => {
    expect(() => webBaseUrl({ WEB_BASE_URL: 'not a url' })).toThrow();
    expect(() => webBaseUrl({ WEB_BASE_URL: 'javascript:alert(1)' })).toThrow();
  });
});

describe('createGuardianMailer', () => {
  it('refuses the console mailer in production', () => {
    expect(() => createGuardianMailer({ NODE_ENV: 'production', EMAIL_PROVIDER: 'console' })).toThrow();
  });
  it('defaults to resend in production and demands its settings', () => {
    expect(() => createGuardianMailer({ NODE_ENV: 'production' })).toThrow(/RESEND_API_KEY/);
    expect(() => createGuardianMailer({ NODE_ENV: 'production', RESEND_API_KEY: 'k' })).toThrow(/EMAIL_FROM/);
  });
  it('uses the console mailer by default in development', () => {
    expect(createGuardianMailer({})).toBeDefined();
  });
});

describe('ResendGuardianMailer', () => {
  const mk = (fetchImpl: any) => new ResendGuardianMailer({ apiKey: 'k', from: 'a@b.co', fetchImpl });
  it('posts to the provider with the recipient', async () => {
    const f = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    await mk(f).sendInvitation('g@x.com', 'https://l');
    expect(JSON.parse(f.mock.calls[0][1].body).to).toEqual(['g@x.com']);
  });
  it('turns a rejection or network failure into a delivery error without leaking the body', async () => {
    await expect(mk(jest.fn().mockResolvedValue({ ok: false, status: 422 })).sendInvitation('g@x.com', 'l')).rejects.toBeInstanceOf(GuardianMailDeliveryError);
    await expect(mk(jest.fn().mockRejectedValue(new Error('boom'))).sendInvitation('g@x.com', 'l')).rejects.toBeInstanceOf(GuardianMailDeliveryError);
  });
});
