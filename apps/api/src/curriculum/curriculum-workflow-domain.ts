/**
 * Step 22: what a person may do next with a curriculum revision, from its state, their roles and what the revision
 * holds. Pure. The service still enforces every rule again (the state machine, roles, evidence); this only decides
 * which buttons the admin page offers, and why the others are not offered.
 *
 * PM decision (17 October): activation (and resuming a suspended curriculum, which is an activation) needs an approver
 * who did not edit that revision.
 */
import { allowedRolesFor, canEditContent, type CurriculumRole, type CurriculumState } from './curriculum-state';

export const WORKFLOW_ACTIONS = [
  'addEvidence',
  'uploadContent',
  'verifyEvidence',
  'submit',
  'sendToReview',
  'requestChanges',
  'approve',
  'activate',
  'suspend',
  'resume',
  'startCorrection',
  'withdraw',
] as const;
export type WorkflowAction = (typeof WORKFLOW_ACTIONS)[number];

export const EDIT_ROLES: CurriculumRole[] = ['EDITOR', 'SUPER_ADMIN'];
export const VERIFY_ROLES: CurriculumRole[] = ['REVIEWER', 'APPROVER', 'SUPER_ADMIN'];
const LIVE: CurriculumState[] = ['ACTIVE', 'ACTIVE_WITH_REVIEW', 'SUSPENDED'];
const TERMINAL: CurriculumState[] = ['SUPERSEDED', 'WITHDRAWN', 'ARCHIVED', 'REJECTED'];
/** Events that make a person an editor of a revision (they changed what it says or what it rests on). */
export const EDIT_EVENTS = ['created', 'correction_revision_created', 'evidence_added', 'content_replaced'];
export const MIN_NOTE = 10;

export interface WorkflowFacts {
  state: CurriculumState;
  roles: CurriculumRole[];
  /** This person created, uploaded to or added evidence to this revision. */
  isEditor: boolean;
  evidenceCount: number;
  evidenceVerified: boolean;
  chapters: number;
  /** Another revision of the same subject is still being prepared (only one correction at a time). */
  openSibling: boolean;
}

export type ActionVerdict = { allowed: true } | { allowed: false; reason: string };

const yes: ActionVerdict = { allowed: true };
const no = (reason: string): ActionVerdict => ({ allowed: false, reason });

function byRule(f: WorkflowFacts, to: CurriculumState, what: string): ActionVerdict {
  const roles = allowedRolesFor(f.state, to);
  if (roles.length === 0) return no(`Not possible while the curriculum is ${f.state}`);
  if (!f.roles.some((r) => roles.includes(r))) return no(`Your role cannot ${what}`);
  return yes;
}

export function workflowActions(f: WorkflowFacts): Record<WorkflowAction, ActionVerdict> {
  const has = (roles: CurriculumRole[]) => f.roles.some((r) => roles.includes(r));
  const editable = canEditContent(f.state);
  const notEditor = (v: ActionVerdict): ActionVerdict =>
    v.allowed && f.isEditor ? no('You edited this revision: an approver who did not edit it must do this') : v;
  const needsEvidence = (v: ActionVerdict): ActionVerdict => (v.allowed && !f.evidenceVerified ? no('The syllabus evidence must be verified first') : v);

  return {
    addEvidence: !editable ? no(`Evidence cannot change while the curriculum is ${f.state}: start a correction`) : has(EDIT_ROLES) ? yes : no('Only an editor can add evidence'),
    uploadContent: !editable ? no(`Content cannot change while the curriculum is ${f.state}: start a correction`) : has(EDIT_ROLES) ? yes : no('Only an editor can upload content'),
    verifyEvidence: TERMINAL.includes(f.state)
      ? no(`Not possible while the curriculum is ${f.state}`)
      : f.evidenceCount === 0
        ? no('Add at least one syllabus source first')
        : f.evidenceVerified
          ? no('The evidence is already verified')
          : has(VERIFY_ROLES)
            ? yes
            : no('Only a reviewer or approver can verify evidence'),
    submit: (() => {
      // An edit after the checks reopens a revision at VALIDATION_PENDING: the editor runs the checks again from there.
      const v = f.state === 'VALIDATION_PENDING' ? (has(EDIT_ROLES) ? yes : no('Your role cannot submit for validation')) : byRule(f, 'VALIDATION_PENDING', 'submit for validation');
      if (!v.allowed) return v;
      if (f.evidenceCount === 0) return no('Add at least one syllabus source first');
      if (f.chapters === 0) return no('Upload the chapters first');
      return v;
    })(),
    sendToReview: byRule(f, 'ADMIN_REVIEW', 'start the review'),
    requestChanges: byRule(f, 'CHANGES_REQUIRED', 'send it back'),
    approve: f.state === 'ADMIN_REVIEW' ? byRule(f, 'APPROVED', 'approve') : no(`Not possible while the curriculum is ${f.state}`),
    activate: f.state === 'APPROVED' ? notEditor(needsEvidence(byRule(f, 'ACTIVE', 'activate'))) : no(`Not possible while the curriculum is ${f.state}`),
    suspend: f.state === 'ACTIVE' || f.state === 'ACTIVE_WITH_REVIEW' ? byRule(f, 'SUSPENDED', 'suspend') : no(`Not possible while the curriculum is ${f.state}`),
    resume: f.state === 'SUSPENDED' ? notEditor(needsEvidence(byRule(f, 'ACTIVE', 'resume'))) : no('Only a suspended curriculum can be resumed'),
    startCorrection: !LIVE.includes(f.state)
      ? no('Only a live curriculum is corrected with a new revision (edit this one directly)')
      : f.openSibling
        ? no('A correction is already being prepared')
        : has(EDIT_ROLES)
          ? yes
          : no('Only an editor can start a correction'),
    withdraw: byRule(f, 'WITHDRAWN', 'withdraw it'),
  };
}
