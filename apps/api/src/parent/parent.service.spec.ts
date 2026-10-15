import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError } from '../exam/exam.errors';
import { GuardianUnavailableError } from '../guardian/guardian.errors';
import { hashInviteToken } from '../guardian/guardian-domain';
import { ParentService } from './parent.service';
import { reportsEnabled } from './sweeper';

/**
 * A small in-memory stand-in for the Prisma calls this service makes (where with equality, in, not, ranges and one
 * level of relation filter; include of one relation; orderBy on one column; create, update, updateMany).
 */
type Row = Record<string, any>;
const RELATIONS: Record<string, Record<string, { table: string; many: boolean; local: string; foreign: string }>> = {
  consent_record: { withdrawal: { table: 'consent_withdrawal', many: false, local: 'id', foreign: 'consent_record_id' } },
  student_report: { versions: { table: 'student_report_version', many: true, local: 'id', foreign: 'report_id' } },
  assessment_session: { result: { table: 'assessment_result', many: false, local: 'id', foreign: 'session_id' } },
};

function fakeDb() {
  let n = 0;
  const tables: Record<string, Row[]> = {};
  const t = (name: string) => (tables[name] ??= []);
  const cmp = (v: any, cond: any): boolean => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('in' in cond) return cond.in.includes(v);
      if ('not' in cond) return cond.not === null ? v !== null && v !== undefined : v !== cond.not;
      return (!('gt' in cond) || v > cond.gt) && (!('gte' in cond) || v >= cond.gte) && (!('lt' in cond) || v < cond.lt) && (!('lte' in cond) || v <= cond.lte);
    }
    if (cond instanceof Date) return v?.getTime() === cond.getTime();
    if (cond === null) return v === null || v === undefined;
    return v === cond;
  };
  const matches = (table: string, row: Row, where: any = {}): boolean =>
    Object.entries(where).every(([k, cond]: [string, any]) => {
      const rel = RELATIONS[table]?.[k];
      if (rel) {
        const target = t(rel.table).find((r) => r[rel.foreign] === row[rel.local]);
        return cond === null ? !target : !!target && matches(rel.table, target, cond);
      }
      if (k.includes('_') && cond && typeof cond === 'object' && !(cond instanceof Date) && !('in' in cond) && Object.keys(cond).every((x) => x in row)) {
        return Object.entries(cond).every(([kk, vv]) => (vv instanceof Date ? row[kk]?.getTime() === vv.getTime() : row[kk] === vv));
      }
      return cmp(row[k], cond);
    });
  const withInclude = (table: string, row: Row, include: any): Row => {
    if (!include) return { ...row };
    const out = { ...row };
    for (const [k, spec] of Object.entries(include) as [string, any][]) {
      const rel = RELATIONS[table]?.[k];
      if (!rel) continue;
      if (rel.many) {
        let rows = t(rel.table).filter((r) => r[rel.foreign] === row[rel.local]);
        if (spec?.orderBy?.version === 'desc') rows = [...rows].sort((a, b) => b.version - a.version);
        out[k] = rows.slice(0, spec?.take ?? 1e9).map((r) => ({ ...r }));
      } else {
        const one = t(rel.table).find((r) => r[rel.foreign] === row[rel.local]);
        out[k] = one ? { ...one } : null;
      }
    }
    return out;
  };
  const order = (rows: Row[], orderBy: any) => {
    if (!orderBy) return rows;
    const [[col, dir]] = Object.entries(orderBy) as [string, string][];
    return [...rows].sort((a, b) => (a[col] > b[col] ? 1 : a[col] < b[col] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
  };
  const model = (table: string) => ({
    // A `select` of a relation is read like an include (other selected columns come back too; nothing reads them).
    findMany: jest.fn(async (a: any = {}) => order(t(table).filter((r) => matches(table, r, a.where)), a.orderBy).slice(0, a.take ?? 1e9).map((r) => withInclude(table, r, a.include ?? a.select))),
    findFirst: jest.fn(async (a: any = {}) => {
      const rows = order(t(table).filter((r) => matches(table, r, a.where)), a.orderBy);
      return rows[0] ? withInclude(table, rows[0], a.include) : null;
    }),
    findUnique: jest.fn(async (a: any) => {
      const r = t(table).find((x) => matches(table, x, a.where));
      return r ? withInclude(table, r, a.include) : null;
    }),
    create: jest.fn(async ({ data }: any) => {
      if (table === 'student_report' && t(table).some((r) => r.student_id === data.student_id && r.week_start.getTime() === data.week_start.getTime())) {
        throw Object.assign(new Error('dup'), { code: 'P2002' });
      }
      const row: Row = { id: `${table}-${++n}`, created_at: new Date(1_700_000_000_000 + n), ...data };
      t(table).push(row);
      return { ...row };
    }),
    update: jest.fn(async ({ where, data }: any) => Object.assign(t(table).find((r) => matches(table, r, where))!, data)),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = t(table).filter((r) => matches(table, r, where));
      rows.forEach((r) => Object.assign(r, data));
      return { count: rows.length };
    }),
  });
  const raw: { due: Array<{ student_id: string }>; stale: any[] } = { due: [], stale: [] };
  const client: any = new Proxy(
    {
      tables,
      raw,
      $transaction: async (fn: any) => fn(client),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = strings.join('?');
        if (sql.includes('SELECT DISTINCT s.student_id')) return raw.due;
        if (sql.includes('FROM student_report r')) return raw.stale;
        if (sql.includes('COUNT(*)')) return [{ n: 0 }];
        return [];
      }),
    } as any,
    { get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = model(prop))) },
  );
  return client;
}

