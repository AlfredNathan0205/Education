import { ExamConflictError, ExamInputError, ExamNotPermittedError } from '../exam/exam.errors';
import { EntitlementService } from './entitlement.service';
import { FREE_VALUES, UNLIMITED_VALUES } from './entitlement-domain';
import { EntitlementSweeper } from './sweeper';

type Row = Record<string, any>;
const RELATIONS: Record<string, Record<string, { table: string; many: boolean; local: string; foreign: string }>> = {
  subscription: { plan: { table: 'plan', many: false, local: 'plan_id', foreign: 'id' }, events: { table: 'subscription_event', many: true, local: 'id', foreign: 'subscription_id' } },
};

function fakeDb() {
  let n = 0;
  const tables: Record<string, Row[]> = {};
  const t = (name: string) => (tables[name] ??= []);
  const cmp = (v: any, c: any): boolean => {
    if (c && typeof c === 'object' && !(c instanceof Date)) {
      if ('in' in c) return c.in.includes(v);
      return (!('gt' in c) || v > c.gt) && (!('gte' in c) || v >= c.gte) && (!('lt' in c) || v < c.lt) && (!('lte' in c) || v <= c.lte);
    }
    if (c === null) return v === null || v === undefined;
    return v === c;
  };
  const matches = (row: Row, where: any = {}): boolean =>
    Object.entries(where).every(([k, c]: [string, any]) => (k === 'NOT' ? !matches(row, c) : cmp(row[k], c)));
  const inc = (table: string, row: Row, include: any) => {
    const out = { ...row };
    for (const k of Object.keys(include ?? {})) {
      const r = RELATIONS[table]?.[k];
      if (!r) continue;
      out[k] = r.many ? t(r.table).filter((x) => x[r.foreign] === row[r.local]) : t(r.table).find((x) => x[r.foreign] === row[r.local]) ?? null;
    }
    return out;
  };
  const model = (table: string) => ({
    findMany: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(r, a.where)).slice(0, a.take ?? 1e9).map((r) => inc(table, r, a.include))),
    findFirst: jest.fn(async (a: any = {}) => { const r = t(table).find((x) => matches(x, a.where)); return r ? inc(table, r, a.include) : null; }),
    findUnique: jest.fn(async (a: any) => { const r = t(table).find((x) => matches(x, a.where)); return r ? inc(table, r, a.include) : null; }),
    count: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(r, a.where)).length),
    create: jest.fn(async ({ data }: any) => { const row = { id: `${table}-${++n}`, created_at: new Date(), ...data }; t(table).push(row); return { ...row }; }),
    update: jest.fn(async ({ where, data }: any) => Object.assign(t(table).find((r) => matches(r, where))!, data)),
    updateMany: jest.fn(async ({ where, data }: any) => { const rows = t(table).filter((r) => matches(r, where)); rows.forEach((r) => Object.assign(r, data)); return { count: rows.length }; }),
  });
  const client: any = new Proxy(
    { tables, $transaction: async (fn: any) => fn(client), $queryRaw: jest.fn(async (s: TemplateStringsArray) => (s.join('?').includes('FROM student s') ? client.missing : [])) } as any,
    { get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = model(prop))) },
  );
  return client;
}

const NOW = new Date('2026-10-15T10:00:00Z');

function build() {
  const client = fakeDb();
  const T = client.tables;
  client.missing = [];
  T.plan = [
    { id: 'p-free', code: 'FREE', name: 'Free', status: 'ACTIVE', is_default: true, values: FREE_VALUES },
    { id: 'p-beta', code: 'BETA', name: 'Beta', status: 'ACTIVE', is_default: false, values: UNLIMITED_VALUES },
    { id: 'p-plus', code: 'PLUS', name: 'Plus', status: 'ACTIVE', is_default: false, values: UNLIMITED_VALUES },
  ];
  T.account_student_access = [
    { account_id: 'acct-ann', student_id: 'ann', access_kind: 'SELF', revoked_at: null },
    { account_id: 'acct-kid', student_id: 'kid', access_kind: 'SELF', revoked_at: null },
  ];
  T.authentication_identity = [
    { account_id: 'acct-ann', kind: 'EMAIL', identifier_normalized: 'ann@example.com' },
    { account_id: 'acct-kid', kind: 'EMAIL', identifier_normalized: 'kid@example.com' },
    { account_id: 'acct-mum', kind: 'EMAIL', identifier_normalized: 'mum@example.com' },
    { account_id: 'acct-x', kind: 'EMAIL', identifier_normalized: 'stranger@example.com' },
  ];
  T.student = [{ id: 'ann' }, { id: 'kid' }];
  T.assessment_instance = [];
  const authz: any = { curriculumRolesFor: jest.fn(async (a: string) => (a === 'admin' ? ['SUPER_ADMIN'] : [])) };
  const privacy: any = {
    getClassificationSummary: jest.fn(async (s: string) => ({ classified: true, requiresGuardianConsent: s === 'kid', consentSatisfied: true })),
    listGuardianApprovals: jest.fn(async (a: string) => (a === 'acct-mum' ? [{ studentId: 'kid' }] : [])),
    studentLabels: jest.fn(async (ids: string[]) => new Map(ids.map((i) => [i, i]))),
  };
  const outbox: any = { publish: jest.fn(async () => undefined) };
  const service = new EntitlementService({ client } as any, authz, privacy, outbox);
  const started = (student: string, k: number, extra: Row = {}) => {
    for (let i = 0; i < k; i++) T.assessment_instance.push({ student_id: student, assembled_at: new Date(NOW.getTime() - 60_000 * (i + 1)), recommendation_id: null, blueprint_code: 'QUICK10', ...extra });
  };
  return { service, client, T, outbox, started };
}

