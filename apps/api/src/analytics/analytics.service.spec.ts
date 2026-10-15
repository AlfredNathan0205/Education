import { ExamConflictError, ExamInputError, ExamNotPermittedError } from '../exam/exam.errors';
import { AnalyticsService } from './analytics.service';
import { subjectKey } from './analytics-domain';

type Row = Record<string, any>;

function fakeDb() {
  let n = 0;
  const tables: Record<string, Row[]> = {};
  const t = (name: string) => (tables[name] ??= []);
  const cmp = (v: any, c: any): boolean => {
    if (c && typeof c === 'object' && !(c instanceof Date)) return (!('gte' in c) || v >= c.gte) && (!('lt' in c) || v < c.lt);
    if (c === null) return v === null || v === undefined;
    return v === c;
  };
  const matches = (row: Row, where: any = {}) =>
    Object.entries(where).every(([k, c]: [string, any]) => {
      if (k === 'experiment_id_subject_key') return row.experiment_id === c.experiment_id && row.subject_key === c.subject_key;
      if (k === 'purpose') return true;
      if (k === 'withdrawal') return !t('consent_withdrawal').some((w) => w.consent_record_id === row.id);
      return cmp(row[k], c);
    });
  const model = (table: string) => ({
    findMany: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(r, a.where)).map((r) => (a.include?.variants ? { ...r, variants: t('experiment_variant').filter((v) => v.experiment_id === r.id) } : { ...r }))),
    findFirst: jest.fn(async (a: any = {}) => t(table).find((r) => matches(r, a.where)) ?? null),
    findUnique: jest.fn(async (a: any) => {
      const r = t(table).find((x) => matches(x, a.where));
      return r ? (a.include?.variants ? { ...r, variants: t('experiment_variant').filter((v) => v.experiment_id === r.id) } : { ...r }) : null;
    }),
    count: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(r, a.where)).length),
    create: jest.fn(async ({ data }: any) => {
      if (table === 'analytics_event' && data.source_ref && t(table).some((r) => r.source_ref === data.source_ref)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row = { id: `${table}-${++n}`, created_at: new Date(), ...data };
      t(table).push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => Object.assign(t(table).find((r) => matches(r, where))!, data)),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const r = t(table).find((x) => matches(x, where));
      if (r) return Object.assign(r, update);
      t(table).push({ ...create });
      return create;
    }),
    deleteMany: jest.fn(async ({ where }: any) => {
      const keep = t(table).filter((r) => !matches(r, where));
      const count = t(table).length - keep.length;
      tables[table] = keep;
      return { count };
    }),
    groupBy: jest.fn(async ({ where }: any) => {
      const m = new Map<string, number>();
      for (const r of t(table).filter((x) => matches(x, where))) m.set(r.variant_key, (m.get(r.variant_key) ?? 0) + 1);
      return [...m.entries()].map(([variant_key, c]) => ({ variant_key, _count: { _all: c } }));
    }),
  });
  const client: any = new Proxy(
    {
      tables,
      outbox: [] as Row[],
      $transaction: async (fn: any) => fn(client),
      $queryRaw: jest.fn(async (s: TemplateStringsArray, ...vals: any[]) => {
        const sql = s.join('?');
        if (sql.includes('FROM outbox_event')) {
          const [after, afterId, before] = vals;
          return client.outbox
            .filter((o: Row) => (o.created_at > after || (o.created_at.getTime() === after.getTime() && o.id > afterId)) && o.created_at < before)
            .sort((a: Row, b: Row) => a.created_at - b.created_at || a.id.localeCompare(b.id))
            .slice(0, vals[3]);
        }
        if (sql.includes('consent_record')) return [{ n: 3 }];
        if (sql.includes('account_student_access')) return [{ n: 40 }];
        return [];
      }),
    } as any,
    { get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = model(prop))) },
  );
  return client;
}

const NOW = new Date('2026-10-15T10:00:00Z');
const SECRET = 'development-only-analytics-pseudonym-key-000';