const NOW = new Date('2026-10-15T10:00:00Z'); // Thursday; this week started 2026-10-11T18:30Z
const LAST_WEEK = new Date('2026-10-07T10:00:00Z');
const BEFORE = new Date('2026-09-30T10:00:00Z');
const STATEMENTS: Record<string, string> = { O1: 'Balance an equation', O2: 'Name the gases', O3: 'Read a graph', O4: 'Use the mole' };

function build(opts: { minors?: string[]; guardianOf?: Record<string, string[]>; wording?: boolean } = {}) {
  const client = fakeDb();
  const T = client.tables;
  T.account_student_access = [
    { account_id: 'acct-ann', student_id: 'ann', access_kind: 'SELF', revoked_at: null },
    { account_id: 'acct-kid', student_id: 'kid', access_kind: 'SELF', revoked_at: null },
  ];
  T.authentication_identity = [
    { account_id: 'acct-mum', kind: 'EMAIL', identifier_normalized: 'mum@example.com', verified_at: NOW },
    { account_id: 'acct-ann', kind: 'EMAIL', identifier_normalized: 'ann@example.com', verified_at: NOW },
    { account_id: 'acct-other', kind: 'EMAIL', identifier_normalized: 'other@example.com', verified_at: NOW },
  ];
  T.curriculum_subject_version = [
    {
      id: 'sv',
      curriculum_version_id: 'cv',
      grade_id: 'g',
      subject_id: 'chem',
      chapters: [{ code: 'C1', title: 'Reactions', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: Object.entries(STATEMENTS).map(([code, statement]) => ({ code, statement })) }] }] }],
    },
  ];
  T.mastery_evidence_event = [];
  T.assessment_session = [];
  T.assessment_result = [];
  if (opts.wording !== false) {
    T.consent_purpose = [{ id: 'cp', code: 'PARENT_REPORT_SHARING' }];
    T.consent_policy_version = [{ id: 'cpv', consent_purpose_id: 'cp', version: 1, text_reference: 'consent-text:PARENT_REPORT_SHARING:v1-draft', retired_at: null, effective_from: new Date('2026-01-01') }];
  }
  const minors = opts.minors ?? ['kid'];
  const privacy: any = {
    listGuardianApprovals: jest.fn(async (acct: string) => (opts.guardianOf?.[acct] ?? []).map((s) => ({ consentRecordId: `c-${s}`, studentId: s, displayName: null, label: `${s}-label`, grantedAt: NOW }))),
    studentLabels: jest.fn(async (ids: string[]) => new Map(ids.map((i) => [i, `${i}-label`]))),
    getClassificationSummary: jest.fn(async (s: string) => ({ classified: true, requiresGuardianConsent: minors.includes(s), consentSatisfied: true, basis: 'POLICY' })),
    grantConsent: jest.fn(async (input: any) => {
      const row = { id: `consent-${(T.consent_record ??= []).length + 1}`, student_id: input.studentId, granted_by_account_id: input.actorAccountId, capacity: input.capacity };
      T.consent_record.push(row);
      return { consentRecordId: row.id };
    }),
    withdrawConsent: jest.fn(async (input: any) => {
      (T.consent_withdrawal ??= []).push({ consent_record_id: input.consentRecordId, withdrawn_by_account_id: input.actorAccountId, reason_code: input.reasonCode });
    }),
  };
  const exam: any = { subjectsFor: jest.fn(async () => [{ subjectVersionId: 'sv', subjectCode: 'CHEM', subjectName: 'Chemistry' }]) };
  const outbox: any = { publish: jest.fn(async () => undefined) };
  const sent: Array<{ to: string; link: string }> = [];
  const mailer = { sendShareInvitation: jest.fn(async (to: string, link: string) => void sent.push({ to, link })) };
  const service = new ParentService({ client } as any, privacy, exam, outbox, mailer, 'https://app.example.com');
  let k = 0;
  /** `count` answers on objective `o`, in their own session, all right or all wrong, at `at`. */
  const answers = (student: string, o: string, count: number, right: boolean, at: Date, opts2: { mode?: 'TEST' | 'PRACTICE' } = {}) => {
    const session = `s${++k}`;
    for (let i = 0; i < count; i++) {
      T.mastery_evidence_event.push({
        student_id: student,
        curriculum_version_id: 'cv',
        grade_id: 'g',
        subject_id: 'chem',
        objective_path: `C1/T1/M1/${o}`,
        score: right ? 1 : 0,
        weight: 1,
        w_quality: 1,
        mode: opts2.mode ?? 'TEST',
        question_id: `q-${o}-${k}-${i}`,
        session_id: session,
        answered_at: at,
        invalidated_at: null,
      });
    }
    T.assessment_session.push({ id: session, student_id: student, mode: opts2.mode ?? 'TEST', status: 'SUBMITTED', submitted_at: at });
    T.assessment_result.push({ session_id: session, total: count, unanswered: 0 });
    return session;
  };
  return { service, client, T, privacy, mailer, sent, outbox, answers };
}

