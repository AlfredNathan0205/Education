import { ExamConflictError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from '../exam/exam.errors';
import { SocialDisabledError, SocialService, socialEnabled } from './social.service';

/**
 * A small in-memory stand-in for the Prisma calls this service makes: where (equality, in, not, gt/gte/lt/lte, OR,
 * one level of relation filter), include (one or two levels), create with nested create, update, updateMany, count.
 */
type Row = Record<string, any>;
const RELATIONS: Record<string, Record<string, { table: string; many: boolean; local: string; foreign: string }>> = {
  friendship: { approvals: { table: 'friendship_guardian_approval', many: true, local: 'id', foreign: 'friendship_id' } },
  friendship_guardian_approval: { friendship: { table: 'friendship', many: false, local: 'friendship_id', foreign: 'id' } },
  challenge: { participants: { table: 'challenge_participant', many: true, local: 'id', foreign: 'challenge_id' } },
  challenge_participant: { challenge: { table: 'challenge', many: false, local: 'challenge_id', foreign: 'id' } },
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
    if (cond === null) return v === null || v === undefined; // an unset column is NULL, as in Postgres
    return v === cond;
  };
  const matches = (table: string, row: Row, where: any = {}): boolean =>
    Object.entries(where).every(([k, cond]: [string, any]) => {
      if (k === 'OR') return cond.some((w: any) => matches(table, row, w));
      if (k === 'NOT') return !matches(table, row, cond);
      const rel = RELATIONS[table]?.[k];
      if (rel) {
        const target = t(rel.table).find((r) => r[rel.foreign] === row[rel.local]);
        return !!target && matches(rel.table, target, cond);
      }
      if (k.includes('_') && cond && typeof cond === 'object' && !(cond instanceof Date) && Object.keys(cond).every((x) => x in row)) {
        return Object.entries(cond).every(([kk, vv]) => row[kk] === vv); // compound unique, e.g. challenge_id_student_id
      }
      return cmp(row[k], cond);
    });
  const withInclude = (table: string, row: Row, include: any): Row => {
    if (!include) return { ...row };
    const out = { ...row };
    for (const [k, spec] of Object.entries(include) as [string, any][]) {
      const rel = RELATIONS[table]?.[k];
      if (!rel) continue;
      const sub = spec && typeof spec === 'object' ? spec.include : undefined;
      if (rel.many) out[k] = t(rel.table).filter((r) => r[rel.foreign] === row[rel.local]).map((r) => withInclude(rel.table, r, sub));
      else {
        const one = t(rel.table).find((r) => r[rel.foreign] === row[rel.local]);
        out[k] = one ? withInclude(rel.table, one, sub) : null;
      }
    }
    return out;
  };
  const model = (table: string) => ({
    findMany: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(table, r, a.where)).slice(0, a.take ?? 1e9).map((r) => withInclude(table, r, a.include))),
    findFirst: jest.fn(async (a: any = {}) => {
      let rows = t(table).filter((r) => matches(table, r, a.where));
      if (a.orderBy?.created_at === 'desc') rows = [...rows].sort((x, y) => y.created_at - x.created_at);
      return rows[0] ? withInclude(table, rows[0], a.include) : null;
    }),
    findUnique: jest.fn(async (a: any) => {
      const r = t(table).find((x) => matches(table, x, a.where));
      return r ? withInclude(table, r, a.include) : null;
    }),
    count: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(table, r, a.where)).length),
    create: jest.fn(async ({ data }: any) => {
      if (table === 'friend_code' && t(table).some((r) => r.code === data.code)) throw Object.assign(new Error('dup'), { code: 'P2002' });
      const row: Row = { id: `${table}-${++n}`, created_at: new Date(Date.now() + n), at: new Date(), ...data };
      for (const [k, v] of Object.entries(data) as [string, any][]) {
        const rel = RELATIONS[table]?.[k];
        if (rel && v?.create) {
          delete row[k];
          for (const c of v.create) t(rel.table).push({ id: `${rel.table}-${++n}`, created_at: new Date(), [rel.foreign]: row.id, ...c });
        }
      }
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
  const client: any = new Proxy(
    {
      tables,
      $transaction: async (fn: any) => fn(client),
      $queryRaw: jest.fn(async () => []),
      $executeRaw: jest.fn(async (_s: any, studentId: string, handle: string) => {
        if (!t('public_profile').some((p) => p.student_id === studentId)) t('public_profile').push({ student_id: studentId, handle });
      }),
    } as any,
    { get: (target, prop: string) => (prop in target ? target[prop] : (target[prop] = model(prop))) },
  );
  return client;
}

const UNIT = { id: 'sv', curriculum_version_id: 'cv', grade_id: 'g', subject_id: 'chem' };

function build(opts: { enabled?: boolean; minors?: string[]; questions?: number; guardianOf?: Record<string, string[]>; admins?: string[] } = {}) {
  const client = fakeDb();
  for (const s of ['alice', 'bob', 'kid', 'eve']) {
    client.tables.age_classification = client.tables.age_classification ?? [];
    client.tables.age_classification.push({ student_id: s, superseded_at: null, is_minor: (opts.minors ?? ['kid']).includes(s) });
    client.tables.student_academic_context = client.tables.student_academic_context ?? [];
    client.tables.student_academic_context.push({ student_id: s, curriculum_code: 'ICSE', grade_code: 'GRADE_8' });
  }
  client.tables.curriculum_subject_version = [UNIT];
  client.tables.subject = [{ id: 'chem', name: 'Chemistry' }];
  client.tables.chapter = [];
  const total = opts.questions ?? 30;
  // The pool loader is replaced below: questions q1..qN, a third each easy/medium/hard, none seen.
  const pool = Array.from({ length: total }, (_, i) => ({
    revisionId: `r${i}`,
    questionId: `q${i}`,
    objectivePath: `C1/T1/M1/O${i % 4}`,
    difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[i % 3],
    stemHash: `h${i}`,
    lastSeenAt: null,
  }));
  let who = 'alice';
  const exam: any = {
    studentFor: jest.fn(async () => who),
    listUnits: jest.fn(async () => [{ subjectVersionId: 'sv', subjectCode: 'CHEM', subjectName: 'Chemistry' }]),
    createFixed: jest.fn(async (_tx: any, studentId: string, input: any) => {
      const id = `as-${studentId}-${client.tables.assessment_session?.length ?? 0}`;
      (client.tables.assessment_session ??= []).push({ id, student_id: studentId, status: 'IN_PROGRESS', items: input.items });
      return { assessmentId: id };
    }),
  };
  const privacy: any = {
    listGuardianApprovals: jest.fn(async (acct: string) => (opts.guardianOf?.[acct] ?? []).map((s) => ({ studentId: s, displayName: s === 'kid' ? 'Kiran' : null }))),
  };
  const authz: any = { curriculumRolesFor: jest.fn(async (acct: string) => ((opts.admins ?? []).includes(acct) ? ['SUPER_ADMIN'] : [])) };
  const published: any[] = [];
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  const service = new SocialService({ client } as any, exam, privacy, authz, outbox, { enabled: opts.enabled ?? true });
  // Replace the database-reading pool loader with the fixture above.
  jest.spyOn(require('../assembly/pool'), 'loadServablePool').mockImplementation(async () => ({ items: pool.map((p) => ({ ...p })), excluded: 0 }) as any);
  return { service, client, exam, published, as: (s: string) => (who = s), pool };
}

async function friends(b: ReturnType<typeof build>, a: string, c: string) {
  b.as(a);
  const { code } = await b.service.createCode('acct');
  b.as(c);
  return b.service.redeem('acct', code);
}

afterEach(() => jest.restoreAllMocks());

describe('the switch', () => {
  it('is off unless SOCIAL_FEATURES_ENABLED=true; off, nothing works and the overview says so', async () => {
    expect(socialEnabled({})).toBe(false);
    expect(socialEnabled({ SOCIAL_FEATURES_ENABLED: 'true' })).toBe(true);
    expect(() => socialEnabled({ SOCIAL_FEATURES_ENABLED: 'yes' })).toThrow();
    const b = build({ enabled: false });
    expect(await b.service.overview('acct')).toEqual({ enabled: false });
    await expect(b.service.createCode('acct')).rejects.toBeInstanceOf(SocialDisabledError);
    await expect(b.service.guardianPending('g')).rejects.toBeInstanceOf(SocialDisabledError);
  });
});

describe('friends by code', () => {
  it('adults: a shown code makes an active friendship at once; the code works once', async () => {
    const b = build();
    b.as('alice');
    const { code } = await b.service.createCode('acct');
    expect(code).toMatch(/^[A-Z2-9]{6}$/);
    b.as('bob');
    expect(await b.service.redeem('acct', code.toLowerCase())).toMatchObject({ status: 'ACTIVE' });
    b.as('eve');
    await expect(b.service.redeem('acct', code)).rejects.toBeInstanceOf(ExamNotFoundError);
    b.as('bob');
    const view = await b.service.overview('acct');
    expect(view.friends).toEqual([expect.objectContaining({ status: 'ACTIVE', waitingFor: [], handle: expect.stringMatching(/^Learner-/) })]);
    expect(JSON.stringify(view)).not.toMatch(/alice/);
  });

  it('with a minor, the friendship waits for that minor\'s guardian; a decline ends it, an approval activates it', async () => {
    const b = build({ guardianOf: { parent: ['kid'] } });
    const f = await friends(b, 'kid', 'alice');
    expect(f.status).toBe('PENDING_GUARDIAN');
    b.as('alice');
    expect((await b.service.overview('acct')).friends![0]).toMatchObject({ status: 'PENDING_GUARDIAN', waitingFor: ['THEIR_GUARDIAN'] });
    const pending = await b.service.guardianPending('parent');
    expect(pending).toEqual([expect.objectContaining({ studentName: 'Kiran', otherHandle: expect.stringMatching(/^Learner-/) })]);
    expect(await b.service.guardianPending('stranger')).toEqual([]);
    await expect(b.service.guardianDecide('stranger', pending[0].approvalId, true)).rejects.toBeInstanceOf(ExamNotFoundError);
    expect(await b.service.guardianDecide('parent', pending[0].approvalId, true)).toEqual({ friendshipStatus: 'ACTIVE' });
    await expect(b.service.guardianDecide('parent', pending[0].approvalId, false)).rejects.toBeInstanceOf(ExamConflictError);

    const b2 = build({ guardianOf: { parent: ['kid'] } });
    await friends(b2, 'kid', 'bob');
    const [p] = await b2.service.guardianPending('parent');
    expect(await b2.service.guardianDecide('parent', p.approvalId, false)).toEqual({ friendshipStatus: 'ENDED' });
    expect(b2.client.tables.friendship[0]).toMatchObject({ status: 'ENDED', ended_reason: 'GUARDIAN_DECLINED' });
  });

  it('wrong codes are counted (even though the request fails) and limited to 10 an hour', async () => {
    const b = build();
    b.as('bob');
    for (let i = 0; i < 10; i++) await expect(b.service.redeem('acct', 'ZZZZZZ')).rejects.toBeInstanceOf(ExamNotFoundError);
    expect(b.client.tables.friend_code_attempt.filter((a: any) => !a.ok)).toHaveLength(10);
    await expect(b.service.redeem('acct', 'ZZZZZZ')).rejects.toThrow(/Too many/);
  });

  it('at most 5 codes an hour; a blocked pair gets the same answer as a wrong code', async () => {
    const b = build();
    b.as('alice');
    for (let i = 0; i < 5; i++) await b.service.createCode('acct');
    await expect(b.service.createCode('acct')).rejects.toThrow(/at most 5 codes/);
    const c = build();
    c.client.tables.student_block = [{ blocker_student_id: 'alice', blocked_student_id: 'bob' }];
    c.as('alice');
    const { code } = await c.service.createCode('acct');
    c.as('bob');
    await expect(c.service.redeem('acct', code)).rejects.toThrow(/not valid, has been used, or has expired/);
  });
});

describe('block and report', () => {
  it('block ends the friendship and cancels open challenges; report (reason code only) ends it and queues it', async () => {
    const b = build({ admins: ['admin'] });
    const f = await friends(b, 'alice', 'bob');
    b.as('alice');
    await b.service.createChallenge('acct', { friendshipId: f.friendshipId, subjectVersionId: 'sv' });
    b.as('bob');
    await expect(b.service.report('acct', { friendshipId: f.friendshipId, reason: 'he said rude things' })).rejects.toThrow(/reasons/);
    await b.service.report('acct', { friendshipId: f.friendshipId, reason: 'UNWANTED_CONTACT' });
    expect(b.client.tables.friendship[0]).toMatchObject({ status: 'ENDED', ended_reason: 'REPORTED' });
    expect(b.client.tables.challenge[0].status).toBe('CANCELLED');
    const queue = await b.service.reports('admin');
    expect(queue).toEqual([expect.objectContaining({ reason: 'UNWANTED_CONTACT', reported: expect.objectContaining({ studentId: 'alice', openReports: 1, restricted: false }) })]);
    await expect(b.service.reports('bob')).rejects.toBeInstanceOf(ExamNotPermittedError);
    await b.service.resolve('admin', queue[0].id, 'RESTRICTED');
    expect(b.client.tables.social_restriction).toEqual([expect.objectContaining({ student_id: 'alice', created_by_account_id: 'admin' })]);
    expect(b.client.tables.audit_event.map((e: any) => e.action)).toEqual(['safety.reports_viewed', 'safety.report_resolved']);
    b.as('alice');
    await expect(b.service.createCode('acct')).rejects.toBeInstanceOf(ExamNotPermittedError);

    const c = build();
    const g = await friends(c, 'alice', 'bob');
    c.as('alice');
    await c.service.block('acct', g.friendshipId);
    expect(c.client.tables.friendship[0]).toMatchObject({ status: 'ENDED', ended_reason: 'BLOCKED' });
    expect(c.client.tables.student_block).toEqual([expect.objectContaining({ blocker_student_id: 'alice', blocked_student_id: 'bob' })]);
  });
});

describe('ranked challenges', () => {
  it('the same ten unseen questions for both; the other player\'s progress stays hidden until both finish', async () => {
    const b = build();
    const f = await friends(b, 'alice', 'bob');
    b.as('alice');
    const { challengeId } = await b.service.createChallenge('acct', { friendshipId: f.friendshipId, subjectVersionId: 'sv' });
    const c = b.client.tables.challenge[0];
    expect(c.items).toHaveLength(10);
    expect(c.items.map((i: any) => i.difficulty).sort()).toEqual(['EASY', 'EASY', 'EASY', 'EASY', 'EASY', 'HARD', 'HARD', 'MEDIUM', 'MEDIUM', 'MEDIUM']);
    // Only one open challenge per pair and subject.
    await expect(b.service.createChallenge('acct', { friendshipId: f.friendshipId, subjectVersionId: 'sv' })).rejects.toThrow(/already/);

    const a1 = await b.service.start('acct', challengeId); // the challenger may start while waiting
    b.as('bob');
    await expect(b.service.start('acct', challengeId)).rejects.toThrow(/Accept the challenge first/);
    const { assessmentId: b1 } = await b.service.respond('acct', challengeId, true);
    expect(b.exam.createFixed.mock.calls[0][2].items).toEqual(b.exam.createFixed.mock.calls[1][2].items);
    expect(b.exam.createFixed.mock.calls[1][2].blueprint).toBe('CHALLENGE10');

    // Alice finishes; Bob sees nothing of it.
    const sessions = b.client.tables.assessment_session;
    sessions.find((s: any) => s.id === a1.assessmentId).status = 'SUBMITTED';
    (b.client.tables.assessment_result ??= []).push({ session_id: a1.assessmentId, correct: 7, total: 10 });
    let bobView = (await b.service.overview('acct')).challenges![0];
    expect(bobView).toMatchObject({ status: 'ACTIVE', myState: 'IN_PROGRESS', result: null });
    expect(JSON.stringify(bobView)).not.toMatch(/"correct"|IN_PROGRESS.*IN_PROGRESS/);

    sessions.find((s: any) => s.id === b1).status = 'SUBMITTED';
    b.client.tables.assessment_result.push({ session_id: b1, correct: 7, total: 10 });
    bobView = (await b.service.overview('acct')).challenges![0];
    expect(bobView).toMatchObject({ status: 'COMPLETED', result: { mine: { correct: 7 }, theirs: { correct: 7 }, outcome: 'DRAW' } });
  });

  it('refuses when the bank has fewer than ten questions neither has seen', async () => {
    const b = build({ questions: 9 });
    const f = await friends(b, 'alice', 'bob');
    b.as('alice');
    await expect(b.service.createChallenge('acct', { friendshipId: f.friendshipId, subjectVersionId: 'sv' })).rejects.toBeInstanceOf(ExamUnavailableError);
    // A question the opponent has seen does not count either.
    const c = build({ questions: 10 });
    const g = await friends(c, 'alice', 'bob');
    c.client.tables.student_question_exposure = [{ student_id: 'bob', question_id: 'q0' }];
    c.as('alice');
    await expect(c.service.createChallenge('acct', { friendshipId: g.friendshipId, subjectVersionId: 'sv' })).rejects.toThrow(/neither of you has seen/);
  });

  it('a pending friendship (waiting for a guardian) cannot be challenged; declining closes the challenge', async () => {
    const b = build({ guardianOf: { parent: ['kid'] } });
    const f = await friends(b, 'kid', 'alice');
    b.as('alice');
    await expect(b.service.createChallenge('acct', { friendshipId: f.friendshipId, subjectVersionId: 'sv' })).rejects.toThrow(/active/);
    const c = build();
    const g = await friends(c, 'alice', 'bob');
    c.as('alice');
    const { challengeId } = await c.service.createChallenge('acct', { friendshipId: g.friendshipId, subjectVersionId: 'sv' });
    c.as('bob');
    expect(await c.service.respond('acct', challengeId, false)).toEqual({ assessmentId: null });
    expect(c.client.tables.challenge[0].status).toBe('DECLINED');
    await expect(c.service.respond('acct', challengeId, true)).rejects.toBeInstanceOf(ExamConflictError);
  });
});