describe('what a student may do', () => {
  it('everyone has FREE; an active plan or grant widens it; an expired or ended one does not', async () => {
    const b = build();
    expect((await b.service.effective('ann', NOW)).values).toEqual(FREE_VALUES);
    b.T.subscription = [{ id: 's1', student_id: 'ann', plan_id: 'p-plus', status: 'ACTIVE', source: 'ADMIN_GRANT', starts_at: new Date('2026-01-01'), ends_at: new Date('2026-02-01') }];
    expect((await b.service.effective('ann', NOW)).values).toEqual(FREE_VALUES);
    b.T.subscription.push({ id: 's2', student_id: 'ann', plan_id: 'p-beta', status: 'ACTIVE', source: 'BETA', starts_at: new Date('2026-10-01'), ends_at: new Date('2027-03-31') });
    const e = await b.service.effective('ann', NOW);
    expect(e.values).toEqual(UNLIMITED_VALUES);
    expect(e.sources).toEqual([{ planName: 'Beta', source: 'BETA', endsAt: '2027-03-31T00:00:00.000Z' }]);
    b.T.entitlement_grant = [{ student_id: 'kid', entitlement_key: 'LONG_TESTS', value: true, starts_at: new Date('2026-10-01'), ends_at: new Date('2026-11-01'), revoked_at: null }];
    expect((await b.service.effective('kid', NOW)).values).toEqual({ ...FREE_VALUES, LONG_TESTS: true });
  });

  it('only self-chosen tests count toward the day; recommended practice, retests and challenges do not', async () => {
    const b = build();
    b.started('ann', 2);
    b.started('ann', 2, { recommendation_id: 'rec' });
    b.started('ann', 1, { blueprint_code: 'CHALLENGE10' });
    b.started('ann', 1, { assembled_at: new Date('2026-10-14T10:00:00Z') });
    expect(await b.service.startedToday('ann', NOW)).toBe(2);
    await expect(b.service.assertCanStart(b.client, 'ann', 10, NOW)).resolves.toBeUndefined();
    b.started('ann', 1);
    await expect(b.service.assertCanStart(b.client, 'ann', 10, NOW)).rejects.toThrow(/started all the tests your plan includes today/);
    await expect(b.service.assertCanStart(b.client, 'kid', 25, NOW)).rejects.toThrow(/Longer tests/);
    expect(await b.service.mine('acct-ann', NOW)).toMatchObject({ planName: 'Free', startedToday: 3, leftToday: 0 });
  });
});

