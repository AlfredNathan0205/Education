import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { BlueprintInputError } from './blueprint-domain';
import { BlueprintController } from './blueprint.controller';
import { BlueprintConflictError, BlueprintForbiddenError, BlueprintNotFoundError } from './blueprint.errors';

const ID = '11111111-2222-4333-8444-555555555555';
const req: any = { accountId: 'acct' };

function make() {
  const svc: any = {
    list: jest.fn().mockResolvedValue([]),
    detail: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockResolvedValue({}),
    saveDraft: jest.fn().mockResolvedValue({}),
    discardDraft: jest.fn().mockResolvedValue({}),
    publishDraft: jest.fn().mockResolvedValue({}),
    setEnabled: jest.fn().mockResolvedValue({}),
    preview: jest.fn().mockResolvedValue({ ok: true }),
  };
  return { svc, controller: new BlueprintController(svc) };
}

describe('BlueprintController input checks (before any work starts)', () => {
  it('refuses malformed ids and bodies synchronously', () => {
    const { controller, svc } = make();
    expect(() => controller.detail(req, 'nope')).toThrow(BadRequestException);
    expect(() => controller.saveDraft(req, ID, [])).toThrow(BadRequestException);
    expect(() => controller.saveDraft(req, 'nope', {})).toThrow(BadRequestException);
    expect(() => controller.create(req, null)).toThrow(BadRequestException);
    expect(() => controller.enabled(req, ID, { enabled: 'yes' })).toThrow(/enabled must be true or false/);
    expect(() => controller.preview(req, ID, {})).toThrow(/unitId is required/);
    expect(() => controller.preview(req, ID, { unitId: 'x' })).toThrow(BadRequestException);
    expect(() => controller.preview(req, ID, { unitId: ID, seed: 5 })).toThrow(/seed must be text/);
    expect(svc.saveDraft).not.toHaveBeenCalled();
    expect(svc.preview).not.toHaveBeenCalled();
  });

  it('passes good input through', async () => {
    const { controller, svc } = make();
    await controller.enabled(req, ID, { enabled: false });
    expect(svc.setEnabled).toHaveBeenCalledWith('acct', ID, false);
    await controller.preview(req, ID, { unitId: ID, seed: '' });
    expect(svc.preview).toHaveBeenCalledWith('acct', ID, ID, undefined);
    await controller.preview(req, ID, { unitId: ID, seed: 'abc' });
    expect(svc.preview).toHaveBeenLastCalledWith('acct', ID, ID, 'abc');
  });

  it('maps service errors to HTTP errors, listing every design problem', async () => {
    const { controller, svc } = make();
    svc.saveDraft.mockRejectedValueOnce(new BlueprintInputError(['one', 'two']));
    await expect(controller.saveDraft(req, ID, {})).rejects.toThrow('one; two');
    svc.publishDraft.mockRejectedValueOnce(new BlueprintForbiddenError('no'));
    await expect(controller.publish(req, ID)).rejects.toBeInstanceOf(ForbiddenException);
    svc.detail.mockRejectedValueOnce(new BlueprintNotFoundError('blueprint'));
    await expect(controller.detail(req, ID)).rejects.toBeInstanceOf(NotFoundException);
    svc.discardDraft.mockRejectedValueOnce(new BlueprintConflictError('none'));
    await expect(controller.discard(req, ID)).rejects.toBeInstanceOf(ConflictException);
  });
});