function build(opts: { consenting?: string[]; minors?: string[] } = {}) {
  const client = fakeDb();
  const T = client.tables;
  const consenting = new Set(opts.consenting ?? ['ann']);
  T.account_student_access = [
    { account_id: 'acct-ann', student_id: 'ann', access_kind: 'SELF', revoked_at: null },
    { account_id: 'acct-kid', student_id: 'kid', access_kind: 'SELF', revoked_at: null },
  ];
  T.student_academic_context = [{ student_id: 'ann', curriculum_code: 'ICSE', grade_code: 'GRADE_8' }, { student_id: 'kid', curriculum_code: 'icse-x', grade_code: 'G8' }];
  T.student = [{ id: 'ann', created_at: new Date('2026-09-01T00:00:00Z') }, { id: 'kid', created_at: new Date('2026-09-02T00:00:00Z') }];
  T.consent_purpose = [{ id: 'cp', code: 'PRODUCT_ANALYTICS' }];
  T.consent_policy_version = [{ id: 'cpv', consent_purpose_id: 'cp', version: 1, text_reference: 'consent-text:PRODUCT_ANALYTICS:v1-draft', retired_at: null, effective_from: new Date('2026-01-01') }];
  const minors = opts.minors ?? ['kid'];
  const privacy: any = {
    evaluateProcessingForStudent: jest.fn(async (s: string) => (consenting.has(s) ? { allowed: true, grantId: 'g' } : { allowed: false, reason: 'NO_CONSENT' })),
    getClassificationSummary: jest.fn(async (s: string) => ({ classified: true, requiresGuardianConsent: minors.includes(s), consentSatisfied: true })),
    grantConsent: jest.fn(async (i: any) => {
      consenting.add(i.studentId);
      (T.consent_record ??= []).push({ id: `cr-${T.consent_record.length}`, student_id: i.studentId, granted_by_account_id: i.actorAccountId, capacity: i.capacity, guardian_authority_id: i.guardianAuthorityId ?? null });
      return { consentRecordId: 'x' };
    }),
    withdrawConsent: jest.fn(async (i: any) => {
      const r = T.consent_record.find((x: Row) => x.id === i.consentRecordId);
      (T.consent_withdrawal ??= []).push({ consent_record_id: r.id });
      consenting.delete(r.student_id);
    }),
    listGuardianApprovals: jest.fn(async (a: string) => (a === 'acct-mum' ? [{ consentRecordId: 'core-kid', studentId: 'kid', label: 'Kiran', displayName: 'Kiran', grantedAt: NOW }] : [])),
  };
  T.consent_record = [{ id: 'core-kid', student_id: 'kid', granted_by_account_id: 'acct-mum', capacity: 'GUARDIAN', guardian_authority_id: 'auth-1' }];
  const authz: any = { curriculumRolesFor: jest.fn(async (a: string) => (a === 'admin' ? ['SUPER_ADMIN'] : [])) };
  const service = new AnalyticsService({ client } as any, privacy, authz);
  return { service, client, T, privacy, consenting };
}

const key = (s: string) => subjectKey(s, SECRET);

describe('recording', () => {
  it('only for a consenting student; pseudonymous; cohort codes only', async () => {
    const b = build();
    expect(await b.service.record('ann', 'QUALIFIED_TEST', null, NOW)).toBe(true);
    expect(await b.service.record('kid', 'QUALIFIED_TEST', null, NOW)).toBe(false);
    expect(b.T.analytics_event).toEqual([expect.objectContaining({ subject_key: key('ann'), name: 'QUALIFIED_TEST', source: 'SERVER', cohort: 'ICSE/GRADE_8' })]);
    expect(JSON.stringify(b.T.analytics_event)).not.toContain('ann"');
  });

  it('client events: a fixed list, a daily cap, and the client is never told whether it was kept', async () => {
    const b = build();
    await expect(b.service.recordClient('acct-ann', 'PAGE_VIEW', NOW)).rejects.toBeInstanceOf(ExamInputError);
    await b.service.recordClient('acct-ann', 'RESULTS_OPENED', NOW);
    await b.service.recordClient('acct-kid', 'RESULTS_OPENED', NOW); // no consent: silently dropped
    expect(b.T.analytics_event.map((e: Row) => [e.subject_key, e.name, e.source])).toEqual([[key('ann'), 'RESULTS_OPENED', 'CLIENT']]);
    for (let i = 0; i < 210; i++) await b.service.recordClient('acct-ann', 'PROGRESS_OPENED', NOW);
    expect(b.T.analytics_event.length).toBe(200);
  });
});

