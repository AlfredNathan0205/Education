import { Injectable } from '@nestjs/common';
import { AuthzService } from '../authz/authz.service';
import { pickRole } from '../authz/roles';
import { CurriculumForbiddenError } from './curriculum.errors';
import { CurriculumService, type SubjectVersionKey } from './curriculum.service';
import { allowedRolesFor, type CurriculumActor, type CurriculumRole, type CurriculumState } from './curriculum-state';
import type { CurriculumTree } from './curriculum-validation';

const EDIT: CurriculumRole[] = ['EDITOR', 'SUPER_ADMIN'];
const VERIFY: CurriculumRole[] = ['REVIEWER', 'APPROVER', 'SUPER_ADMIN'];
const APPROVE: CurriculumRole[] = ['APPROVER', 'SUPER_ADMIN'];

/**
 * Account-based entry point to curriculum governance, and the one to expose over HTTP
 * later. The caller supplies only a session-authenticated account id; the role is looked
 * up from role_assignment for every call, so a request can never assert its own role.
 * The state machine still enforces what each role may do.
 */
@Injectable()
export class CurriculumAdminService {
  constructor(
    private readonly curriculum: CurriculumService,
    private readonly authz: AuthzService,
  ) {}

  createSubjectVersion(accountId: string, key: SubjectVersionKey) {
    return this.as(accountId, EDIT, (a) => this.curriculum.createSubjectVersion(key, a));
  }
  createCorrectionRevision(accountId: string, sourceId: string) {
    return this.as(accountId, EDIT, (a) => this.curriculum.createCorrectionRevision(sourceId, a));
  }
  addEvidenceReference(accountId: string, id: string, ref: Parameters<CurriculumService['addEvidenceReference']>[1]) {
    return this.as(accountId, EDIT, (a) => this.curriculum.addEvidenceReference(id, ref, a));
  }
  replaceContent(accountId: string, id: string, tree: CurriculumTree) {
    return this.as(accountId, EDIT, (a) => this.curriculum.replaceContent(id, tree, a));
  }
  verifyEvidencePack(accountId: string, id: string, note: string) {
    return this.as(accountId, VERIFY, (a) => this.curriculum.verifyEvidencePack(id, note, a));
  }
  approve(accountId: string, id: string, note: string | null = null) {
    return this.as(accountId, APPROVE, (a) => this.curriculum.approve(id, a, note));
  }
  activate(accountId: string, id: string) {
    return this.as(accountId, APPROVE, (a) => this.curriculum.activate(id, a));
  }

  /** Request validation: moves to VALIDATION_PENDING as the editor, then the system validates. */
  async submitForValidation(accountId: string, id: string) {
    await this.transition(accountId, id, 'VALIDATION_PENDING');
    return this.curriculum.runValidation(id);
  }

  /** Other workflow steps. The role used is whichever held role the state machine allows for this step. */
  async transition(accountId: string, id: string, to: CurriculumState, note: string | null = null) {
    const from = await this.curriculum.getState(id);
    return this.as(accountId, allowedRolesFor(from, to), (a) => this.curriculum.transition(id, to, a, note));
  }

  private async as<T>(accountId: string, allowed: readonly CurriculumRole[], fn: (actor: CurriculumActor) => Promise<T>): Promise<T> {
    const held = await this.authz.curriculumRolesFor(accountId);
    const role = pickRole(held, allowed);
    if (role === null) throw new CurriculumForbiddenError('your account does not hold a role that permits this action');
    return fn({ kind: 'HUMAN', accountId, role });
  }
}
