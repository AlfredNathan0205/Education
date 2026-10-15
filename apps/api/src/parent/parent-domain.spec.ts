import {
  CLAIM_V1,
  activityOf,
  claimText,
  evaluateClaims,
  labelCounts,
  needsNewVersion,
  parseClaimPolicy,
  weekOf,
  type ObjectiveInput,
  type ObjectiveSnapshot,
} from './parent-domain';
import { MAX_VIEWERS, shareRefusal } from './parent-sharing-domain';

const BANDS = { strong: 85, developing: 55 };
const snap = (label: ObjectiveSnapshot['label'], mastery: number, reportable = label !== 'BUILDING_EVIDENCE' && label !== 'NOT_STARTED', evidenceCount = 8): ObjectiveSnapshot => ({
  label,
  mastery,
  reportable,
  evidenceCount,
});
const obj = (path: string, end: ObjectiveSnapshot, start: ObjectiveSnapshot | null = null, periodSessions = 1): ObjectiveInput => ({ subjectId: 'chem', path, start, end, periodSessions });

describe('evaluateClaims', () => {
  it('a strength is only a STRONG label; a high score below the strong gate is refused, with the reason', () => {
    const r = evaluateClaims([obj('a', snap('STRONG', 0.93)), obj('b', snap('SECURE', 0.9)), obj('c', snap('BUILDING_EVIDENCE', 0.95))], CLAIM_V1, BANDS);
    expect(r.strengths.map((c) => c.path)).toEqual(['a']);
    expect(r.suppressed).toEqual(
      expect.arrayContaining([
        { kind: 'STRENGTH', subjectId: 'chem', path: 'b', reason: 'STRONG_GATE_NOT_MET' },
        { kind: 'STRENGTH', subjectId: 'chem', path: 'c', reason: 'STRONG_GATE_NOT_MET' },
      ]),
    );
  });

  it('a focus area is only a NEEDS_ATTENTION label: one bad test (below the weak gate) is refused, never claimed', () => {
    const r = evaluateClaims([obj('a', snap('NEEDS_ATTENTION', 0.2)), obj('b', snap('BUILDING_EVIDENCE', 0.1, false, 3))], CLAIM_V1, BANDS);
    expect(r.focus.map((c) => [c.path, c.label, c.template])).toEqual([['a', 'NEEDS_ATTENTION', 'FOCUS_V1']]);
    expect(r.suppressed).toContainEqual({ kind: 'FOCUS', subjectId: 'chem', path: 'b', reason: 'WEAK_GATE_NOT_MET' });
  });

  it('an improvement needs a gated label at both ends, a rise, and evidence in the period', () => {
    const r = evaluateClaims(
      [
        obj('up', snap('DEVELOPING', 0.6), snap('NEEDS_ATTENTION', 0.3)),
        obj('same', snap('SECURE', 0.75), snap('SECURE', 0.72)),
        obj('down', snap('DEVELOPING', 0.6), snap('SECURE', 0.75)),
        obj('new', snap('SECURE', 0.75), snap('BUILDING_EVIDENCE', 0.7, false, 2)),
        obj('quiet', snap('SECURE', 0.75), snap('DEVELOPING', 0.6), 0),
      ],
      CLAIM_V1,
      BANDS,
    );
    expect(r.improvements).toEqual([{ kind: 'IMPROVEMENT', subjectId: 'chem', path: 'up', label: 'DEVELOPING', fromLabel: 'NEEDS_ATTENTION', template: 'IMPROVEMENT_V1' }]);
    expect(r.suppressed).toEqual(
      expect.arrayContaining([
        { kind: 'IMPROVEMENT', subjectId: 'chem', path: 'new', reason: 'NO_EARLIER_CLAIM' },
        { kind: 'IMPROVEMENT', subjectId: 'chem', path: 'quiet', reason: 'TREND_GATE_NOT_MET' },
      ]),
    );
    // A fall is never an improvement, and is not a claim of its own either.
    expect(JSON.stringify(r)).not.toContain('"down"');
  });

  it('caps each list and records what was left out', () => {
    const many = Array.from({ length: 7 }, (_, i) => obj(`s${i}`, snap('STRONG', 0.86 + i / 100)));
    const r = evaluateClaims(many, CLAIM_V1, BANDS);
    expect(r.strengths).toHaveLength(5);
    // Highest mastery first.
    expect(r.strengths[0].path).toBe('s6');
    expect(r.suppressed.filter((s) => s.reason === 'OVER_LIMIT').map((s) => s.path).sort()).toEqual(['s0', 's1']);
  });

  it('says nothing about an objective with no evidence', () => {
    expect(evaluateClaims([obj('a', snap('NOT_STARTED', 0.5, false, 0))], CLAIM_V1, BANDS)).toEqual({ strengths: [], focus: [], improvements: [], suppressed: [] });
  });
});

