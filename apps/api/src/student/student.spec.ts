import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import type { DatabaseService } from '../database/database.service';
import type { OutboxService } from '../outbox/outbox.service';
import type { PrivacyService } from '../privacy/privacy.service';
import { InvalidDateOfBirthError } from '../privacy/age-classification';
import { SessionGuard } from './session.guard';
import { StudentController, parseIsoDate } from './student.controller';
import { GuardianConsentRequiredError, StudentNotFoundError, StudentService } from './student.service';

function ctx(headers: Record<string, string>) {
  const req: any = { headers };
  return { req, ec: { switchToHttp: () => ({ getRequest: () => req }) } as any };
}

describe('SessionGuard', () => {
  const tok = 'A'.repeat(43);
  const mk = (result: unknown) =>
    new SessionGuard({ authenticate: jest.fn().mockResolvedValue(result) } as any);

  it.each([[{}], [{ authorization: 'Basic abc' }], [{ authorization: 'Bearer short' }]])(
    'rejects a missing or malformed header %p',
    async (h) => {
      await expect(mk({ accountId: 'a' }).canActivate(ctx(h as any).ec)).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );
  it('rejects a token the identity service does not recognise', async () => {
    await expect(mk(null).canActivate(ctx({ authorization: `Bearer ${tok}` }).ec)).rejects.toBeInstanceOf(UnauthorizedException);
  });
  it('sets accountId from the session, never from the request', async () => {
    const { req, ec } = ctx({ authorization: `Bearer ${tok}`, 'x-account-id': 'attacker' });
    await mk({ accountId: 'real', sessionId: 's' }).canActivate(ec);
    expect(req.accountId).toBe('real');
  });
});

describe('parseIsoDate', () => {
  it('parses a real date as UTC midnight', () => {
    expect(parseIsoDate('2013-02-28').toISOString()).toBe('2013-02-28T00:00:00.000Z');
  });
  it.each([['2013-02-30'], ['2013-13-01'], ['13-02-2013'], ['2013-2-3'], [''], [20130101], [null]])(
    'rejects %p',
    (v) => expect(() => parseIsoDate(v)).toThrow(BadRequestException),
  );
});

function makeService() {
  const client: any = {
    account_student_access: { findFirst: jest.fn(), create: jest.fn() },
    student: { create: jest.fn().mockResolvedValue({ id: 'st1' }), update: jest.fn(), findUnique: jest.fn().mockResolvedValue({ display_name: null }) },
  };
  client.$transaction = jest.fn((cb: any) => cb(client));
  const privacy = {
    recordAgeClassification: jest.fn(),
    getClassificationSummary: jest.fn().mockResolvedValue({ classified: false, requiresGuardianConsent: true, basis: null }),
    reclassifyIfStale: jest.fn().mockResolvedValue(undefined),
  };
  const outbox = { publish: jest.fn() };
  const service = new StudentService({ client } as unknown as DatabaseService, privacy as unknown as PrivacyService, outbox as unknown as OutboxService);
  return { client, privacy, outbox, service };
}

describe('StudentService', () => {
  it('createOwnProfile is idempotent per account', async () => {
    const { client, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st-existing' });
    const out = await service.createOwnProfile('acct');
    expect(out.studentId).toBe('st-existing');
    expect(client.student.create).not.toHaveBeenCalled();
  });

  it('createOwnProfile creates a student with SELF access and an event', async () => {
    const { client, outbox, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue(null);
    await service.createOwnProfile('acct');
    expect(client.account_student_access.create.mock.calls[0][0].data).toMatchObject({ account_id: 'acct', access_kind: 'SELF' });
    expect(outbox.publish).toHaveBeenCalledTimes(1);
  });

  it('every operation requires the account to own a student', async () => {
    const { client, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue(null);
    await expect(service.getOwnProfile('acct')).rejects.toBeInstanceOf(StudentNotFoundError);
    await expect(service.setDateOfBirth('acct', new Date())).rejects.toBeInstanceOf(StudentNotFoundError);
    await expect(service.setDisplayName('acct', 'Asha')).rejects.toBeInstanceOf(StudentNotFoundError);
  });

  it('setDateOfBirth hands the DOB to privacy and does not return it', async () => {
    const { client, privacy, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    const dob = new Date('2013-05-01T00:00:00Z');
    const out = await service.setDateOfBirth('acct', dob);
    expect(privacy.recordAgeClassification).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'st1', dateOfBirth: dob, jurisdictionCode: 'AE' }));
    expect(JSON.stringify(out)).not.toContain('2013');
  });

  it('setDisplayName is refused while guardian consent is required, and stores nothing', async () => {
    const { client, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    await expect(service.setDisplayName('acct', 'Asha')).rejects.toBeInstanceOf(GuardianConsentRequiredError);
    expect(client.student.update).not.toHaveBeenCalled();
  });

  it('setDisplayName stores a normalised name once consent is not required', async () => {
    const { client, privacy, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    privacy.getClassificationSummary.mockResolvedValue({ classified: true, requiresGuardianConsent: false, basis: 'POLICY' });
    await service.setDisplayName('acct', '  Asha   Rao ');
    expect(client.student.update).toHaveBeenCalledWith({ where: { id: 'st1' }, data: { display_name: 'Asha Rao' } });
  });

  it.each([[''], ['<script>'], ['x'.repeat(61)], ['123']])('rejects display name %p', async (n) => {
    const { client, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    await expect(service.setDisplayName('acct', n)).rejects.toThrow();
  });

  it('studentIdForDataCollection fails closed while guardian consent is required', async () => {
    const { client, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    await expect(service.studentIdForDataCollection('acct')).rejects.toBeInstanceOf(GuardianConsentRequiredError);
  });

  it('studentIdForDataCollection returns the student once consent is not required', async () => {
    const { client, privacy, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    privacy.getClassificationSummary.mockResolvedValue({ classified: true, requiresGuardianConsent: false, basis: 'POLICY' });
    await expect(service.studentIdForDataCollection('acct')).resolves.toBe('st1');
  });

  it('calls reclassifyIfStale on every profile view', async () => {
    const { client, privacy, service } = makeService();
    client.account_student_access.findFirst.mockResolvedValue({ student_id: 'st1' });
    await service.getOwnProfile('acct');
    expect(privacy.reclassifyIfStale).toHaveBeenCalledWith('st1', expect.any(String));
  });
});

describe('StudentController error mapping', () => {
  const svc: any = {};
  const c = new StudentController(svc);
  const req: any = { accountId: 'a' };

  it('maps domain errors to HTTP', async () => {
    svc.setDisplayName = jest.fn().mockRejectedValue(new GuardianConsentRequiredError());
    await expect(c.name(req, { displayName: 'Asha' })).rejects.toBeInstanceOf(ForbiddenException);
    svc.setDateOfBirth = jest.fn().mockRejectedValue(new InvalidDateOfBirthError('future'));
    await expect(c.dob(req, { dateOfBirth: '2013-01-01' })).rejects.toBeInstanceOf(BadRequestException);
  });
  it('rejects non-object bodies', async () => {
    await expect(c.dob(req, 'x')).rejects.toBeInstanceOf(BadRequestException);
  });
});