describe('administration', () => {
  it('only a SUPER_ADMIN; reasons required; the beta and free plans are not granted by hand', async () => {
    const b = build();
    await expect(b.service.grantPlan('acct-ann', { studentId: 'ann', planCode: 'PLUS', reason: 'Comp for a bug' }, NOW)).rejects.toBeInstanceOf(ExamNotPermittedError);
    await expect(b.service.grantPlan('admin', { studentId: 'ann', planCode: 'PLUS', reason: 'x' }, NOW)).rejects.toThrow(/reason/);
    await expect(b.service.grantPlan('admin', { studentId: 'ann', planCode: 'BETA', reason: 'Because' }, NOW)).rejects.toThrow(/automatically/);
    await expect(b.service.grantPlan('admin', { studentId: 'ann', planCode: 'FREE', reason: 'Because' }, NOW)).rejects.toThrow(/default/);
    await expect(b.service.grantPlan('admin', { studentId: 'ann', planCode: 'PLUS', reason: 'Because', endsAt: '2026-01-01' }, NOW)).rejects.toThrow(/future/);
  });

  it('the holder is an adult connected to the student: the adult student, the approving guardian; never a minor or a stranger', async () => {
    const b = build();
    await expect(b.service.grantPlan('admin', { studentId: 'kid', planCode: 'PLUS', holderEmail: 'kid@example.com', reason: 'Because' }, NOW)).rejects.toThrow(/minor cannot hold/);
    await expect(b.service.grantPlan('admin', { studentId: 'kid', planCode: 'PLUS', holderEmail: 'stranger@example.com', reason: 'Because' }, NOW)).rejects.toBeInstanceOf(ExamInputError);
    const { subscriptionId } = await b.service.grantPlan('admin', { studentId: 'kid', planCode: 'PLUS', holderEmail: 'mum@example.com', reason: 'Because', endsAt: '2027-01-01' }, NOW);
    expect(b.T.subscription[0]).toMatchObject({ id: subscriptionId, holder_account_id: 'acct-mum', source: 'ADMIN_GRANT', status: 'ACTIVE' });
    await b.service.grantPlan('admin', { studentId: 'ann', planCode: 'PLUS', holderEmail: 'ann@example.com', reason: 'Because' }, NOW);
    expect(b.T.subscription_event.map((e: Row) => e.type)).toEqual(['CREATED', 'CREATED']);
    expect(b.T.audit_event.map((a: Row) => a.action)).toEqual(['entitlement.plan_granted', 'entitlement.plan_granted']);

    await b.service.endSubscription('admin', subscriptionId, 'Refund requested', NOW);
    expect(b.T.subscription[0]).toMatchObject({ status: 'ENDED', ended_reason: 'ADMIN_ENDED' });
    await expect(b.service.endSubscription('admin', subscriptionId, 'Again please', NOW)).rejects.toBeInstanceOf(ExamConflictError);
  });

  it('single-entitlement grants: a valid value, a future end, revocable', async () => {
    const b = build();
    await expect(b.service.grantEntitlement('admin', { studentId: 'ann', key: 'CP_BOOST', value: 2, endsAt: '2027-01-01', reason: 'Because' }, NOW)).rejects.toThrow(/Choose an entitlement/);
    await expect(b.service.grantEntitlement('admin', { studentId: 'ann', key: 'LONG_TESTS', value: 3, endsAt: '2027-01-01', reason: 'Because' }, NOW)).rejects.toThrow(/true or false/);
    const { grantId } = await b.service.grantEntitlement('admin', { studentId: 'ann', key: 'LONG_TESTS', value: true, endsAt: '2027-01-01', reason: 'Exam week' }, NOW);
    expect((await b.service.effective('ann', NOW)).values.LONG_TESTS).toBe(true);
    await b.service.revokeGrant('admin', grantId, NOW);
    expect((await b.service.effective('ann', NOW)).values.LONG_TESTS).toBe(false);
  });
});

describe('the beta and expiry', () => {
  it('grants BETA to students without it, extends when the date moves later, and expires what is over', async () => {
    const b = build();
    const until = new Date('2027-03-31T18:30:00Z');
    b.client.missing = [{ id: 'ann' }, { id: 'kid' }];
    expect(await b.service.reconcile(until, NOW)).toEqual({ expired: 0, granted: 2, extended: 0 });
    expect(b.T.subscription.map((s: Row) => [s.student_id, s.source, s.holder_account_id, s.ends_at.toISOString()])).toEqual([
      ['ann', 'BETA', null, '2027-03-31T18:30:00.000Z'],
      ['kid', 'BETA', null, '2027-03-31T18:30:00.000Z'],
    ]);
    b.client.missing = [];
    const later = new Date('2027-06-30T18:30:00Z');
    expect(await b.service.reconcile(later, NOW)).toEqual({ expired: 0, granted: 0, extended: 2 });
    expect(b.T.subscription_event.filter((e: Row) => e.type === 'EXTENDED')).toHaveLength(2);
    // Past its end: the beta runs out; with BETA_GRANT_UNTIL unset, nothing new is granted.
    expect(await b.service.reconcile(null, new Date('2027-07-01T00:00:00Z'))).toEqual({ expired: 2, granted: 0, extended: 0 });
    expect(b.T.subscription.every((s: Row) => s.status === 'ENDED' && s.ended_reason === 'EXPIRED')).toBe(true);
  });

  it('a malformed BETA_GRANT_UNTIL fails at startup', () => {
    const before = process.env.BETA_GRANT_UNTIL;
    process.env.BETA_GRANT_UNTIL = 'next spring';
    try {
      expect(() => new EntitlementSweeper({} as any)).toThrow(/BETA_GRANT_UNTIL/);
    } finally {
      if (before === undefined) delete process.env.BETA_GRANT_UNTIL;
      else process.env.BETA_GRANT_UNTIL = before;
    }
  });
});
