import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLIENT_EVENTS,
  SERVER_EVENTS,
  analyticsEnabled,
  analyticsSecret,
  assignVariant,
  cleanProps,
  improvedCount,
  project,
  returnRates,
  sourceRefKey,
  subjectKey,
  suppress,
  validateVariants,
  weekly,
  type Ev,
} from './analytics-domain';

const SECRET = 'x'.repeat(40);

describe('what can be recorded', () => {
  it('pseudonyms are stable, 32 hex characters, and do not contain the id', () => {
    const k = subjectKey('11111111-1111-4111-8111-111111111111', SECRET);
    expect(k).toMatch(/^[0-9a-f]{32}$/);
    expect(subjectKey('11111111-1111-4111-8111-111111111111', SECRET)).toBe(k);
    expect(subjectKey('11111111-1111-4111-8111-111111111111', 'y'.repeat(40))).not.toBe(k);
    expect(k).not.toContain('1111');
  });
  it('de-duplication references are keyed hashes, never the raw id', () => {
    const r = sourceRefKey('00000000-0000-0000-0000-000000000001', SECRET);
    expect(r).toMatch(/^[0-9a-f]{40}$/);
    expect(sourceRefKey('00000000-0000-0000-0000-000000000001', SECRET)).toBe(r);
    expect(r).not.toBe(sourceRefKey('00000000-0000-0000-0000-000000000002', SECRET));
    expect(r).not.toBe(subjectKey('00000000-0000-0000-0000-000000000001', SECRET).padEnd(40, '0'));
  });
  it('props keep only allow-listed keys and shapes: no ids, no text', () => {
    expect(cleanProps('ASSESSMENT_STARTED', { mode: 'TEST', blueprint: 'QUICK10', fromRecommendation: false, studentId: 'abc', note: 'hi' })).toEqual({ mode: 'TEST', blueprint: 'QUICK10', fromRecommendation: false });
    expect(cleanProps('ASSESSMENT_STARTED', { mode: 'test', blueprint: 'quick 10' })).toBeNull();
    expect(cleanProps('QUALIFIED_TEST', { studentId: 'abc' })).toBeNull();
    expect(cleanProps('RESULTS_OPENED', { any: 1 })).toBeNull();
  });
  it('maps outbox events; ignores the rest; a withdrawn analytics consent means forget, a granted one means sign-up', () => {
    expect(project('assessment.started.v1', { studentId: 's', mode: 'PRACTICE', blueprint: 'PRACTICE10', recommendationId: 'r' })).toEqual({ studentId: 's', name: 'ASSESSMENT_STARTED', props: { mode: 'PRACTICE', blueprint: 'PRACTICE10', fromRecommendation: true } });
    expect(project('assessment.submitted.v1', { studentId: 's', mode: 'TEST', reason: 'STUDENT', correct: 7, total: 10 })).toEqual({ studentId: 's', name: 'ASSESSMENT_COMPLETED', props: { mode: 'TEST', reason: 'STUDENT' } });
    expect(project('competition.cp_recorded.v1', { studentId: 's', kind: 'AWARD', amount: 50 })).toMatchObject({ name: 'QUALIFIED_TEST', props: null });
    expect(project('competition.cp_recorded.v1', { studentId: 's', kind: 'ADJUSTMENT' })).toBeNull();
    expect(project('privacy.consent.withdrawn.v1', { studentId: 's', purposeCode: 'PRODUCT_ANALYTICS' })).toBe('FORGET');
    expect(project('privacy.consent.withdrawn.v1', { studentId: 's', purposeCode: 'CORE_SERVICE' })).toBeNull();
    expect(project('privacy.consent.granted.v1', { studentId: 's', purposeCode: 'PRODUCT_ANALYTICS' })).toBe('CONSENTED');
    expect(project('social.friendship_created.v1', { studentId: 's' })).toBeNull();
    expect(project('privacy.age_classification.recorded.v1', { studentId: 's' })).toBeNull();
  });
  it('counts gated label rises only', () => {
    expect(improvedCount([{ before: 'NEEDS_ATTENTION', after: 'DEVELOPING' }, { before: 'BUILDING_EVIDENCE', after: 'SECURE' }, { before: 'SECURE', after: 'DEVELOPING' }, { before: null, after: 'STRONG' }])).toBe(1);
  });
  it('no screen time: no event measures duration or page views', () => {
    for (const n of [...SERVER_EVENTS, ...CLIENT_EVENTS]) expect(n).not.toMatch(/TIME|DURATION|PAGE_VIEW|SESSION_LENGTH|SCROLL/);
  });
  it('the event lists in the migration SQL are exactly the lists in code', () => {
    const sql = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-019_ANALYTICS_MIGRATION_EXTRA.sql'), 'utf8');
    const list = (source: string) => /"source" = '(?:SERVER|CLIENT)' AND "name" IN \(([^)]*)\)/g;
    const found = [...sql.matchAll(list(''))].map((m) => m[1].split(',').map((x) => x.trim().replace(/'/g, '')));
    expect(found).toEqual([[...SERVER_EVENTS], [...CLIENT_EVENTS]]);
  });
  it('the secret is required in production; the switch parses strictly', () => {
    expect(() => analyticsSecret({ NODE_ENV: 'production' })).toThrow();
    expect(analyticsSecret({ NODE_ENV: 'production', ANALYTICS_PSEUDONYM_KEY: SECRET })).toBe(SECRET);
    expect(analyticsEnabled({})).toBe(true);
    expect(analyticsEnabled({ ANALYTICS_ENABLED: 'false' })).toBe(false);
    expect(() => analyticsEnabled({ ANALYTICS_ENABLED: 'no' })).toThrow();
  });
});

describe('metrics', () => {
  const NOW = new Date('2026-10-15T10:00:00Z'); // this week started 2026-10-11T18:30Z
  const at = (iso: string) => new Date(iso);
  const ev = (subject: string, name: string, iso: string, props?: Record<string, unknown>): Ev => ({ subject, name, at: at(iso), props });

  it('North Star, intensity, completion, activation and the practice loop, by week', () => {
    const events: Ev[] = [
      ev('a', 'SIGNED_UP', '2026-10-12T10:00:00Z'),
      ev('a', 'ASSESSMENT_STARTED', '2026-10-12T11:00:00Z', { mode: 'TEST' }),
      ev('a', 'ASSESSMENT_COMPLETED', '2026-10-12T11:20:00Z', { mode: 'TEST' }),
      ev('a', 'QUALIFIED_TEST', '2026-10-12T11:21:00Z'),
      ev('a', 'RESULTS_OPENED', '2026-10-12T11:22:00Z'),
      ev('a', 'PRACTISE_MISSED_CLICKED', '2026-10-12T11:23:00Z'),
      ev('a', 'ASSESSMENT_STARTED', '2026-10-12T11:23:00Z', { mode: 'PRACTICE', fromRecommendation: true }),
      ev('a', 'QUALIFIED_TEST', '2026-10-13T11:21:00Z'),
      ev('b', 'ASSESSMENT_STARTED', '2026-10-13T09:00:00Z', { mode: 'TEST' }),
      ev('b', 'RECOMMENDATION_COMPLETED', '2026-10-13T10:00:00Z', { kind: 'RETEST' }),
      ev('b', 'MASTERY_UPDATED', '2026-10-13T10:01:00Z', { improvedObjectives: 2 }),
      ev('a', 'PARENT_VIEWED', '2026-10-14T10:00:00Z', { basis: 'GUARDIAN' }),
      ev('c', 'QUALIFIED_TEST', '2026-10-06T10:00:00Z'), // last week
    ];
    const [last, cur] = weekly(events, NOW, 2);
    expect(last).toMatchObject({ activeQualified: 1 });
    expect(cur).toMatchObject({
      weekStart: '2026-10-11T18:30:00.000Z',
      activeQualified: 1,
      intensity: 2,
      started: 3,
      completed: 1,
      completionRate: 0.33,
      signups: 1,
      activated: 1,
      loop: { resultsOpened: 1, practiseMissed: 1, practiceFromRecommendation: 1, retestsCompleted: 1 },
      improvedObjectives: 2,
      parentViews: 1,
      studentsWithParentViews: 1,
    });
  });

  it('D7 return counts only learners old enough to know', () => {
    const events: Ev[] = [
      ev('a', 'ASSESSMENT_COMPLETED', '2026-09-01T10:00:00Z'),
      ev('a', 'ASSESSMENT_COMPLETED', '2026-09-09T10:00:00Z'),
      ev('b', 'ASSESSMENT_COMPLETED', '2026-09-01T10:00:00Z'),
      ev('c', 'ASSESSMENT_COMPLETED', '2026-10-14T10:00:00Z'),
    ];
    expect(returnRates(events, NOW).d7).toEqual({ eligible: 2, returned: 1 });
  });

  it('small groups are hidden', () => {
    expect([0, 1, 4, 5, 12].map(suppress)).toEqual([0, '<5', '<5', 5, 12]);
  });
});

describe('experiments', () => {
  const V = [{ key: 'control', weight: 50, isControl: true }, { key: 'new', weight: 50, isControl: false }];
  it('variants: 2 to 6, valid keys and weights, exactly one control', () => {
    expect(validateVariants(V)).toEqual(V);
    expect(() => validateVariants([V[0]])).toThrow();
    expect(() => validateVariants([V[1], { ...V[1], key: 'b' }])).toThrow(/control/);
    expect(() => validateVariants([V[0], { ...V[1], weight: 0 }])).toThrow();
  });
  it('assignment is stable and roughly follows the weights', () => {
    expect(assignVariant('abc', 'exp', V)).toBe(assignVariant('abc', 'exp', V));
    const n = Array.from({ length: 2000 }, (_, i) => assignVariant(`s${i}`, 'exp', V)).filter((v) => v === 'new').length;
    expect(n).toBeGreaterThan(850);
    expect(n).toBeLessThan(1150);
  });
});
