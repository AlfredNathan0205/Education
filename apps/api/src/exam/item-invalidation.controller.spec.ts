import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { ExamConflictError, ExamNotPermittedError } from './exam.errors';
import { ItemInvalidationController } from './item-invalidation.controller';

const ID = '11111111-2222-4333-8444-555555555555';
const req: any = { accountId: 'acct' };

function make() {
  const svc: any = { impact: jest.fn().mockResolvedValue({}), invalidate: jest.fn().mockResolvedValue({}) };
  return { svc, controller: new ItemInvalidationController(svc) };
}

describe('ItemInvalidationController', () => {
  it('checks the id and the reason before doing anything', () => {
    const { controller, svc } = make();
    expect(() => controller.impact(req, 'nope')).toThrow(BadRequestException);
    expect(() => controller.invalidate(req, ID, { reasonCode: 'MADE_UP', note: 'x' })).toThrow(BadRequestException);
    expect(() => controller.invalidate(req, ID, { reasonCode: 'ANSWER_WRONG' })).toThrow(/note must be text/);
    expect(svc.invalidate).not.toHaveBeenCalled();
  });

  it('passes good input and maps errors', async () => {
    const { controller, svc } = make();
    await controller.invalidate(req, ID, { reasonCode: 'ANSWER_WRONG', note: 'The key is wrong here.' });
    expect(svc.invalidate).toHaveBeenCalledWith('acct', ID, { reasonCode: 'ANSWER_WRONG', note: 'The key is wrong here.' });
    svc.invalidate.mockRejectedValueOnce(new ExamNotPermittedError('no'));
    await expect(controller.invalidate(req, ID, { reasonCode: 'ANSWER_WRONG', note: 'x' })).rejects.toBeInstanceOf(ForbiddenException);
    svc.impact.mockRejectedValueOnce(new ExamConflictError('no'));
    await expect(controller.impact(req, ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