describe('writing rows', () => {
  it('never writes props as JSON null (the database CHECK refuses it): the column is left out instead', async () => {
    const b = build();
    await b.service.record('ann', 'QUALIFIED_TEST', null, NOW);
    await b.service.recordClient('acct-ann', 'RESULTS_OPENED', NOW);
    await b.service.record('ann', 'ASSESSMENT_COMPLETED', { mode: 'TEST' }, NOW);
    const calls = (b.client.analytics_event.create as jest.Mock).mock.calls.map((c: any[]) => c[0].data);
    expect(calls.map((d: Row) => ('props' in d ? d.props : 'absent'))).toEqual(['absent', 'absent', { mode: 'TEST' }]);
  });
});

describe('projecting the outbox', () => {
  it('maps events for consenting students once, in order, after a settling delay; withdrawing consent deletes', async () => {
    const b = build({ consenting: ['ann', 'kid'] });
    const o = (id: string, type: string, payload: Row, secondsAgo: number) => b.client.outbox.push({ id, event_type: type, payload, created_at: new Date(NOW.getTime() - secondsAgo * 1000) });
    o('00000000-0000-0000-0000-000000000001', 'privacy.consent.granted.v1', { studentId: 'ann', purposeCode: 'PRODUCT_ANALYTICS' }, 100);
    o('00000000-0000-0000-0000-000000000002', 'assessment.started.v1', { studentId: 'ann', mode: 'TEST', blueprint: 'QUICK10', recommendationId: null, assessmentId: 'x' }, 90);
    o('00000000-0000-0000-0000-000000000003', 'assessment.submitted.v1', { studentId: 'ann', mode: 'TEST', reason: 'STUDENT', correct: 7, total: 10 }, 80);
    o('00000000-0000-0000-0000-000000000004', 'competition.cp_recorded.v1', { studentId: 'ann', kind: 'AWARD', amount: 40 }, 70);
    o('00000000-0000-0000-0000-000000000005', 'mastery.updated.v1', { studentId: 'kid', runId: 'run-1' }, 60);
    o('00000000-0000-0000-0000-000000000006', 'social.friendship_created.v1', { studentId: 'ann' }, 50);
    o('00000000-0000-0000-0000-000000000007', 'assessment.started.v1', { studentId: 'ann', mode: 'TEST', blueprint: 'QUICK10' }, 2); // too fresh
    b.T.mastery_state_change = [{ run_id: 'run-1', before_label: 'NEEDS_ATTENTION', after_label: 'DEVELOPING' }];

    expect(await b.service.projectOutbox(NOW)).toEqual({ read: 6, recorded: 5, forgotten: 0 });
    expect(b.T.analytics_event.map((e: Row) => [e.name, e.subject_key === key('ann') ? 'ann' : 'kid'])).toEqual([
      ['SIGNED_UP', 'ann'],
      ['ASSESSMENT_STARTED', 'ann'],
      ['ASSESSMENT_COMPLETED', 'ann'],
      ['QUALIFIED_TEST', 'ann'],
      ['MASTERY_UPDATED', 'kid'],
    ]);
    // Sign-up is dated when the student was created, not when they consented; no scores were kept.
    expect(b.T.analytics_event[0].occurred_at).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(b.T.analytics_event[2].props).toEqual({ mode: 'TEST', reason: 'STUDENT' });
    expect(b.T.analytics_event[4].props).toEqual({ improvedObjectives: 1 });
    // The kid's cohort code is not in code form, so it is left out rather than refused.
    expect(b.T.analytics_event[4].cohort).toBeNull();
    // Nothing new: the cursor moved on.
    expect(await b.service.projectOutbox(NOW)).toEqual({ read: 0, recorded: 0, forgotten: 0 });
    // Later the fresh one is read; then a withdrawal deletes everything about ann.
    o('00000000-0000-0000-0000-000000000008', 'privacy.consent.withdrawn.v1', { studentId: 'ann', purposeCode: 'PRODUCT_ANALYTICS' }, -5);
    expect(await b.service.projectOutbox(new Date(NOW.getTime() + 60_000))).toEqual({ read: 2, recorded: 1, forgotten: 5 });
    expect(b.T.analytics_event.map((e: Row) => e.name)).toEqual(['MASTERY_UPDATED']);
  });
});

