import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ExamController } from './exam.controller';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from './exam.errors';

const ID = '11111111-2222-4333-8444-555555555555';
const req: any = { accountId: 'acct' };

function make() {
  const exam: any = {
    listUnits: jest.fn().mockResolvedValue([]),
    listMine: jest.fn().mockResolvedValue([]),
    create: jest.fn().mockResolvedValue({ assessmentId: ID, resumed: false }),
    present: jest.fn().mockResolvedValue({}),
    lock: jest.fn().mockResolvedValue({ locked: true }),
    skip: jest.fn().mockResolvedValue({ skipped: true }),
    reviewSkipped: jest.fn().mockResolvedValue({ ok: true }),
    submit: jest.fn().mockResolvedValue({ submitted: true }),
    result: jest.fn().mockResolvedValue({}),
  };
  return { exam, controller: new ExamController(exam) };
}

describe('ExamController input checks', () => {
  it('create needs a UUID subject and a mode', async () => {
    const { controller, exam } = make();
    await expect(controller.create(req, { subjectVersionId: 'x', mode: 'TEST' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.create(req, { subjectVersionId: ID })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.create(req, null)).rejects.toBeInstanceOf(BadRequestException);
    await controller.create(req, { subjectVersionId: ID, mode: 'PRACTICE' });
    expect(exam.create).toHaveBeenCalledWith('acct', { subjectVersionId: ID, mode: 'PRACTICE' });
  });
  it('create passes a well-formed blueprint code and refuses a bad one', async () => {
    const { controller, exam } = make();
    await expect(controller.create(req, { subjectVersionId: ID, mode: 'TEST', blueprint: 'quick10' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.create(req, { subjectVersionId: ID, mode: 'TEST', blueprint: 7 })).rejects.toBeInstanceOf(BadRequestException);
    await controller.create(req, { subjectVersionId: ID, mode: 'TEST', blueprint: 'SUBJECT20' });
    expect(exam.create).toHaveBeenCalledWith('acct', { subjectVersionId: ID, mode: 'TEST', blueprint: 'SUBJECT20' });
  });
  it('rejects a malformed assessment id on every route', async () => {
    const { controller } = make();
    await expect(controller.present(req, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.submit(req, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.result(req, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.reviewSkipped(req, 'nope')).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.skip(req, 'nope', '1', {})).rejects.toBeInstanceOf(BadRequestException);
  });
  it('lock validates position, slot and key', async () => {
    const { controller, exam } = make();
    const ok = { slot: 2, activeMs: 1234, idempotencyKey: 'abcdefgh12' };
    await expect(controller.lock(req, ID, 'x', ok)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '123', ok)).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '1', { ...ok, slot: 4 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '1', { ...ok, slot: -1 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '1', { ...ok, slot: 1.5 })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '1', { ...ok, slot: '1' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '1', { ...ok, idempotencyKey: 'short' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(controller.lock(req, ID, '1', { ...ok, idempotencyKey: 'has space in it!' })).rejects.toBeInstanceOf(BadRequestException);
    expect(exam.lock).not.toHaveBeenCalled();
    await controller.lock(req, ID, '3', ok);
    expect(exam.lock).toHaveBeenCalledWith('acct', ID, 3, { slot: 2, activeMs: 1234, idempotencyKey: 'abcdefgh12' });
  });
  it('skip passes the position and active time', async () => {
    const { controller, exam } = make();
    await controller.skip(req, ID, '4', { activeMs: 9 });
    expect(exam.skip).toHaveBeenCalledWith('acct', ID, 4, { activeMs: 9 });
  });
});

describe('ExamController error mapping', () => {
  const cases: Array<[Error, new (...a: any[]) => Error]> = [
    [new ExamNotFoundError('x'), NotFoundException],
    [new ExamNotPermittedError('x'), ForbiddenException],
    [new ExamConflictError('x'), ConflictException],
    [new ExamUnavailableError('x'), ConflictException],
    [new ExamInputError('x'), BadRequestException],
    [Object.assign(new Error('dup'), { code: 'P2002' }), ConflictException],
  ];
  it.each(cases)('maps %s', async (error, expected) => {
    const { controller, exam } = make();
    exam.present.mockRejectedValue(error);
    await expect(controller.present(req, ID)).rejects.toBeInstanceOf(expected);
  });
  it('lets unexpected errors through', async () => {
    const { controller, exam } = make();
    exam.units = undefined;
    exam.listUnits.mockRejectedValue(new Error('boom'));
    await expect(controller.units(req)).rejects.toThrow('boom');
  });
});