describe('wording and facts', () => {
  it('fills the fixed templates and nothing else', () => {
    expect(claimText({ template: 'STRENGTH_V1', label: 'STRONG', fromLabel: null }, 'Balance an equation')).toBe('Shows strong understanding: Balance an equation');
    expect(claimText({ template: 'FOCUS_V1', label: 'NEEDS_ATTENTION', fromLabel: null }, 'X')).toBe('Worth more practice: X');
    expect(claimText({ template: 'IMPROVEMENT_V1', label: 'SECURE', fromLabel: 'DEVELOPING' }, 'X')).toBe('Moved from developing to secure: X');
  });

  it('counts labels', () => {
    expect(labelCounts(['STRONG', 'STRONG', 'BUILDING_EVIDENCE'])).toMatchObject({ STRONG: 2, BUILDING_EVIDENCE: 1, SECURE: 0 });
  });

  it('activity: tests and practice, questions answered, active days in India time', () => {
    const a = activityOf(
      [
        { mode: 'TEST', submittedAt: new Date('2026-10-12T18:00:00Z'), answered: 10 }, // 23:30 IST Monday
        { mode: 'TEST', submittedAt: new Date('2026-10-12T19:00:00Z'), answered: 9 }, // 00:30 IST Tuesday
        { mode: 'PRACTICE', submittedAt: new Date('2026-10-13T05:00:00Z'), answered: 10 },
      ],
      330,
    );
    expect(a).toEqual({ tests: 2, practice: 1, questionsAnswered: 29, activeDays: 2 });
  });

  it('weeks run Monday to Monday in India time', () => {
    const w = weekOf(new Date('2026-10-15T10:00:00Z'), 330);
    expect(w.start.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    expect(w.end.toISOString()).toBe('2026-10-18T18:30:00.000Z');
  });

  it('a correction after the latest version, to a test before the week ended, needs a new version', () => {
    const gen = new Date('2026-10-19T00:00:00Z');
    const end = new Date('2026-10-18T18:30:00Z');
    expect(needsNewVersion(gen, [{ at: new Date('2026-10-20T00:00:00Z'), sessionSubmittedAt: new Date('2026-10-14T00:00:00Z') }], end)).toBe(true);
    expect(needsNewVersion(gen, [{ at: new Date('2026-10-20T00:00:00Z'), sessionSubmittedAt: new Date('2026-10-19T00:00:00Z') }], end)).toBe(false);
    expect(needsNewVersion(gen, [{ at: new Date('2026-10-18T00:00:00Z'), sessionSubmittedAt: new Date('2026-10-14T00:00:00Z') }], end)).toBe(false);
  });
});

describe('the claim policy', () => {
  it('parses CLAIM_V1 and refuses broken params', () => {
    expect(parseClaimPolicy(JSON.parse(JSON.stringify(CLAIM_V1)))).toEqual(CLAIM_V1);
    expect(() => parseClaimPolicy({ ...CLAIM_V1, templates: { ...CLAIM_V1.templates, FOCUS: 'MADE_UP' } })).toThrow();
    expect(() => parseClaimPolicy({ ...CLAIM_V1, limits: { strengths: -1, focus: 3, improvements: 5 } })).toThrow();
  });

  it('in the migration SQL is exactly CLAIM_V1 in code', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { readFileSync } = require('node:fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { join } = require('node:path');
    const sql: string = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-017_PARENT_MIGRATION_EXTRA.sql'), 'utf8');
    const m = /'CLAIM_V1', 'ACTIVE',\s*'(\{.*?\})'::jsonb/s.exec(sql);
    expect(m).not.toBeNull();
    expect(JSON.parse(m![1])).toEqual(CLAIM_V1);
  });
});

describe('sharing', () => {
  const base = { classified: true, requiresGuardianConsent: false, activeViewers: 0, pendingInvitations: 0, ownAddress: false, alreadySharedWithAddress: false };
  it('adults may share; minors (and the unclassified) may not', () => {
    expect(shareRefusal(base)).toBeNull();
    expect(shareRefusal({ ...base, requiresGuardianConsent: true })).toBe('MINOR');
    expect(shareRefusal({ ...base, classified: false })).toBe('NOT_CLASSIFIED');
  });
  it('not with yourself, not twice, and at most a few people', () => {
    expect(shareRefusal({ ...base, ownAddress: true })).toBe('OWN_ADDRESS');
    expect(shareRefusal({ ...base, alreadySharedWithAddress: true })).toBe('ALREADY_SHARED');
    expect(shareRefusal({ ...base, activeViewers: MAX_VIEWERS })).toBe('TOO_MANY_VIEWERS');
  });
});