describe('consent', () => {
  it('an adult decides; wording version must match; turning it off deletes what was kept', async () => {
    const b = build({ consenting: [] });
    expect(await b.service.myConsent('acct-ann', NOW)).toMatchObject({ decidedBy: 'SELF', granted: false, consent: { version: 1, draft: true } });
    await expect(b.service.setMyConsent('acct-ann', { granted: true, consentVersion: 2 }, NOW)).rejects.toThrow(/wording has changed/);
    expect(await b.service.setMyConsent('acct-ann', { granted: true, consentVersion: 1 }, NOW)).toEqual({ granted: true });
    expect(b.privacy.grantConsent).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'ann', purposeCode: 'PRODUCT_ANALYTICS', capacity: 'SELF' }), NOW);
    await b.service.record('ann', 'QUALIFIED_TEST', null, NOW);
    expect(await b.service.setMyConsent('acct-ann', { granted: false, consentVersion: 1 }, NOW)).toEqual({ granted: false });
    expect(b.T.analytics_event).toEqual([]);
  });

  it("a minor's guardian decides, under their guardian authority; the minor cannot", async () => {
    const b = build({ consenting: [] });
    expect(await b.service.myConsent('acct-kid', NOW)).toMatchObject({ decidedBy: 'GUARDIAN', consent: null });
    await expect(b.service.setMyConsent('acct-kid', { granted: true, consentVersion: 1 }, NOW)).rejects.toBeInstanceOf(ExamConflictError);
    expect(await b.service.guardianConsents('acct-mum', NOW)).toMatchObject({ children: [{ studentId: 'kid', label: 'Kiran', granted: false }], consent: { version: 1 } });
    await b.service.setGuardianConsent('acct-mum', 'kid', { granted: true, consentVersion: 1 }, NOW);
    expect(b.privacy.grantConsent).toHaveBeenCalledWith(expect.objectContaining({ studentId: 'kid', capacity: 'GUARDIAN', actorAccountId: 'acct-mum', guardianAuthorityId: 'auth-1' }), NOW);
    await expect(b.service.setGuardianConsent('acct-stranger', 'kid', { granted: true, consentVersion: 1 }, NOW)).rejects.toThrow(/Not found/);
  });
});

describe('administration', () => {
  it('metrics are for administrators, aggregate and audited, with small counts hidden', async () => {
    const b = build();
    await expect(b.service.metrics('acct-ann', NOW)).rejects.toBeInstanceOf(ExamNotPermittedError);
    await b.service.record('ann', 'QUALIFIED_TEST', null, new Date('2026-10-13T10:00:00Z'));
    const m = await b.service.metrics('admin', NOW);
    expect(m.coverage).toEqual({ consenting: '<5', students: 40 });
    expect(m.weeks[m.weeks.length - 1]).toMatchObject({ northStar: '<5', intensity: null });
    expect(JSON.stringify(m)).not.toContain(key('ann'));
    expect(b.T.audit_event).toEqual([expect.objectContaining({ action: 'analytics.metrics_viewed', actor_account_id: 'admin' })]);
  });

  it('experiments: created as a draft, started, then stopped; consenting students get a stable variant, others the control', async () => {
    const b = build();
    await expect(b.service.createExperiment('admin', { key: 'Home!', description: 'A home layout test', variants: [] })).rejects.toBeInstanceOf(ExamInputError);
    const { id } = await b.service.createExperiment('admin', { key: 'home_layout', description: 'A home layout test', variants: [{ key: 'control', weight: 50, isControl: true }, { key: 'cards', weight: 50 }] });
    expect(await b.service.variantFor('ann', 'home_layout', NOW)).toBe('control'); // DRAFT
    await b.service.setExperimentStatus('admin', id, 'RUNNING', NOW);
    await expect(b.service.setExperimentStatus('admin', id, 'RUNNING', NOW)).rejects.toBeInstanceOf(ExamConflictError);
    const v = await b.service.variantFor('ann', 'home_layout', NOW);
    expect(await b.service.variantFor('ann', 'home_layout', NOW)).toBe(v);
    expect(b.T.experiment_assignment).toEqual([expect.objectContaining({ subject_key: key('ann'), variant_key: v })]);
    expect(await b.service.variantFor('kid', 'home_layout', NOW)).toBe('control');
    expect(b.T.experiment_assignment).toHaveLength(1);
    expect((await b.service.experiments('admin'))[0]).toMatchObject({ key: 'home_layout', status: 'RUNNING' });
    await b.service.setExperimentStatus('admin', id, 'STOPPED', NOW);
    expect(await b.service.variantFor('ann', 'home_layout', NOW)).toBe('control');
  });
});