/** O1 strong; O2 needs attention; O3 one wrong answer (building evidence); O4 moves from needs attention to developing this week. */
function history(b: ReturnType<typeof build>, student: string) {
  b.answers(student, 'O1', 6, true, BEFORE);
  b.answers(student, 'O1', 6, true, LAST_WEEK);
  b.answers(student, 'O2', 4, false, BEFORE);
  b.answers(student, 'O2', 4, false, LAST_WEEK);
  b.answers(student, 'O3', 1, false, LAST_WEEK);
  b.answers(student, 'O4', 3, false, BEFORE);
  b.answers(student, 'O4', 3, false, LAST_WEEK);
  b.answers(student, 'O4', 7, true, new Date('2026-10-13T10:00:00Z'));
  b.answers(student, 'O4', 7, true, new Date('2026-10-14T10:00:00Z'));
}

describe('who may see a summary', () => {
  it('a guardian sees their child; anyone else gets 404 (no hint the student exists); the view is audited', async () => {
    const b = build({ guardianOf: { 'acct-mum': ['kid'] } });
    expect(await b.service.children('acct-mum', NOW)).toEqual([{ studentId: 'kid', label: 'kid-label', basis: 'GUARDIAN' }]);
    await b.service.dashboard('acct-mum', 'kid', NOW);
    expect(b.T.audit_event).toEqual([expect.objectContaining({ actor_account_id: 'acct-mum', action: 'parent.summary_viewed', subject_id: 'kid' })]);
    await expect(b.service.dashboard('acct-other', 'kid', NOW)).rejects.toBeInstanceOf(ExamNotFoundError);
    await expect(b.service.dashboard('acct-mum', 'ann', NOW)).rejects.toBeInstanceOf(ExamNotFoundError);
  });

  it('a guardian cannot "leave"; they withdraw their approval instead', async () => {
    const b = build({ guardianOf: { 'acct-mum': ['kid'] } });
    await expect(b.service.leave('acct-mum', 'kid', NOW)).rejects.toThrow(/withdraw your approval/);
  });
});

