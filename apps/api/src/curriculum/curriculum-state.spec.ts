import {
  CurriculumTransitionError,
  assertTransition,
  canEditContent,
  stateAfterEdit,
  type CurriculumActor,
  type CurriculumRole,
} from './curriculum-state';

const human = (role: CurriculumRole): CurriculumActor => ({ kind: 'HUMAN', accountId: 'a1', role });
const ai: CurriculumActor = { kind: 'AI', accountId: null, role: 'AI_RESEARCH' };
const system: CurriculumActor = { kind: 'SYSTEM', accountId: null, role: null };

describe('assertTransition', () => {
  it('walks the happy path with the right actors', () => {
    expect(() => assertTransition('DISCOVERED', 'EVIDENCE_COLLECTION', ai)).not.toThrow();
    expect(() => assertTransition('EVIDENCE_COLLECTION', 'DRAFT', ai)).not.toThrow();
    expect(() => assertTransition('DRAFT', 'VALIDATION_PENDING', human('EDITOR'))).not.toThrow();
    expect(() => assertTransition('VALIDATION_PENDING', 'VALIDATED', system)).not.toThrow();
    expect(() => assertTransition('VALIDATED', 'ADMIN_REVIEW', human('REVIEWER'))).not.toThrow();
    expect(() => assertTransition('ADMIN_REVIEW', 'APPROVED', human('APPROVER'))).not.toThrow();
    expect(() => assertTransition('APPROVED', 'ACTIVE', human('APPROVER'))).not.toThrow();
  });

  it('APPROVED is not ACTIVE: cannot skip activation or approve straight to ACTIVE', () => {
    expect(() => assertTransition('ADMIN_REVIEW', 'ACTIVE', human('SUPER_ADMIN'))).toThrow(
      /not allowed/,
    );
  });

  it('cannot skip automated validation', () => {
    expect(() => assertTransition('DRAFT', 'VALIDATED', human('SUPER_ADMIN'))).toThrow(/not allowed/);
    expect(() => assertTransition('DRAFT', 'ADMIN_REVIEW', human('SUPER_ADMIN'))).toThrow(
      /not allowed/,
    );
  });

  it('only the system produces validation outcomes, and humans cannot', () => {
    expect(() => assertTransition('VALIDATION_PENDING', 'VALIDATED', human('SUPER_ADMIN'))).toThrow(
      /system only/,
    );
    expect(() => assertTransition('DRAFT', 'VALIDATION_PENDING', system)).toThrow(/system cannot/);
  });

  it('an AI actor can never approve or activate', () => {
    expect(() => assertTransition('ADMIN_REVIEW', 'APPROVED', ai)).toThrow(/authorized human/);
    expect(() => assertTransition('APPROVED', 'ACTIVE', ai)).toThrow(/authorized human/);
  });

  it('activation requires an approver or super admin, not editor or reviewer', () => {
    for (const r of ['EDITOR', 'REVIEWER', 'AI_RESEARCH'] as const) {
      expect(() => assertTransition('APPROVED', 'ACTIVE', human(r))).toThrow(/may not perform/);
    }
    expect(() => assertTransition('APPROVED', 'ACTIVE', human('SUPER_ADMIN'))).not.toThrow();
  });

  it('rejects a malformed actor', () => {
    expect(() =>
      assertTransition('APPROVED', 'ACTIVE', { kind: 'HUMAN', accountId: null, role: 'APPROVER' }),
    ).toThrow(/invalid actor/);
    expect(() =>
      assertTransition('DRAFT', 'AI_STRUCTURED', { kind: 'AI', accountId: null, role: 'APPROVER' }),
    ).toThrow(/invalid actor/);
  });

  it('terminal-ish states do not return to work except via the listed paths', () => {
    expect(() => assertTransition('REJECTED', 'DRAFT', human('SUPER_ADMIN'))).toThrow();
    expect(() => assertTransition('SUPERSEDED', 'ACTIVE', human('SUPER_ADMIN'))).toThrow();
    expect(() => assertTransition('ARCHIVED', 'DRAFT', human('SUPER_ADMIN'))).toThrow();
  });

  it('supersession is system-only', () => {
    expect(() => assertTransition('ACTIVE', 'SUPERSEDED', system)).not.toThrow();
    expect(() => assertTransition('ACTIVE', 'SUPERSEDED', human('SUPER_ADMIN'))).toThrow();
  });

  it('throws CurriculumTransitionError', () => {
    expect(() => assertTransition('DRAFT', 'ACTIVE', human('SUPER_ADMIN'))).toThrow(
      CurriculumTransitionError,
    );
  });
});

describe('content editing rules', () => {
  it.each(['VALIDATED', 'ADMIN_REVIEW', 'APPROVED'] as const)(
    'a material edit in %s reopens validation',
    (s) => expect(stateAfterEdit(s)).toBe('VALIDATION_PENDING'),
  );

  it.each(['DRAFT', 'AI_STRUCTURED', 'VALIDATION_PENDING', 'CHANGES_REQUIRED'] as const)(
    'an edit in %s keeps the state',
    (s) => expect(stateAfterEdit(s)).toBe(s),
  );

  it.each([
    'ACTIVE',
    'ACTIVE_WITH_REVIEW',
    'SUSPENDED',
    'SUPERSEDED',
    'ARCHIVED',
    'REJECTED',
    'WITHDRAWN',
    'BLOCKED',
    'DISCOVERED',
    'EVIDENCE_COLLECTION',
  ] as const)('content is immutable in %s', (s) => {
    expect(canEditContent(s)).toBe(false);
    expect(() => stateAfterEdit(s)).toThrow(/immutable|create a new revision/);
  });
});
