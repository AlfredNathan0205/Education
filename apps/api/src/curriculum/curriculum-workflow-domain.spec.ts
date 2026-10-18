import { workflowActions, type WorkflowFacts } from './curriculum-workflow-domain';

const f = (over: Partial<WorkflowFacts> = {}): WorkflowFacts => ({ state: 'DRAFT', roles: ['EDITOR'], isEditor: true, evidenceCount: 1, evidenceVerified: false, chapters: 3, openSibling: false, ...over });
const allowed = (over: Partial<WorkflowFacts>) => Object.entries(workflowActions(f(over))).filter(([, v]) => v.allowed).map(([k]) => k).sort();

describe('what the curriculum page offers', () => {
  it('an editor with a draft: add evidence, upload, submit, withdraw', () => {
    expect(allowed({})).toEqual(['addEvidence', 'submit', 'uploadContent', 'withdraw']);
  });

  it('an edit after the checks reopens them: the editor can submit again from VALIDATION_PENDING', () => {
    expect(workflowActions(f({ state: 'VALIDATION_PENDING' })).submit).toEqual({ allowed: true });
    expect(workflowActions(f({ state: 'VALIDATION_PENDING', roles: ['REVIEWER'], isEditor: false })).submit).toEqual({ allowed: false, reason: 'Your role cannot submit for validation' });
  });

  it('submitting needs a source and chapters', () => {
    expect(workflowActions(f({ evidenceCount: 0 })).submit).toEqual({ allowed: false, reason: 'Add at least one syllabus source first' });
    expect(workflowActions(f({ chapters: 0 })).submit).toEqual({ allowed: false, reason: 'Upload the chapters first' });
  });

  it('a reviewer verifies evidence and starts the review; an editor cannot', () => {
    expect(allowed({ state: 'VALIDATED', roles: ['REVIEWER'], isEditor: false })).toEqual(['sendToReview', 'verifyEvidence']);
    expect(workflowActions(f({ state: 'VALIDATED' })).sendToReview).toMatchObject({ allowed: false, reason: 'Your role cannot start the review' });
    expect(workflowActions(f({ state: 'VALIDATED', roles: ['REVIEWER'], evidenceVerified: true })).verifyEvidence).toMatchObject({ reason: 'The evidence is already verified' });
  });

  it('in review, an approver approves or sends it back', () => {
    expect(allowed({ state: 'ADMIN_REVIEW', roles: ['APPROVER'], isEditor: false, evidenceVerified: true })).toEqual(['approve', 'requestChanges']);
  });

  it('activation: an approver who did not edit it, with verified evidence', () => {
    const base = { state: 'APPROVED' as const, roles: ['APPROVER' as const], evidenceVerified: true };
    expect(workflowActions(f({ ...base, isEditor: false })).activate).toEqual({ allowed: true });
    expect(workflowActions(f({ ...base, isEditor: true })).activate).toEqual({ allowed: false, reason: 'You edited this revision: an approver who did not edit it must do this' });
    expect(workflowActions(f({ ...base, isEditor: false, evidenceVerified: false })).activate).toEqual({ allowed: false, reason: 'The syllabus evidence must be verified first' });
    expect(workflowActions(f({ ...base, roles: ['EDITOR'], isEditor: false })).activate).toMatchObject({ allowed: false, reason: 'Your role cannot activate' });
    expect(workflowActions(f({ state: 'ADMIN_REVIEW', roles: ['APPROVER'], isEditor: false, evidenceVerified: true })).activate).toMatchObject({ allowed: false });
  });

  it('live: suspend, and start a correction (one at a time); content is locked', () => {
    expect(allowed({ state: 'ACTIVE', roles: ['APPROVER', 'EDITOR'], isEditor: false, evidenceVerified: true })).toEqual(['startCorrection', 'suspend']);
    expect(workflowActions(f({ state: 'ACTIVE', openSibling: true })).startCorrection).toMatchObject({ reason: 'A correction is already being prepared' });
    expect(workflowActions(f({ state: 'ACTIVE' })).uploadContent).toMatchObject({ allowed: false, reason: expect.stringMatching(/start a correction/) });
  });

  it('suspended: resume needs a non-editor approver', () => {
    expect(workflowActions(f({ state: 'SUSPENDED', roles: ['APPROVER'], isEditor: false, evidenceVerified: true })).resume).toEqual({ allowed: true });
    expect(workflowActions(f({ state: 'SUSPENDED', roles: ['APPROVER'], isEditor: true, evidenceVerified: true })).resume).toMatchObject({ allowed: false });
    expect(workflowActions(f({ state: 'SUSPENDED', roles: ['APPROVER'], isEditor: false, evidenceVerified: true })).withdraw).toEqual({ allowed: true });
  });

  it('nothing changes a superseded revision', () => {
    expect(allowed({ state: 'SUPERSEDED', roles: ['SUPER_ADMIN'], isEditor: false, evidenceVerified: true })).toEqual([]);
  });
});