describe('what a parent sees', () => {
  it('labels, gated claims in fixed wording, activity facts, and no numbers', async () => {
    const b = build({ guardianOf: { 'acct-mum': ['kid'] } });
    history(b, 'kid');
    const v = await b.service.dashboard('acct-mum', 'kid', NOW);
    expect(v.basis).toBe('GUARDIAN');
    expect(v.child).toEqual({ studentId: 'kid', label: 'kid-label' });
    expect(v.strengths.map((c) => c.text)).toEqual(['Shows strong understanding: Balance an equation']);
    expect(v.focus.map((c) => c.text)).toEqual(['Worth more practice: Name the gases']);
    expect(v.improvements.map((c) => c.text)).toEqual(['Moved from needs attention to developing: Use the mole']);
    expect(v.subjects[0]).toMatchObject({ subjectName: 'Chemistry', objectives: 4, reportable: 3, chapters: [{ title: 'Reactions', label: 'DEVELOPING' }] });
    expect(v.subjects[0].counts).toMatchObject({ STRONG: 1, NEEDS_ATTENTION: 1, DEVELOPING: 1, BUILDING_EVIDENCE: 1 });
    // This week: the two O4 tests.
    expect(v.activity).toEqual({ tests: 2, practice: 0, questionsAnswered: 14, activeDays: 2 });
    // The one wrong answer on O3 is not a weakness: nothing about it is claimed.
    expect(JSON.stringify(v)).not.toContain('Read a graph');
    expect(JSON.stringify(v)).not.toMatch(/"mastery"|"confidence"|"score"|"correct"/);
  });

  it('the student\'s "See what they see" is the same summary, and is not audited', async () => {
    const b = build({ guardianOf: { 'acct-mum': ['kid'] } });
    history(b, 'kid');
    const mine = await b.service.preview('acct-kid', NOW);
    const theirs = await b.service.dashboard('acct-mum', 'kid', NOW);
    expect({ ...mine, basis: 'x' }).toEqual({ ...theirs, basis: 'x' });
    expect(mine.basis).toBe('SELF_PREVIEW');
    expect(b.T.audit_event.filter((a: Row) => a.actor_account_id === 'acct-kid')).toEqual([]);
  });
});

describe('weekly reports', () => {
  it('freezes last week once, with approved and refused claims recorded; a later correction adds a version', async () => {
    const b = build({ guardianOf: { 'acct-mum': ['kid'] } });
    b.T.claim_policy_version = [{ id: 'claim-1', code: 'CLAIM_V1', status: 'ACTIVE', params: { limits: { strengths: 5, focus: 3, improvements: 5 }, improvement: { minPeriodSessions: 1 }, templates: { STRENGTH: 'STRENGTH_V1', FOCUS: 'FOCUS_V1', IMPROVEMENT: 'IMPROVEMENT_V1' }, week: { utcOffsetMinutes: 330 } } }];
    b.T.mastery_policy_version = [{ id: 'm-1', code: 'MASTERY_V1', status: 'ACTIVE', params: (await import('../mastery/mastery-domain')).MASTERY_V1 }];
    history(b, 'kid');
    b.client.raw.due = [{ student_id: 'kid' }];
    const [r] = await b.service.reconcile(NOW);
    expect(r).toMatchObject({ studentId: 'kid', version: 1, reason: 'WEEK_ENDED' });
    const report = b.T.student_report[0];
    expect(report.week_start.toISOString()).toBe('2026-10-04T18:30:00.000Z');
    expect(report.week_end.toISOString()).toBe('2026-10-11T18:30:00.000Z');
    // Last week: O1 strong; O2 and O4 needed attention (O4 improves only this week). O3's one wrong answer is refused.
    expect(b.T.report_claim.map((c: Row) => [c.kind, c.objective_path, c.label])).toEqual([
      ['STRENGTH', 'C1/T1/M1/O1', 'STRONG'],
      ['FOCUS', 'C1/T1/M1/O2', 'NEEDS_ATTENTION'],
      ['FOCUS', 'C1/T1/M1/O4', 'NEEDS_ATTENTION'],
    ]);
    // Refused, with reasons: O3's one wrong answer is not a weakness; and labels that first became sayable last week are
    // not "improvements" (there was nothing sayable before them).
    expect(b.T.suppressed_claim.map((s: Row) => [s.kind, s.objective_path, s.reason])).toEqual([
      ['IMPROVEMENT', 'C1/T1/M1/O1', 'NO_EARLIER_CLAIM'],
      ['IMPROVEMENT', 'C1/T1/M1/O2', 'NO_EARLIER_CLAIM'],
      ['FOCUS', 'C1/T1/M1/O3', 'WEAK_GATE_NOT_MET'],
      ['IMPROVEMENT', 'C1/T1/M1/O4', 'NO_EARLIER_CLAIM'],
    ]);
    expect(b.outbox.publish).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ eventType: 'parent.report_generated.v1', idempotencyKey: `parent-report:${report.id}:1` }));

    // Running again changes nothing (the query would not return it, and the write refuses a second WEEK_ENDED).
    expect(await b.service.reconcile(NOW)).toEqual([]);

    // A test from last week is invalidated: the next run adds version 2, built without it.
    b.T.mastery_evidence_event.filter((e: Row) => e.objective_path.endsWith('O2')).forEach((e: Row) => (e.invalidated_at = NOW));
    b.client.raw.due = [];
    b.client.raw.stale = [{ id: report.id, student_id: 'kid', week_start: report.week_start, week_end: report.week_end }];
    const [r2] = await b.service.reconcile(new Date(NOW.getTime() + 1000));
    expect(r2).toMatchObject({ version: 2, reason: 'EVIDENCE_CHANGED' });
    const v2 = b.T.student_report_version.find((v: Row) => v.version === 2);
    expect(v2.content.focus.map((c: Row) => c.statement)).toEqual(['Use the mole']);
    // Version 1 is untouched.
    expect(b.T.student_report_version.find((v: Row) => v.version === 1).content.focus).toHaveLength(2);

    // The parent reads the latest version.
    const seen = await b.service.report('acct-mum', 'kid', report.id, NOW);
    expect(seen).toMatchObject({ version: 2, reason: 'EVIDENCE_CHANGED' });
    await expect(b.service.report('acct-other', 'kid', report.id, NOW)).rejects.toBeInstanceOf(ExamNotFoundError);
    expect((await b.service.dashboard('acct-mum', 'kid', NOW)).reports).toEqual([{ id: report.id, weekStart: '2026-10-04T18:30:00.000Z', weekEnd: '2026-10-11T18:30:00.000Z', version: 2 }]);
  });

  it('the switch: REPORTS_ENABLED', () => {
    expect(reportsEnabled({})).toBe(true);
    expect(reportsEnabled({ REPORTS_ENABLED: 'false' })).toBe(false);
    expect(() => reportsEnabled({ REPORTS_ENABLED: 'off' })).toThrow();
  });
});

