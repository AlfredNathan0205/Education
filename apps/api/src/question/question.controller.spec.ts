import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { QuestionController, parseQuestionUpload } from './question.controller';
import { QuestionTransitionError } from './question-domain';
import { QuestionConflictError, QuestionForbiddenError, QuestionNotFoundError } from './question.errors';

const UUID = '3f1a2b4c-5d6e-4f70-8a9b-0c1d2e3f4a5b';
const req = { accountId: 'acc' } as any;

describe('parseQuestionUpload', () => {
  it('accepts csv or json text and nothing else', () => {
    expect(parseQuestionUpload({ format: 'csv', text: 'x' })).toEqual({ format: 'csv', text: 'x' });
    expect(() => parseQuestionUpload({ format: 'xml', text: 'x' })).toThrow(BadRequestException);
    expect(() => parseQuestionUpload({ format: 'csv', text: 5 })).toThrow(BadRequestException);
    expect(() => parseQuestionUpload(null)).toThrow(BadRequestException);
  });
});

describe('QuestionController', () => {
  const make = (over: Record<string, jest.Mock> = {}) => {
    const bank = { approve: jest.fn().mockResolvedValue({ state: 'APPROVED' }), list: jest.fn().mockResolvedValue([]), retire: jest.fn(), ...over };
    return { c: new QuestionController(bank as any), bank };
  };

  it('rejects malformed ids and filters', async () => {
    const { c } = make();
    await expect(c.list(req, 'not-a-uuid')).rejects.toBeInstanceOf(BadRequestException);
    expect(() => c.list(req, UUID, 'WEIRD')).toThrow(BadRequestException);
    await expect(c.detail(req, '123')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('approval needs an explicit answerVerified true/false, and passes the signed-in account', async () => {
    const { c, bank } = make();
    expect(() => c.approve(req, UUID, {})).toThrow(BadRequestException);
    expect(() => c.approve(req, UUID, { answerVerified: 'yes' })).toThrow(BadRequestException);
    await c.approve(req, UUID, { answerVerified: true, note: 'ok' });
    expect(bank.approve).toHaveBeenCalledWith('acc', UUID, { answerVerified: true, note: 'ok' });
  });

  it('sending back and retiring need a note field', async () => {
    const { c } = make();
    await expect(c.retire(req, UUID, {})).rejects.toBeInstanceOf(BadRequestException);
    await expect(c.requestChanges(req, UUID, { note: 7 })).rejects.toBeInstanceOf(BadRequestException);
  });

  it.each([
    [new QuestionForbiddenError('no'), ForbiddenException],
    [new QuestionNotFoundError('x'), NotFoundException],
    [new QuestionConflictError('x'), ConflictException],
    [new QuestionTransitionError('x'), ConflictException],
  ])('maps %p to the right HTTP error', async (err, type) => {
    const { c } = make({ list: jest.fn().mockRejectedValue(err) });
    await expect(c.list(req, UUID)).rejects.toBeInstanceOf(type);
  });

  it('lets an unexpected error through', async () => {
    const { c } = make({ list: jest.fn().mockRejectedValue(new Error('boom')) });
    await expect(c.list(req, UUID)).rejects.toThrow('boom');
  });
});
