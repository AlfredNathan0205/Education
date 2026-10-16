import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEFAULT_RETENTION,
  ERASURE_MAP,
  NOT_EXPORTED,
  STUDENT_EXPORT_TABLES,
  erasureBlock,
  erasureDueAt,
  exportRow,
  maskOther,
  monthsBefore,
  retentionCutoffs,
  retentionPeriods,
  switchOn,
} from './rights-domain';

const SCHEMA = readFileSync(join(__dirname, '../../../../packages/database/prisma/schema.prisma'), 'utf8');
const EXTRA = readFileSync(join(__dirname, '../../../../docs/implementation/CONSTRUCTION-020_SECURITY_MIGRATION_EXTRA.sql'), 'utf8');

function models(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const m of SCHEMA.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    out[m[1]] = m[2].split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//') && !l.startsWith('@@')).map((l) => l.split(/\s+/)[0]);
  }
  return out;
}

describe('who may ask for erasure', () => {
  const base = { capacity: 'SELF' as const, subjectIsMinor: false, requesterApprovesChildren: false, requesterHasRole: false, pending: false };
  it.each([
    [{}, null],
    [{ pending: true }, 'ALREADY_PENDING'],
    [{ subjectIsMinor: true }, 'MINOR_ASKS_GUARDIAN'],
    [{ requesterHasRole: true }, 'ADMIN_ROLE'],
    [{ requesterApprovesChildren: true }, 'GUARDIAN_OF_CHILDREN'],
    [{ capacity: 'GUARDIAN', subjectIsMinor: true }, null],
    [{ capacity: 'GUARDIAN', pending: true }, 'ALREADY_PENDING'],
  ])('%j → %s', (over, block) => {
    expect(erasureBlock({ ...base, ...(over as object) })).toBe(block);
  });

  it('waits 14 days', () => {
    expect(erasureDueAt(new Date('2026-10-16T10:00:00Z')).toISOString()).toBe('2026-10-30T10:00:00.000Z');
  });
});

describe('the export', () => {
  it('drops secrets and internal keys, masks other people, and is plain JSON', () => {
    const row = exportRow({
      id: 'x', token_hash: 't', code_hash: 'c', idempotency_key: 'i', skip_idempotency_key: 's', seed: 'z', secret_ciphertext: 'q', assembly_report: {}, items: [],
      email_normalized: 'parent@example.com', guardian_email_normalized: '+919876543210', at: new Date('2026-01-01T00:00:00Z'), n: BigInt(7), nested: { when: new Date(0), list: [BigInt(1)] },
    });
    expect(row).toEqual({ id: 'x', email_normalized: 'p•••@example.com', guardian_email_normalized: '•••3210', at: '2026-01-01T00:00:00.000Z', n: '7', nested: { when: '1970-01-01T00:00:00.000Z', list: ['1'] } });
    expect(maskOther('ab')).toBe('•••');
  });

  it('every exported table and column exists in the schema', () => {
    const m = models();
    for (const t of STUDENT_EXPORT_TABLES) {
      expect([t.table, t.table in m]).toEqual([t.table, true]);
      const col = 'column' in t.by ? t.by.column : t.by.sessions;
      expect([t.table, m[t.table].includes(col)]).toEqual([t.table, true]);
    }
  });

  it('every table with a student column is exported or listed as deliberately left out', () => {
    const exported = new Set(STUDENT_EXPORT_TABLES.map((t) => t.table));
    for (const [table, cols] of Object.entries(models())) {
      if (!cols.some((c) => /student(_id|_low|_high)$/.test(c))) continue;
      if (['account_student_access', 'student', 'privacy_request', 'student_block'].includes(table)) continue;
      expect([table, exported.has(table) || table in NOT_EXPORTED]).toEqual([table, true]);
    }
  });
});

describe('the erasure map', () => {
  it('names every table with a column pointing at a student or an account, and nothing else', () => {
    const m = models();
    const linked = Object.entries(m).filter(([, cols]) => cols.some((c) => /(student|account)(_id|_low|_high)$/.test(c))).map(([t]) => t).sort();
    expect(linked.filter((t) => !(t in ERASURE_MAP))).toEqual([]);
    expect(Object.keys(ERASURE_MAP).filter((t) => !(t in m))).toEqual([]);
  });

  it('the saga touches every table the map says it deletes or ends', () => {
    const saga = readFileSync(join(__dirname, 'rights.service.ts'), 'utf8');
    for (const [t, h] of Object.entries(ERASURE_MAP)) {
      if (h === 'DELETE' || h === 'END') expect([t, new RegExp(`tx\\.${t}\\.(deleteMany|updateMany|update)`).test(saga)]).toEqual([t, true]);
    }
  });

  it("the migration allows the new ERASED reason and keeps Step 18's reasons", () => {
    expect(EXTRA).toMatch(/'EXPIRED', 'ADMIN_ENDED', 'REPLACED', 'ERASED'/);
    expect(EXTRA).not.toMatch(/FOREIGN KEY|REFERENCES/);
  });
});

describe('retention', () => {
  it('provisional defaults, overridable, and refuses nonsense', () => {
    expect(retentionPeriods({})).toEqual(DEFAULT_RETENTION);
    expect(DEFAULT_RETENTION).toEqual({ otpDays: 90, sessionDays: 90, friendCodeAttemptDays: 30, analyticsMonths: 13, outboxDays: 90, inactiveMonths: 24 });
    expect(retentionPeriods({ RETENTION_ANALYTICS_MONTHS: '6' }).analyticsMonths).toBe(6);
    expect(() => retentionPeriods({ RETENTION_OTP_DAYS: '0' })).toThrow(/RETENTION_OTP_DAYS/);
    expect(() => retentionPeriods({ RETENTION_SESSION_DAYS: 'ninety' })).toThrow(/RETENTION_SESSION_DAYS/);
  });

  it('cuts off by days and by calendar months', () => {
    const now = new Date('2026-10-16T00:00:00Z');
    const c = retentionCutoffs(now, DEFAULT_RETENTION);
    expect(c.otp.toISOString()).toBe('2026-07-18T00:00:00.000Z');
    expect(c.analytics.toISOString()).toBe('2025-09-16T00:00:00.000Z');
    expect(c.inactive.toISOString()).toBe('2024-10-16T00:00:00.000Z');
    expect(monthsBefore(new Date('2026-03-31T00:00:00Z'), 1).toISOString().slice(0, 10)).toBe('2026-03-03');
  });

  it('switches are on unless "false"', () => {
    expect(switchOn('X', {})).toBe(true);
    expect(switchOn('X', { X: 'FALSE' })).toBe(false);
    expect(() => switchOn('X', { X: 'off' })).toThrow(/"true" or "false"/);
  });
});