describe('an adult student sharing with a parent', () => {
  const tokenOf = (b: ReturnType<typeof build>) => b.sent[b.sent.length - 1].link.split('#t=')[1];

  it('shows the wording; refuses without agreement or with stale wording; sends; the parent accepts and sees the summary', async () => {
    const b = build();
    const status = await b.service.sharing('acct-ann', NOW);
    expect(status).toMatchObject({ canShare: true, isMinor: false, viewers: [], pending: null, consent: { version: 1, draft: true } });
    await expect(b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: false }, NOW)).rejects.toBeInstanceOf(ExamInputError);
    await expect(b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 7, agreed: true }, NOW)).rejects.toThrow(/wording has changed/);
    await expect(b.service.invite('acct-ann', { email: 'ann@example.com', consentVersion: 1, agreed: true }, NOW)).rejects.toThrow(/not yours/);

    expect(await b.service.invite('acct-ann', { email: 'Mum@Example.com', consentVersion: 1, agreed: true }, NOW)).toMatchObject({ maskedEmail: 'm***@example.com' });
    expect(b.privacy.grantConsent).toHaveBeenCalledWith({ studentId: 'ann', purposeCode: 'PARENT_REPORT_SHARING', capacity: 'SELF', actorAccountId: 'acct-ann' }, NOW, expect.anything());
    expect(b.sent[0].link).toMatch(/^https:\/\/app\.example\.com\/parent\/accept#t=[A-Za-z0-9_-]{43}$/);
    // Only the hash of the token is kept.
    expect(JSON.stringify(b.T.parent_share_invitation)).not.toContain(tokenOf(b));
    expect(b.T.parent_share_invitation[0].token_hash).toBe(hashInviteToken(tokenOf(b)));

    // Someone else signed in cannot use the link; the invited address can.
    await expect(b.service.previewInvitation('acct-other', tokenOf(b), NOW)).rejects.toBeInstanceOf(ExamNotPermittedError);
    await expect(b.service.acceptInvitation('acct-ann', tokenOf(b), NOW)).rejects.toBeInstanceOf(ExamNotPermittedError);
    expect(await b.service.acceptInvitation('acct-mum', tokenOf(b), NOW)).toEqual({ studentId: 'ann' });
    await expect(b.service.acceptInvitation('acct-mum', tokenOf(b), NOW)).rejects.toBeInstanceOf(ExamConflictError);

    expect(await b.service.children('acct-mum', NOW)).toEqual([{ studentId: 'ann', label: 'ann-label', basis: 'STUDENT_SHARE' }]);
    expect((await b.service.dashboard('acct-mum', 'ann', NOW)).basis).toBe('STUDENT_SHARE');
    expect((await b.service.sharing('acct-ann', NOW)).viewers).toEqual([expect.objectContaining({ maskedEmail: 'm***@example.com' })]);
  });

  it('stopping sharing ends access at once and withdraws the consent; the parent may also leave', async () => {
    const b = build();
    await b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, NOW);
    await b.service.acceptInvitation('acct-mum', tokenOf(b), NOW);
    const [viewer] = (await b.service.sharing('acct-ann', NOW)).viewers;
    await b.service.stopSharing('acct-ann', viewer.grantId, NOW);
    expect(b.privacy.withdrawConsent).toHaveBeenCalledWith(expect.objectContaining({ actorAccountId: 'acct-ann', reasonCode: 'STUDENT_STOPPED_SHARING' }), NOW, expect.anything());
    await expect(b.service.dashboard('acct-mum', 'ann', NOW)).rejects.toBeInstanceOf(ExamNotFoundError);
    expect(await b.service.children('acct-mum', NOW)).toEqual([]);

    // Share again, then the parent leaves.
    await b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, new Date(NOW.getTime() + 120_000));
    await b.service.acceptInvitation('acct-mum', tokenOf(b), new Date(NOW.getTime() + 120_000));
    await b.service.leave('acct-mum', 'ann', new Date(NOW.getTime() + 130_000));
    await expect(b.service.dashboard('acct-mum', 'ann', NOW)).rejects.toBeInstanceOf(ExamNotFoundError);
    expect(b.T.parent_view_grant.map((g: Row) => g.ended_reason)).toEqual(['STUDENT_STOPPED', 'VIEWER_LEFT']);
  });

  it('a withdrawn consent alone is enough to end access, even if the grant row was left open', async () => {
    const b = build();
    await b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, NOW);
    await b.service.acceptInvitation('acct-mum', tokenOf(b), NOW);
    b.T.consent_withdrawal = [{ consent_record_id: b.T.parent_view_grant[0].consent_record_id }];
    await expect(b.service.dashboard('acct-mum', 'ann', NOW)).rejects.toBeInstanceOf(ExamNotFoundError);
  });

  it('declining closes the invitation and its consent; cancelling does too', async () => {
    const b = build();
    await b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, NOW);
    await b.service.declineInvitation('acct-mum', tokenOf(b), NOW);
    expect(b.T.parent_share_invitation[0].status).toBe('DECLINED');
    expect(b.privacy.withdrawConsent).toHaveBeenLastCalledWith(expect.objectContaining({ reasonCode: 'PARENT_DECLINED' }), NOW, expect.anything());
    await b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, new Date(NOW.getTime() + 120_000));
    await b.service.cancelInvitation('acct-ann', new Date(NOW.getTime() + 130_000));
    expect(b.T.parent_share_invitation[1].status).toBe('CANCELLED');
    await expect(b.service.acceptInvitation('acct-mum', tokenOf(b), NOW)).rejects.toThrow(/already been answered or was cancelled/);
  });

  it('a minor cannot share (their guardian already sees it), and sharing waits for published wording', async () => {
    const b = build({ guardianOf: { 'acct-mum': ['kid'] } });
    const kid = await b.service.sharing('acct-kid', NOW);
    expect(kid).toMatchObject({ canShare: false, isMinor: true, consent: null });
    await expect(b.service.invite('acct-kid', { email: 'mum@example.com', consentVersion: 1, agreed: true }, NOW)).rejects.toThrow(/already sees your progress summary/);

    const none = build({ wording: false });
    expect((await none.service.sharing('acct-ann', NOW)).consent).toBeNull();
    await expect(none.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, NOW)).rejects.toBeInstanceOf(GuardianUnavailableError);
  });

  it('an email that cannot be sent leaves nothing open', async () => {
    const b = build();
    b.mailer.sendShareInvitation.mockRejectedValueOnce(new Error('down'));
    await expect(b.service.invite('acct-ann', { email: 'mum@example.com', consentVersion: 1, agreed: true }, NOW)).rejects.toBeInstanceOf(GuardianUnavailableError);
    expect(b.T.parent_share_invitation[0].status).toBe('CANCELLED');
    expect(b.privacy.withdrawConsent).toHaveBeenCalledWith(expect.objectContaining({ reasonCode: 'NOT_DELIVERED' }), NOW, expect.anything());
  });
});
