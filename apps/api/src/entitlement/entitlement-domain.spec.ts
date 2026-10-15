import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  FREE_VALUES,
  UNLIMITED_VALUES,
  dayOf,
  mostGenerous,
  parseBetaUntil,
  parseGrantValue,
  parseValues,
  reportsWithin,
  startRefusal,
  withGrants,
} from './entitlement-domain';

describe('combining plans', () => {
  it('the most generous value wins: unlimited beats a number, true beats false', () => {
    expect(mostGenerous([FREE_VALUES, UNLIMITED_VALUES])).toEqual(UNLIMITED_VALUES);
    expect(mostGenerous([FREE_VALUES, { SELF_TESTS_PER_DAY: 5, LONG_TESTS: false, PARENT_REPORT_WEEKS: 2 }])).toEqual({ SELF_TESTS_PER_DAY: 5, LONG_TESTS: false, PARENT_REPORT_WEEKS: 4 });
  });
  it('a single grant only widens', () => {
    expect(withGrants(FREE_VALUES, [{ key: 'LONG_TESTS', value: true }])).toEqual({ ...FREE_VALUES, LONG_TESTS: true });
    expect(withGrants(FREE_VALUES, [{ key: 'SELF_TESTS_PER_DAY', value: 1 }])).toEqual(FREE_VALUES);
  });
  it('parses plan values and grant values strictly', () => {
    expect(parseValues(FREE_VALUES)).toEqual(FREE_VALUES);
    expect(() => parseValues({ ...FREE_VALUES, LONG_TESTS: 'yes' })).toThrow();
    expect(() => parseValues({ ...FREE_VALUES, CP_BOOST: 2 })).toThrow(/unknown entitlement/);
    expect(parseGrantValue('SELF_TESTS_PER_DAY', null)).toBeNull();
    expect(() => parseGrantValue('LONG_TESTS', 1)).toThrow();
    expect(() => parseGrantValue('SELF_TESTS_PER_DAY', -1)).toThrow();
  });
});

describe('starting a test you chose yourself', () => {
  it('free: three a day, no long tests; unlimited: anything', () => {
    expect(startRefusal(FREE_VALUES, { totalQuestions: 10, startedToday: 2 })).toBeNull();
    expect(startRefusal(FREE_VALUES, { totalQuestions: 10, startedToday: 3 })).toBe('DAILY_LIMIT');
    expect(startRefusal(FREE_VALUES, { totalQuestions: 20, startedToday: 0 })).toBe('LONG_TESTS');
    expect(startRefusal(UNLIMITED_VALUES, { totalQuestions: 25, startedToday: 99 })).toBeNull();
  });
  it('days run midnight to midnight, India time', () => {
    const d = dayOf(new Date('2026-10-15T20:00:00Z')); // 01:30 IST on the 16th
    expect(d.start.toISOString()).toBe('2026-10-15T18:30:00.000Z');
    expect(d.end.toISOString()).toBe('2026-10-16T18:30:00.000Z');
  });
});

describe('report history and the beta date', () => {
  it('keeps the latest N weeks', () => {
    const r = [1, 2, 3, 4, 5].map((n) => ({ id: n, weekStart: new Date(2026, 0, n * 7) }));
    expect(reportsWithin(r, 2).map((x) => x.id)).toEqual([5, 4]);
    expect(reportsWithin(r, null)).toHaveLength(5);
  });
  it('BETA_GRANT_UNTIL: a future date runs to the end of that day (India); unset or past means no grants; malformed fails', () => {
    const now = new Date('2026-10-15T10:00:00Z');
    expect(parseBetaUntil('2027-03-31', now)!.toISOString()).toBe('2027-03-31T18:30:00.000Z');
    expect(parseBetaUntil(undefined, now)).toBeNull();
    expect(parseBetaUntil('2026-01-01', now)).toBeNull();
    expect(() => parseBetaUntil('31/03/2027', now)).toThrow();
  });
});

describe('the seeded plans', () => {
  it('in the migration SQL are exactly the values in code', () => {
    const sql = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-018_ENTITLEMENT_MIGRATION_EXTRA.sql'), 'utf8');
    const values = (code: string) => JSON.parse(new RegExp(`'${code}', '[^']+', 'ACTIVE', (?:TRUE|FALSE),\\s*'(\\{.*?\\})'::jsonb`, 's').exec(sql)![1]);
    expect(values('FREE')).toEqual(FREE_VALUES);
    expect(values('BETA')).toEqual(UNLIMITED_VALUES);
    expect(values('PLUS')).toEqual(UNLIMITED_VALUES);
  });
});

describe('a plan never changes academic truth, CP or privacy (spec regression: "paid entitlement does not alter CP")', () => {
  it('mastery, claims, competition, recommendations, social and privacy code never read entitlements or plans', () => {
    const root = join(__dirname, '..');
    for (const dir of ['mastery', 'competition', 'recommendation', 'social', 'privacy', 'guardian']) {
      for (const f of readdirSync(join(root, dir)).filter((n) => n.endsWith('.ts') && !n.endsWith('.spec.ts'))) {
        const src = readFileSync(join(root, dir, f), 'utf8');
        expect([dir, f, /entitlement|subscription|\bplan\b\./i.test(src)]).toEqual([dir, f, false]);
      }
    }
    // The parent module reads entitlements only for how many weeks of reports may be opened, never for a claim.
    const parent = readFileSync(join(root, 'parent', 'parent-domain.ts'), 'utf8');
    expect(/entitlement/i.test(parent)).toBe(false);
  });
});
