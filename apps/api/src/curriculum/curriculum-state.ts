/**
 * Curriculum subject-version lifecycle (docs/architecture/STATE_MACHINES.md).
 * Pure: no I/O. The service applies these rules inside a transaction.
 *
 * Invariants encoded here:
 *  - APPROVED is not ACTIVE; activation is a separate, human-only act.
 *  - Automated validation (SYSTEM) precedes human review.
 *  - An AI actor can only do AI research steps and can never approve or activate.
 *  - ACTIVE content is immutable; any correction is a new revision.
 */

export type CurriculumState =
  | 'DISCOVERED'
  | 'EVIDENCE_COLLECTION'
  | 'DRAFT'
  | 'AI_STRUCTURED'
  | 'VALIDATION_PENDING'
  | 'VALIDATED'
  | 'ADMIN_REVIEW'
  | 'CHANGES_REQUIRED'
  | 'APPROVED'
  | 'ACTIVE'
  | 'ACTIVE_WITH_REVIEW'
  | 'SUSPENDED'
  | 'BLOCKED'
  | 'REJECTED'
  | 'SUPERSEDED'
  | 'ARCHIVED'
  | 'WITHDRAWN';

export type CurriculumRole = 'AI_RESEARCH' | 'EDITOR' | 'REVIEWER' | 'APPROVER' | 'SUPER_ADMIN';
export type ActorKind = 'HUMAN' | 'AI' | 'SYSTEM';

export interface CurriculumActor {
  kind: ActorKind;
  /** Required for HUMAN; null for SYSTEM/AI. */
  accountId: string | null;
  /** Required for HUMAN and AI; ignored for SYSTEM. */
  role: CurriculumRole | null;
}

interface Rule {
  /** Roles allowed to take this step (SYSTEM steps list none: only the system does them). */
  roles: CurriculumRole[];
  /** Only an authorized human may take this step. */
  humanOnly?: boolean;
  /** Only the automated validator may take this step. */
  systemOnly?: boolean;
}

const EDIT: CurriculumRole[] = ['EDITOR', 'SUPER_ADMIN'];
const REVIEW: CurriculumRole[] = ['REVIEWER', 'SUPER_ADMIN'];
const APPROVE: CurriculumRole[] = ['APPROVER', 'SUPER_ADMIN'];
const RESEARCH: CurriculumRole[] = ['AI_RESEARCH', 'EDITOR', 'SUPER_ADMIN'];

const T: Record<string, Rule> = {
  'DISCOVERED>EVIDENCE_COLLECTION': { roles: RESEARCH },
  'EVIDENCE_COLLECTION>DRAFT': { roles: RESEARCH },
  'DRAFT>AI_STRUCTURED': { roles: ['AI_RESEARCH', 'SUPER_ADMIN'] },
  'DRAFT>VALIDATION_PENDING': { roles: EDIT },
  'AI_STRUCTURED>VALIDATION_PENDING': { roles: EDIT },
  'CHANGES_REQUIRED>VALIDATION_PENDING': { roles: EDIT },
  'VALIDATION_PENDING>VALIDATED': { roles: [], systemOnly: true },
  'VALIDATION_PENDING>CHANGES_REQUIRED': { roles: [], systemOnly: true },
  'VALIDATED>ADMIN_REVIEW': { roles: REVIEW, humanOnly: true },
  'ADMIN_REVIEW>CHANGES_REQUIRED': { roles: [...REVIEW, 'APPROVER'], humanOnly: true },
  'ADMIN_REVIEW>REJECTED': { roles: [...REVIEW, 'APPROVER'], humanOnly: true },
  'ADMIN_REVIEW>APPROVED': { roles: APPROVE, humanOnly: true },
  'APPROVED>ACTIVE': { roles: APPROVE, humanOnly: true },
  'ACTIVE>SUPERSEDED': { roles: [], systemOnly: true },
  'ACTIVE_WITH_REVIEW>SUPERSEDED': { roles: [], systemOnly: true },
  'SUSPENDED>SUPERSEDED': { roles: [], systemOnly: true },
  'ACTIVE>ACTIVE_WITH_REVIEW': { roles: [...REVIEW, 'APPROVER'], humanOnly: true },
  'ACTIVE_WITH_REVIEW>ACTIVE': { roles: APPROVE, humanOnly: true },
  'ACTIVE>SUSPENDED': { roles: APPROVE, humanOnly: true },
  'ACTIVE_WITH_REVIEW>SUSPENDED': { roles: APPROVE, humanOnly: true },
  'SUSPENDED>ACTIVE': { roles: APPROVE, humanOnly: true },
  'SUSPENDED>WITHDRAWN': { roles: APPROVE, humanOnly: true },
  'BLOCKED>EVIDENCE_COLLECTION': { roles: ['SUPER_ADMIN'], humanOnly: true },
  'SUPERSEDED>ARCHIVED': { roles: ['SUPER_ADMIN'], humanOnly: true },
  'REJECTED>ARCHIVED': { roles: ['SUPER_ADMIN'], humanOnly: true },
  'WITHDRAWN>ARCHIVED': { roles: ['SUPER_ADMIN'], humanOnly: true },
};

