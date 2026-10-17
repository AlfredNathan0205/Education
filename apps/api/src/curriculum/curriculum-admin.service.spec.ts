import { CurriculumForbiddenError } from './curriculum.errors';
import { CurriculumAdminService } from './curriculum-admin.service';

function make(roles: string[], state = 'APPROVED') {
  const curriculum: any = {
    activate: jest.fn().mockResolvedValue(undefined),
    approve: jest.fn().mockResolvedValue(undefined),
    createSubjectVersion: jest.fn().mockResolvedValue({ id: 'x', revision: 1 }),
    verifyEvidencePack: jest.fn().mockResolvedValue(undefined),
    transition: jest.fn().mockResolvedValue(undefined),
    runValidation: jest.fn().mockResolvedValue({ passed: true, findings: [] }),
    getState: jest.fn().mockResolvedValue(state),
  };
  const authz: any = { curriculumRolesFor: jest.fn().mockResolvedValue(roles) };
  return { curriculum, svc: new CurriculumAdminService(curriculum, authz) };
}

describe('CurriculumAdminService (roles come from the database, not the caller)', () => {
  it('refuses an account with no role and never calls the underlying service', async () => {
    const { curriculum, svc } = make([]);
    await expect(svc.activate('acct', 'sv')).rejects.toBeInstanceOf(CurriculumForbiddenError);
    expect(curriculum.activate).not.toHaveBeenCalled();
  });
  it('an editor or reviewer cannot activate', async () => {
    for (const r of [['EDITOR'], ['REVIEWER']]) {
      const { curriculum, svc } = make(r);
      await expect(svc.activate('acct', 'sv')).rejects.toBeInstanceOf(CurriculumForbiddenError);
      expect(curriculum.activate).not.toHaveBeenCalled();
    }
  });
  it('an approver activates as a HUMAN actor carrying the account id and role', async () => {
    const { curriculum, svc } = make(['APPROVER']);
    await svc.activate('acct', 'sv');
    expect(curriculum.activate).toHaveBeenCalledWith('sv', { kind: 'HUMAN', accountId: 'acct', role: 'APPROVER' });
  });
  it('an editor creates; a reviewer cannot', async () => {
    await make(['EDITOR']).svc.createSubjectVersion('a', {} as any);
    await expect(make(['REVIEWER']).svc.createSubjectVersion('a', {} as any)).rejects.toBeInstanceOf(CurriculumForbiddenError);
  });
  it('a reviewer may verify evidence', async () => {
    const { curriculum, svc } = make(['REVIEWER']);
    await svc.verifyEvidencePack('a', 'sv', 'checked');
    expect(curriculum.verifyEvidencePack.mock.calls[0][2].role).toBe('REVIEWER');
  });
  it('transition picks the role the state machine allows for that step', async () => {
    const { curriculum, svc } = make(['EDITOR', 'REVIEWER'], 'VALIDATED');
    await svc.transition('a', 'sv', 'ADMIN_REVIEW');
    expect(curriculum.transition.mock.calls[0][2].role).toBe('REVIEWER');
  });
  it('transition refuses system-only steps for every human', async () => {
    const { svc } = make(['SUPER_ADMIN'], 'VALIDATION_PENDING');
    await expect(svc.transition('a', 'sv', 'VALIDATED')).rejects.toBeInstanceOf(CurriculumForbiddenError);
  });
  it('submitForValidation moves to pending as an editor, then runs the automated validation', async () => {
    const { curriculum, svc } = make(['EDITOR'], 'DRAFT');
    const out = await svc.submitForValidation('a', 'sv');
    expect(curriculum.transition.mock.calls[0][1]).toBe('VALIDATION_PENDING');
    expect(curriculum.runValidation).toHaveBeenCalledWith('sv');
    expect(out.passed).toBe(true);
  });
  it('a revision reopened by an edit (VALIDATION_PENDING) is checked again by an editor, without a transition', async () => {
    const { curriculum, svc } = make(['EDITOR'], 'VALIDATION_PENDING');
    expect((await svc.submitForValidation('a', 'sv')).passed).toBe(true);
    expect(curriculum.transition).not.toHaveBeenCalled();
    expect(curriculum.runValidation).toHaveBeenCalledWith('sv');
    const reviewer = make(['REVIEWER'], 'VALIDATION_PENDING');
    await expect(reviewer.svc.submitForValidation('a', 'sv')).rejects.toBeInstanceOf(CurriculumForbiddenError);
    expect(reviewer.curriculum.runValidation).not.toHaveBeenCalled();
  });
});