/** Pre-activation states from which work can be withdrawn or blocked. */
const PRE_ACTIVE: CurriculumState[] = [
  'DISCOVERED',
  'EVIDENCE_COLLECTION',
  'DRAFT',
  'AI_STRUCTURED',
  'VALIDATION_PENDING',
  'VALIDATED',
  'ADMIN_REVIEW',
  'CHANGES_REQUIRED',
  'APPROVED',
];
for (const s of PRE_ACTIVE) {
  T[`${s}>WITHDRAWN`] = { roles: EDIT, humanOnly: true };
  T[`${s}>BLOCKED`] = { roles: ['SUPER_ADMIN'], humanOnly: true };
}

export class CurriculumTransitionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CurriculumTransitionError';
  }
}

export function isValidActor(actor: CurriculumActor): boolean {
  if (actor.kind === 'SYSTEM') return actor.accountId === null;
  if (actor.kind === 'AI') return actor.accountId === null && actor.role === 'AI_RESEARCH';
  return actor.accountId !== null && actor.accountId.length > 0 && actor.role !== null;
}

/** Throws CurriculumTransitionError unless `actor` may move `from` -> `to`. */
export function assertTransition(
  from: CurriculumState,
  to: CurriculumState,
  actor: CurriculumActor,
): void {
  const rule = T[`${from}>${to}`];
  if (!rule) throw new CurriculumTransitionError(`transition ${from} -> ${to} is not allowed`);
  if (!isValidActor(actor)) throw new CurriculumTransitionError('invalid actor');

  if (rule.systemOnly) {
    if (actor.kind !== 'SYSTEM') {
      throw new CurriculumTransitionError(`${from} -> ${to} is performed by the system only`);
    }
    return;
  }
  if (actor.kind === 'SYSTEM') {
    throw new CurriculumTransitionError(`the system cannot perform ${from} -> ${to}`);
  }
  if (rule.humanOnly && actor.kind !== 'HUMAN') {
    throw new CurriculumTransitionError(`${from} -> ${to} requires an authorized human`);
  }
  if (actor.role === null || !rule.roles.includes(actor.role)) {
    throw new CurriculumTransitionError(`role ${actor.role} may not perform ${from} -> ${to}`);
  }
}

/** States in which content may be replaced. ACTIVE and later are immutable. */
const EDITABLE: CurriculumState[] = [
  'DRAFT',
  'AI_STRUCTURED',
  'VALIDATION_PENDING',
  'VALIDATED',
  'ADMIN_REVIEW',
  'CHANGES_REQUIRED',
  'APPROVED',
];
/** Editable states whose prior validation is invalidated by an edit. */
const REOPENED_BY_EDIT: CurriculumState[] = ['VALIDATED', 'ADMIN_REVIEW', 'APPROVED'];

export function canEditContent(state: CurriculumState): boolean {
  return EDITABLE.includes(state);
}

/**
 * State after a content edit. A material edit after validation reopens validation
 * (VALIDATED/ADMIN_REVIEW/APPROVED -> VALIDATION_PENDING). Every edit is treated as
 * material: the builder does not decide what is "minor" about syllabus content.
 */
export function stateAfterEdit(state: CurriculumState): CurriculumState {
  if (!canEditContent(state)) {
    throw new CurriculumTransitionError(
      `content is immutable in state ${state}; create a new revision to correct it`,
    );
  }
  return REOPENED_BY_EDIT.includes(state) ? 'VALIDATION_PENDING' : state;
}
