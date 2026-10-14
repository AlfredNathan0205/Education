import { ExamService } from './exam.service';
import { QUICK10, type ExamConfig } from './exam-domain';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from './exam.errors';

/**
 * In-memory stand-in for the parts of Prisma this service uses. It checks the service's own logic
 * (gating, assembly wiring, one-at-a-time flow, idempotency, no answer leak, scoring, expiry). Real SQL
 * (row locks, indexes) is covered by the real-database integration tests.
 */
const ACCOUNT = 'acct-1';
const STUDENT = 'stud-1';
const CV = 'cv-1';
const GRADE = 'g8';
const SUBJECT = 'chem';

interface Opts {
  questions?: number;
  /** Blueprints in the database. Defaults to QUICK10 v1 published and switched on, as the migration seeds it. */
  blueprints?: any[];
  focus?: string[];
  unitState?: string;
  classified?: boolean;
  consent?: boolean;
  consentSatisfied?: boolean;
}

function build(opts: Opts = {}, config: Partial<ExamConfig> = {}) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const cfg: ExamConfig = { allowUnactivatedCurriculum: false, resumeHours: 24, ...config };

  const units: any[] = [{ id: 'sv-1', curriculum_version_id: CV, grade_id: GRADE, subject_id: SUBJECT, revision: 1, state: opts.unitState ?? 'ACTIVE' }];
  const chapters = [1, 2, 3].map((c) => ({
    subject_version_id: 'sv-1',
    code: `C${c}`,
    topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [1, 2, 3, 4].map((o) => ({ code: `O${o}` })) }] }],
  }));
  const total = opts.questions ?? 30;
  const revisions: any[] = [];
  for (let q = 1; q <= total; q++) {
    revisions.push({
      id: `r${q}`,
      state: 'APPROVED',
      stem: `Stem ${q}`,
      stem_hash: `h${q}`,
      explanation: `Because ${q}`,
      difficulty: q <= total / 3 ? 'EASY' : q <= (2 * total) / 3 ? 'MEDIUM' : 'HARD',
      question: { id: `q${q}`, objective_path: `C${(q % 3) + 1}/T1/M1/O${(q % 4) + 1}`, curriculum_version_id: CV, grade_id: GRADE, subject_id: SUBJECT },
      options: [1, 2, 3, 4].map((p) => ({ revision_id: `r${q}`, position: p, text: `Opt ${q}-${p}`, is_correct: p === (q % 4) + 1 })),
    });
  }
  const blueprints: any[] = opts.blueprints ?? [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 })];
  const correctPosition = (revisionId: string) => revisions.find((r) => r.id === revisionId).options.find((o: any) => o.is_correct).position;

  const store = {
    instances: [] as any[],
    items: [] as any[],
    sessions: [] as any[],
    responses: [] as any[],
    events: [] as any[],
    submissions: [] as any[],
    results: [] as any[],
    exposures: [] as any[],
    runs: [] as any[],
  };
  const unitWith = (u: any) => ({ ...u, curriculum_version: { label: '2026-27', curriculum: { code: 'ICSE' } }, grade: { code: 'GRADE_8' }, subject: { code: 'CHEM', name: 'Chemistry' } });
  const withPublished = (b: any) => ({ ...b, versions: b.versions.filter((v: any) => v.status === 'PUBLISHED') });

  const compose = (s: any) => {
    const inst = store.instances.find((i) => i.id === s.instance_id);
    return {
      ...s,
      instance: {
        ...inst,
        items: store.items
          .filter((i) => i.instance_id === inst.id)
          .sort((a, b) => a.position - b.position)
          .map((i) => ({ ...i, response: store.responses.find((r) => r.instance_question_id === i.id) ?? null })),
      },
      result: store.results.find((r) => r.session_id === s.id) ?? null,
    };
  };
  const matchSession = (s: any, where: any = {}) =>
    (!where.id || s.id === where.id) &&
    (!where.student_id || s.student_id === where.student_id) &&
    (!where.status || s.status === where.status) &&
    (!where.expires_at?.lte || s.expires_at <= where.expires_at.lte);

  const client: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: async (fn: any) => fn(client),
    account_student_access: {
      findFirst: jest.fn(async ({ where }: any) => (where.account_id === ACCOUNT ? { student_id: STUDENT } : null)),
    },
    curriculum_subject_version: {
      findMany: jest.fn(async ({ where }: any) =>
        units
          .filter((u) => where.state.in.includes(u.state))
          .map(unitWith),
      ),
      findUnique: jest.fn(async ({ where }: any) => {
        const u = units.find((x) => x.id === where.id);
        return u ? unitWith(u) : null;
      }),
      findFirst: jest.fn(async ({ where }: any) =>
        units
          .filter((u) => u.curriculum_version_id === where.curriculum_version_id && u.grade_id === where.grade_id && u.subject_id === where.subject_id && where.state.in.includes(u.state))
          .sort((a, b) => b.revision - a.revision)[0] ?? null,
      ),
    },
    chapter: { findMany: jest.fn(async ({ where }: any) => chapters.filter((c) => c.subject_version_id === where.subject_version_id)) },
    subject: { findMany: jest.fn(async () => [{ id: SUBJECT, name: 'Chemistry' }]) },
    grade: { findMany: jest.fn(async () => [{ id: GRADE, code: 'GRADE_8' }]) },
    question_revision: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.id?.in) return revisions.filter((r) => where.id.in.includes(r.id));
        return revisions.filter((r) => r.state === where.state && r.question.curriculum_version_id === where.question.curriculum_version_id);
      }),
      findUnique: jest.fn(async ({ where }: any) => revisions.find((r) => r.id === where.id) ?? null),
    },
    question_option: {
      findMany: jest.fn(async ({ where }: any) => revisions.find((r) => r.id === where.revision_id).options),
    },
    student_question_exposure: {
      findMany: jest.fn(async ({ where }: any) => store.exposures.filter((e) => e.student_id === where.student_id && where.question_id.in.includes(e.question_id))),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const k = where.student_id_question_id;
        const hit = store.exposures.find((e) => e.student_id === k.student_id && e.question_id === k.question_id);
        if (hit) {
          hit.last_seen_at = update.last_seen_at;
          hit.times_seen += update.times_seen.increment;
        } else store.exposures.push({ ...create, last_seen_at: new Date(), times_seen: 1 });
      }),
    },
    assessment_blueprint: {
      findUnique: jest.fn(async ({ where }: any) => {
        const b = blueprints.find((x) => x.code === where.code);
        return b ? withPublished(b) : null;
      }),
      findMany: jest.fn(async ({ where }: any) => blueprints.filter((b) => b.enabled === where.enabled).map(withPublished)),
    },
    assessment_assembly_run: {
      create: jest.fn(async ({ data }: any) => {
        const { decisions, ...rest } = data;
        store.runs.push({ id: id('run'), ...rest, decisions: decisions.create });
      }),
    },
    student_chapter_selection: {
      findMany: jest.fn(async ({ where }: any) =>
        where.student_id === STUDENT && where.subject_code === 'CHEM' ? (opts.focus ?? []).map((c) => ({ chapter_code: c })) : [],
      ),
    },
    assessment_instance: {
      create: jest.fn(async ({ data }: any) => {
        const { items, ...rest } = data;
        const inst = { id: id('inst'), ...rest };
        store.instances.push(inst);
        for (const it of items.create) store.items.push({ id: id('item'), instance_id: inst.id, ...it });
        return { id: inst.id };
      }),
    },
    assessment_session: {
      create: jest.fn(async ({ data }: any) => {
        const s = { id: id('sess'), status: 'IN_PROGRESS', started_at: new Date(), last_activity_at: new Date(), revisit_used: false, committed_at: null, submitted_at: null, ...data };
        store.sessions.push(s);
        return { id: s.id };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(store.sessions.find((s) => s.id === where.id), data)),
      findFirst: jest.fn(async ({ where }: any) => {
        const s = store.sessions.find((x) => matchSession(x, where));
        return s ? compose(s) : null;
      }),
      findMany: jest.fn(async ({ where, take }: any) => store.sessions.filter((s) => matchSession(s, where)).slice(0, take ?? 99).map(compose)),
    },
    student_response: {
      create: jest.fn(async ({ data }: any) => {
        if (data.idempotency_key && store.responses.some((r) => r.session_id === data.session_id && r.idempotency_key === data.idempotency_key)) throw Object.assign(new Error('dup'), { code: 'P2002' });
        store.responses.push({ id: id('resp'), skip_count: 0, state: null, presented_at: null, selected_slot: null, selected_position: null, is_correct: null, idempotency_key: null, ...data });
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(store.responses.find((r) => r.id === where.id), data)),
    },
    student_response_event: { create: jest.fn(async ({ data }: any) => store.events.push(data)) },
    assessment_submission: { create: jest.fn(async ({ data }: any) => store.submissions.push(data)) },
    assessment_result: { create: jest.fn(async ({ data }: any) => store.results.push(data)) },
  };

  const published: any[] = [];
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => published.push(e)) };
  const privacy: any = {
    reclassifyIfStale: jest.fn(async () => undefined),
    getClassificationSummary: jest.fn(async () => ({
      classified: opts.classified ?? true,
      requiresGuardianConsent: opts.consent ?? false,
      consentSatisfied: opts.consentSatisfied ?? false,
      basis: 'POLICY',
    })),
  };
  const service = new ExamService({ client } as any, privacy, outbox, cfg);
  return { service, store, client, published, privacy, units, revisions, correctPosition };
}

/** A blueprint row as Prisma returns it with its versions and their parts. */
function blueprint(
  code: string,
  mix: Record<'EASY' | 'MEDIUM' | 'HARD', number>,
  over: { enabled?: boolean; status?: string; scope?: string; strict?: boolean; chapters?: string[]; subject?: string | null } = {},
): any {
  const total = mix.EASY + mix.MEDIUM + mix.HARD;
  return {
    id: `bp-${code}`,
    code,
    name: `${code} test`,
    enabled: over.enabled ?? true,
    curriculum_code: over.subject ? 'ICSE' : null,
    grade_code: over.subject ? 'GRADE_8' : null,
    subject_code: over.subject ?? null,
    versions: [
      {
        id: `bv-${code}-1`,
        version: 1,
        status: over.status ?? 'PUBLISHED',
        total_questions: total,
        prefer_unseen: true,
        opening_difficulty: 'EASY',
        scope_mode: over.scope ?? 'WHOLE_SUBJECT',
        scope_strict: over.strict ?? false,
        difficulties: (['EASY', 'MEDIUM', 'HARD'] as const).map((d) => ({ difficulty: d, count: mix[d] })),
        types: [{ question_type: 'MCQ', count: total }],
        cells: [],
        scopes: (over.chapters ?? []).map((c) => ({ chapter_code: c })),
      },
    ],
  };
}

/** The displayed slot that holds the correct answer for the current item. */
function correctSlot(h: ReturnType<typeof build>, position: number): number {
  const item = h.store.items.find((i) => i.position === position);
  return item.option_order.indexOf(h.correctPosition(item.question_revision_id));
}
function wrongSlot(h: ReturnType<typeof build>, position: number): number {
  return (correctSlot(h, position) + 1) % 4;
}

let keyN = 0;
const key = () => `key-${String(++keyN).padStart(8, '0')}`;

async function start(h: ReturnType<typeof build>, mode: 'TEST' | 'PRACTICE' = 'TEST') {
  return h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode });
}
async function answerAll(h: ReturnType<typeof build>, id: string, correctUpTo = 10) {
  for (let p = 1; p <= 10; p++) {
    await h.service.present(ACCOUNT, id);
    await h.service.lock(ACCOUNT, id, p, { slot: p <= correctUpTo ? correctSlot(h, p) : wrongSlot(h, p), activeMs: 1500, idempotencyKey: key() });
  }
}

describe('ExamService: who may take a test', () => {
  it('needs a student profile', async () => {
    const h = build();
    await expect(h.service.listUnits('someone-else')).rejects.toBeInstanceOf(ExamNotPermittedError);
  });
  it('needs an age classification', async () => {
    await expect(build({ classified: false }).service.listUnits(ACCOUNT)).rejects.toThrow(/Finish your profile/);
  });
  it('fails closed while guardian consent is required', async () => {
    const h = build({ consent: true });
    await expect(h.service.listUnits(ACCOUNT)).rejects.toThrow(/parent or guardian/);
    await expect(start(h)).rejects.toBeInstanceOf(ExamNotPermittedError);
    expect(h.store.sessions).toHaveLength(0);
  });
  it('lets a student through once a valid guardian approval exists', async () => {
    const h = build({ consent: true, consentSatisfied: true });
    await expect(h.service.listUnits(ACCOUNT)).resolves.toBeDefined();
    await expect(start(h)).resolves.toMatchObject({ resumed: false });
  });
});

describe('ExamService.listUnits', () => {
  it('lists an ACTIVE subject with its usable question count', async () => {
    const [u] = await build().service.listUnits(ACCOUNT);
    expect(u).toMatchObject({ subjectVersionId: 'sv-1', curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectName: 'Chemistry', usableQuestions: 30, ready: true });
  });
  it('is not ready with fewer than 10 usable questions', async () => {
    const [u] = await build({ questions: 9 }).service.listUnits(ACCOUNT);
    expect(u.ready).toBe(false);
  });
  it('does not list an unactivated curriculum in strict mode', async () => {
    expect(await build({ unitState: 'AI_STRUCTURED' }).service.listUnits(ACCOUNT)).toEqual([]);
  });
  it('lists it with the development switch on', async () => {
    const h = build({ unitState: 'AI_STRUCTURED' }, { allowUnactivatedCurriculum: true });
    expect(await h.service.listUnits(ACCOUNT)).toHaveLength(1);
  });
  it('does not serve a suspended or superseded curriculum even with the switch on', async () => {
    for (const unitState of ['SUSPENDED', 'SUPERSEDED', 'REJECTED']) {
      expect(await build({ unitState }, { allowUnactivatedCurriculum: true }).service.listUnits(ACCOUNT)).toEqual([]);
    }
  });
  it('does not count a question whose objective is gone from the curriculum', async () => {
    const h = build();
    h.revisions[0].question.objective_path = 'C9/T1/M1/O1';
    const [u] = await h.service.listUnits(ACCOUNT);
    expect(u.usableQuestions).toBe(29);
  });
  it('does not count questions that are not APPROVED', async () => {
    const h = build();
    h.revisions[0].state = 'RETIRED';
    h.revisions[1].state = 'IN_REVIEW';
    const [u] = await h.service.listUnits(ACCOUNT);
    expect(u.usableQuestions).toBe(28);
  });
});

describe('ExamService.create', () => {
  it('locks 10 questions, creates a session, and publishes created and started', async () => {
    const h = build();
    const r = await start(h);
    expect(r.resumed).toBe(false);
    expect(h.store.items).toHaveLength(10);
    expect(new Set(h.store.items.map((i) => i.question_revision_id)).size).toBe(10);
    expect(h.store.instances[0]).toMatchObject({ blueprint_code: QUICK10.code, mode: 'TEST', subject_version_id: 'sv-1' });
    expect(h.store.instances[0].assembly_report.delivered).toEqual({ EASY: 5, MEDIUM: 3, HARD: 2 });
    expect(h.store.sessions[0].expires_at.getTime() - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    expect(h.published.map((e) => e.eventType)).toEqual(['assessment.created.v1', 'assessment.started.v1']);
  });
  it('returns the open one when started again for the same subject and mode', async () => {
    const h = build();
    const a = await start(h);
    const b = await start(h);
    expect(b).toEqual({ assessmentId: a.assessmentId, resumed: true });
    expect(h.store.sessions).toHaveLength(1);
  });
  it('allows a PRACTICE alongside an open TEST', async () => {
    const h = build();
    await start(h, 'TEST');
    expect((await start(h, 'PRACTICE')).resumed).toBe(false);
    expect(h.store.sessions).toHaveLength(2);
  });
  it('refuses with too few approved questions', async () => {
    await expect(start(build({ questions: 9 }))).rejects.toBeInstanceOf(ExamUnavailableError);
  });
  it('refuses a subject that is not served', async () => {
    await expect(start(build({ unitState: 'APPROVED' }))).rejects.toThrow(/not open for tests/);
  });
  it('refuses a stale subject id when a newer revision is served', async () => {
    const h = build();
    h.units.push({ id: 'sv-2', curriculum_version_id: CV, grade_id: GRADE, subject_id: SUBJECT, revision: 2, state: 'ACTIVE' });
    await expect(start(h)).rejects.toBeInstanceOf(ExamConflictError);
  });
  it('refuses an unknown subject and a bad mode', async () => {
    const h = build();
    await expect(h.service.create(ACCOUNT, { subjectVersionId: 'nope', mode: 'TEST' })).rejects.toBeInstanceOf(ExamNotFoundError);
    await expect(h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'EXAM' })).rejects.toBeInstanceOf(ExamInputError);
  });
  it('takes the student row lock', async () => {
    const h = build();
    await start(h);
    expect(h.client.$queryRaw).toHaveBeenCalled();
  });
});

describe('ExamService.present: one question at a time, no answer keys', () => {
  it('shows question 1 with four options and nothing that reveals the answer', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    const v = await h.service.present(ACCOUNT, assessmentId);
    expect(v).toMatchObject({ phase: 'QUESTION', status: 'IN_PROGRESS', mode: 'TEST', total: 10, answered: 0 });
    expect(v.question).toMatchObject({ position: 1, total: 10, pass: 'MAIN' });
    expect(v.question!.options.map((o) => o.slot)).toEqual([0, 1, 2, 3]);
    const text = JSON.stringify(v).toLowerCase();
    for (const banned of ['is_correct', 'iscorrect', 'correct', 'explanation', 'because']) expect(text).not.toContain(banned);
  });
  it('maps displayed slots through the locked option order', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    const v = await h.service.present(ACCOUNT, assessmentId);
    const item = h.store.items.find((i) => i.position === 1);
    const qn = item.question_revision_id.replace('r', '');
    expect(v.question!.options.map((o) => o.text)).toEqual(item.option_order.map((p: number) => `Opt ${qn}-${p}`));
  });
  it('is safe to repeat: same question, one exposure, one presented event', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    const a = await h.service.present(ACCOUNT, assessmentId);
    const b = await h.service.present(ACCOUNT, assessmentId);
    expect(b.question).toEqual(a.question);
    expect(h.store.exposures).toHaveLength(1);
    expect(h.store.exposures[0].times_seen).toBe(1);
    expect(h.store.events.filter((e) => e.event_type === 'PRESENTED')).toHaveLength(1);
  });
  it('another student cannot see it', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    h.store.sessions[0].student_id = 'someone-else';
    await expect(h.service.present(ACCOUNT, assessmentId)).rejects.toBeInstanceOf(ExamNotFoundError);
  });
});

describe('ExamService.lock', () => {
  it('locks an answer in TEST and reveals nothing', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    const r = await h.service.lock(ACCOUNT, assessmentId, 1, { slot: correctSlot(h, 1), activeMs: 4000, idempotencyKey: key() });
    expect(r).toEqual({ locked: true });
    expect(h.store.responses[0]).toMatchObject({ state: 'LOCKED', is_correct: true, active_ms: 4000 });
    expect(h.store.responses[0].server_elapsed_ms).not.toBeNull();
  });
  it('the first lock in a TEST commits the competitive attempt, once', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    expect(h.store.sessions[0].committed_at).toBeNull();
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: key() });
    const firstCommit = h.store.sessions[0].committed_at;
    expect(firstCommit).not.toBeNull();
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 2, { slot: 0, activeMs: 1, idempotencyKey: key() });
    expect(h.store.sessions[0].committed_at).toBe(firstCommit);
  });
  it('PRACTICE does not commit and reveals that question only', async () => {
    const h = build();
    const { assessmentId } = await start(h, 'PRACTICE');
    await h.service.present(ACCOUNT, assessmentId);
    const cs = correctSlot(h, 1);
    const wrong = await h.service.lock(ACCOUNT, assessmentId, 1, { slot: wrongSlot(h, 1), activeMs: 1, idempotencyKey: key() });
    expect(wrong.reveal).toMatchObject({ correct: false, correctSlot: cs });
    expect(wrong.reveal!.explanation).toMatch(/^Because/);
    expect(h.store.sessions[0].committed_at).toBeNull();
    const v = await h.service.present(ACCOUNT, assessmentId);
    expect(JSON.stringify(v).toLowerCase()).not.toContain('because'); // next question shows no key
  });
  it('is idempotent: the same request again returns the same answer and changes nothing', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    const k = key();
    const a = await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 2, activeMs: 10, idempotencyKey: k });
    const b = await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 2, activeMs: 99, idempotencyKey: k });
    expect(b).toEqual(a);
    expect(h.store.events.filter((e) => e.event_type === 'LOCKED')).toHaveLength(1);
    expect(h.store.responses[0].active_ms).toBe(10);
  });
  it('rejects a different answer for an already locked question', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: key() });
    await expect(h.service.lock(ACCOUNT, assessmentId, 1, { slot: 1, activeMs: 1, idempotencyKey: key() })).rejects.toBeInstanceOf(ExamConflictError);
    expect(h.store.responses[0].selected_slot).toBe(0);
  });
  it('rejects the same key with a different answer', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    const k = key();
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: k });
    await expect(h.service.lock(ACCOUNT, assessmentId, 1, { slot: 3, activeMs: 1, idempotencyKey: k })).rejects.toBeInstanceOf(ExamConflictError);
  });
  it('rejects a key already used for another question', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    const k = key();
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: k });
    await h.service.present(ACCOUNT, assessmentId);
    await expect(h.service.lock(ACCOUNT, assessmentId, 2, { slot: 0, activeMs: 1, idempotencyKey: k })).rejects.toBeInstanceOf(ExamConflictError);
  });
  it('only the current question can be answered (no jumping ahead, no going back)', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await expect(h.service.lock(ACCOUNT, assessmentId, 5, { slot: 0, activeMs: 1, idempotencyKey: key() })).rejects.toThrow(/not the current/);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: key() });
    await expect(h.service.lock(ACCOUNT, assessmentId, 1, { slot: 1, activeMs: 1, idempotencyKey: key() })).rejects.toBeInstanceOf(ExamConflictError);
  });
  it('rejects a slot outside 0 to 3, and an unknown question', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await expect(h.service.lock(ACCOUNT, assessmentId, 1, { slot: 4, activeMs: 1, idempotencyKey: key() })).rejects.toBeInstanceOf(ExamInputError);
    await expect(h.service.lock(ACCOUNT, assessmentId, 11, { slot: 0, activeMs: 1, idempotencyKey: key() })).rejects.toBeInstanceOf(ExamNotFoundError);
  });
  it('clamps absurd active times', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 9e12, idempotencyKey: key() });
    expect(h.store.responses[0].active_ms).toBe(15 * 60 * 1000);
  });
  it('publishes answer_locked without the answer', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: key() });
    const e = h.published.find((x) => x.eventType === 'assessment.answer_locked.v1');
    expect(e).toBeDefined();
    expect(JSON.stringify(e.payload)).not.toMatch(/slot|selected|correct/i);
  });
});

describe('ExamService: skip, revisit once, submit', () => {
  it('skips, moves on, then revisits the skipped question once', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.skip(ACCOUNT, assessmentId, 1, { activeMs: 500 });
    for (let p = 2; p <= 10; p++) {
      const v = await h.service.present(ACCOUNT, assessmentId);
      expect(v.question!.position).toBe(p);
      await h.service.lock(ACCOUNT, assessmentId, p, { slot: correctSlot(h, p), activeMs: 1, idempotencyKey: key() });
    }
    const summary = await h.service.present(ACCOUNT, assessmentId);
    expect(summary).toMatchObject({ phase: 'SUMMARY', summary: { answered: 9, unanswered: 1, canReviewSkipped: true } });
    expect(summary.question).toBeUndefined();

    await h.service.reviewSkipped(ACCOUNT, assessmentId);
    const again = await h.service.present(ACCOUNT, assessmentId);
    expect(again.question).toMatchObject({ position: 1, pass: 'REVISIT' });
    await h.service.skip(ACCOUNT, assessmentId, 1, { activeMs: 5 });
    const end = await h.service.present(ACCOUNT, assessmentId);
    expect(end).toMatchObject({ phase: 'SUMMARY', summary: { answered: 9, unanswered: 1, canReviewSkipped: false } });
    expect(h.store.responses.find((r) => r.state === 'SKIPPED').skip_count).toBe(2);
    await expect(h.service.reviewSkipped(ACCOUNT, assessmentId)).rejects.toBeInstanceOf(ExamConflictError);
  });
  it('a skipped question can be answered on the revisit', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.skip(ACCOUNT, assessmentId, 1, { activeMs: 1 });
    for (let p = 2; p <= 10; p++) {
      await h.service.present(ACCOUNT, assessmentId);
      await h.service.lock(ACCOUNT, assessmentId, p, { slot: 0, activeMs: 1, idempotencyKey: key() });
    }
    await h.service.reviewSkipped(ACCOUNT, assessmentId);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: correctSlot(h, 1), activeMs: 1, idempotencyKey: key() });
    expect(await h.service.present(ACCOUNT, assessmentId)).toMatchObject({ phase: 'SUMMARY', summary: { answered: 10, unanswered: 0 } });
  });
  it('cannot review skipped when nothing was skipped', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId);
    await expect(h.service.reviewSkipped(ACCOUNT, assessmentId)).rejects.toThrow(/nothing to review/);
  });
  it('cannot skip out of order', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await expect(h.service.skip(ACCOUNT, assessmentId, 3, { activeMs: 1 })).rejects.toBeInstanceOf(ExamConflictError);
  });
  it('cannot submit before reaching the summary', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await expect(h.service.submit(ACCOUNT, assessmentId)).rejects.toThrow(/Answer or skip every question/);
    expect(h.store.results).toHaveLength(0);
  });
  it('may submit anyway with skipped questions left; they score zero', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.skip(ACCOUNT, assessmentId, 1, { activeMs: 1 });
    for (let p = 2; p <= 10; p++) {
      await h.service.present(ACCOUNT, assessmentId);
      await h.service.lock(ACCOUNT, assessmentId, p, { slot: correctSlot(h, p), activeMs: 1, idempotencyKey: key() });
    }
    await h.service.submit(ACCOUNT, assessmentId);
    expect(h.store.results[0]).toMatchObject({ total: 10, correct: 9, unanswered: 1, competitive_eligible: true, scoring_policy: 'QUICK10_V1' });
    expect(h.store.submissions[0]).toMatchObject({ reason: 'STUDENT', answered_count: 9, unanswered_count: 1 });
  });
});

describe('ExamService: submit, score, review', () => {
  it('scores deterministically and publishes submitted and scored', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId, 7);
    await h.service.submit(ACCOUNT, assessmentId);
    expect(h.store.results[0]).toMatchObject({ total: 10, correct: 7, unanswered: 0 });
    const by = h.store.results[0].by_difficulty;
    expect(by.EASY.total + by.MEDIUM.total + by.HARD.total).toBe(10);
    expect(by.EASY.correct + by.MEDIUM.correct + by.HARD.correct).toBe(7);
    expect(h.published.map((e) => e.eventType)).toEqual(expect.arrayContaining(['assessment.submitted.v1', 'assessment.scored.v1']));
    expect(h.store.sessions[0]).toMatchObject({ status: 'SUBMITTED' });
  });
  it('submitting twice is harmless', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId);
    await h.service.submit(ACCOUNT, assessmentId);
    await expect(h.service.submit(ACCOUNT, assessmentId)).resolves.toEqual({ submitted: true });
    expect(h.store.results).toHaveLength(1);
    expect(h.store.submissions).toHaveLength(1);
  });
  it('shows no result and no answers until submitted', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId);
    await expect(h.service.result(ACCOUNT, assessmentId)).rejects.toThrow(/after you submit/);
  });
  it('a PRACTICE result is not competitive', async () => {
    const h = build();
    const { assessmentId } = await start(h, 'PRACTICE');
    await answerAll(h, assessmentId);
    await h.service.submit(ACCOUNT, assessmentId);
    expect(h.store.results[0].competitive_eligible).toBe(false);
  });
  it('full review after submit: every option, which was right, which was chosen', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId, 6);
    await h.service.submit(ACCOUNT, assessmentId);
    const r = await h.service.result(ACCOUNT, assessmentId);
    expect(r).toMatchObject({ total: 10, correct: 6, unanswered: 0, mode: 'TEST', competitiveEligible: true });
    expect(r.items).toHaveLength(10);
    expect(r.items.filter((i) => i.outcome === 'CORRECT')).toHaveLength(6);
    expect(r.items.filter((i) => i.outcome === 'INCORRECT')).toHaveLength(4);
    for (const i of r.items) {
      expect(i.options).toHaveLength(4);
      expect(i.options.filter((o) => o.isCorrect)).toHaveLength(1);
      expect(i.options.filter((o) => o.chosen)).toHaveLength(1);
      expect(i.explanation).toMatch(/^Because/);
      if (i.outcome === 'CORRECT') expect(i.options.find((o) => o.chosen)!.isCorrect).toBe(true);
      else expect(i.options.find((o) => o.chosen)!.isCorrect).toBe(false);
    }
  });
  it('the review marks skipped questions UNANSWERED', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.skip(ACCOUNT, assessmentId, 1, { activeMs: 1 });
    for (let p = 2; p <= 10; p++) {
      await h.service.present(ACCOUNT, assessmentId);
      await h.service.lock(ACCOUNT, assessmentId, p, { slot: 0, activeMs: 1, idempotencyKey: key() });
    }
    await h.service.submit(ACCOUNT, assessmentId);
    const r = await h.service.result(ACCOUNT, assessmentId);
    expect(r.items[0].outcome).toBe('UNANSWERED');
    expect(r.items[0].options.some((o) => o.chosen)).toBe(false);
  });
  it('nothing can be locked after submit', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId);
    await h.service.submit(ACCOUNT, assessmentId);
    await expect(h.service.lock(ACCOUNT, assessmentId, 1, { slot: 1, activeMs: 1, idempotencyKey: key() })).rejects.toBeInstanceOf(ExamConflictError);
    await expect(h.service.skip(ACCOUNT, assessmentId, 1, { activeMs: 1 })).rejects.toBeInstanceOf(ExamConflictError);
  });
});

describe('ExamService: the resume window', () => {
  it('after the window with answers locked, the attempt is scored as it stands', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: correctSlot(h, 1), activeMs: 1, idempotencyKey: key() });
    h.store.sessions[0].expires_at = new Date(Date.now() - 1000);
    const v = await h.service.present(ACCOUNT, assessmentId);
    expect(v).toMatchObject({ phase: 'ENDED', status: 'SUBMITTED' });
    expect(h.store.results[0]).toMatchObject({ correct: 1, unanswered: 9, competitive_eligible: true });
    expect(h.store.submissions[0].reason).toBe('EXPIRED');
  });
  it('after the window with nothing locked, it is void and has no result', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    h.store.sessions[0].expires_at = new Date(Date.now() - 1000);
    expect(await h.service.present(ACCOUNT, assessmentId)).toMatchObject({ phase: 'ENDED', status: 'VOID' });
    expect(h.store.results).toHaveLength(0);
    await expect(h.service.result(ACCOUNT, assessmentId)).rejects.toThrow(/expired/);
  });
  it('locking after the window is refused', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    h.store.sessions[0].expires_at = new Date(Date.now() - 1000);
    await expect(h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: key() })).rejects.toThrow(/expired/);
  });
  it('submitting or skipping after the window is refused, and the attempt is settled', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await h.service.present(ACCOUNT, assessmentId);
    await h.service.lock(ACCOUNT, assessmentId, 1, { slot: 0, activeMs: 1, idempotencyKey: key() });
    h.store.sessions[0].expires_at = new Date(Date.now() - 1000);
    await expect(h.service.skip(ACCOUNT, assessmentId, 2, { activeMs: 1 })).rejects.toThrow(/expired/);
    expect(h.store.results).toHaveLength(1);
    await expect(h.service.submit(ACCOUNT, assessmentId)).resolves.toEqual({ submitted: true });
    expect(h.store.results).toHaveLength(1);
  });
  it('an expired open test does not block starting a new one', async () => {
    const h = build();
    const a = await start(h);
    h.store.sessions[0].expires_at = new Date(Date.now() - 1000);
    const b = await start(h);
    expect(b.resumed).toBe(false);
    expect(b.assessmentId).not.toBe(a.assessmentId);
    expect(h.store.sessions[0].status).toBe('VOID');
  });
  it('listMine settles expired ones and shows scores', async () => {
    const h = build();
    const { assessmentId } = await start(h);
    await answerAll(h, assessmentId, 4);
    await h.service.submit(ACCOUNT, assessmentId);
    const rows = await h.service.listMine(ACCOUNT);
    expect(rows[0]).toMatchObject({ assessmentId, status: 'SUBMITTED', correct: 4, total: 10, subjectName: 'Chemistry', gradeCode: 'GRADE_8' });
  });
});

describe('ExamService: exposure and variety across tests', () => {
  it('a second test avoids questions already seen when enough unseen remain', async () => {
    const h = build();
    const a = await start(h);
    await answerAll(h, a.assessmentId);
    await h.service.submit(ACCOUNT, a.assessmentId);
    const firstIds = new Set(h.store.items.map((i) => i.question_id));
    expect(h.store.exposures).toHaveLength(10);

    const b = await start(h);
    expect(b.resumed).toBe(false);
    const secondItems = h.store.items.filter((i) => i.instance_id === h.store.instances[1].id);
    expect(secondItems).toHaveLength(10);
    expect(secondItems.filter((i) => firstIds.has(i.question_id))).toHaveLength(0);
    expect(h.store.instances[1].assembly_report.unseen).toBe(10);
  });
});

describe('ExamService: tests built from published blueprints (Step 10)', () => {
  it('records how the test was assembled: the version, one decision per question, and what was relaxed', async () => {
    const h = build();
    await start(h);
    expect(h.store.instances[0]).toMatchObject({ blueprint_code: 'QUICK10', blueprint_version: 1 });
    expect(h.store.runs).toHaveLength(1);
    const run = h.store.runs[0];
    expect(run).toMatchObject({ instance_id: h.store.instances[0].id, blueprint_version_id: 'bv-QUICK10-1', engine_version: 'assembly-v1', mode: 'TEST', relaxed: false });
    expect(run.seed).toBe(h.store.instances[0].seed);
    expect(run.decisions).toHaveLength(10);
    expect(run.decisions.map((d: any) => d.position)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    for (const d of run.decisions) {
      const item = h.store.items.find((i) => i.position === d.position);
      expect(d.question_revision_id).toBe(item.question_revision_id);
    }
  });

  it('lists the tests a student may take for each subject', async () => {
    const h = build({ blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }), blueprint('SUBJECT20', { EASY: 8, MEDIUM: 7, HARD: 5 }), blueprint('OFF', { EASY: 1, MEDIUM: 0, HARD: 0 }, { enabled: false })] });
    const [u] = await h.service.listUnits(ACCOUNT);
    expect(u.tests).toEqual([
      { code: 'QUICK10', name: 'QUICK10 test', total: 10, ready: true },
      { code: 'SUBJECT20', name: 'SUBJECT20 test', total: 20, ready: true },
    ]);
    const [few] = await build({ questions: 15, blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }), blueprint('SUBJECT20', { EASY: 8, MEDIUM: 7, HARD: 5 })] }).service.listUnits(ACCOUNT);
    expect(few.tests.map((t) => t.ready)).toEqual([true, false]);
  });

  it('builds a 20-question test from its blueprint', async () => {
    const h = build({ blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }), blueprint('SUBJECT20', { EASY: 8, MEDIUM: 7, HARD: 5 })] });
    await h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'TEST', blueprint: 'SUBJECT20' });
    expect(h.store.items).toHaveLength(20);
    expect(h.store.instances[0].assembly_report.delivered).toEqual({ EASY: 8, MEDIUM: 7, HARD: 5 });
    expect(h.published.find((e) => e.eventType === 'assessment.created.v1')!.payload).toMatchObject({ blueprint: 'SUBJECT20', blueprintVersion: 1 });
  });

  it('keeps one open test per blueprint: the same one resumes, a different one is new', async () => {
    const h = build({ blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }), blueprint('SUBJECT20', { EASY: 8, MEDIUM: 7, HARD: 5 })] });
    const a = await start(h);
    expect(await start(h)).toEqual({ assessmentId: a.assessmentId, resumed: true });
    const b = await h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'TEST', blueprint: 'SUBJECT20' });
    expect(b.resumed).toBe(false);
    expect(b.assessmentId).not.toBe(a.assessmentId);
  });

  it('refuses a blueprint that is unknown, switched off, unpublished or for another subject', async () => {
    const cases = [
      { blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }, { enabled: false })] },
      { blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }, { status: 'DRAFT' })] },
      { blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }, { subject: 'PHYS' })] },
      { blueprints: [] },
    ];
    for (const opts of cases) {
      const h = build(opts);
      await expect(start(h)).rejects.toThrow(/not available/);
      expect(h.store.instances).toHaveLength(0);
      const [u] = await h.service.listUnits(ACCOUNT);
      expect(u.ready).toBe(false);
    }
    await expect(start(build({ blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }, { subject: 'CHEM' })] }))).resolves.toMatchObject({ resumed: false });
  });

  it('refuses a malformed blueprint code before touching anything', async () => {
    const h = build();
    await expect(h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'TEST', blueprint: 'quick 10' })).rejects.toBeInstanceOf(ExamInputError);
  });

  it('a focus blueprint uses the chapters the student chose', async () => {
    const focus = blueprint('FOCUS10', { EASY: 4, MEDIUM: 3, HARD: 3 }, { scope: 'STUDENT_FOCUS', strict: true });
    const h = build({ blueprints: [focus], focus: ['C2'] });
    await h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'PRACTICE', blueprint: 'FOCUS10' });
    expect(h.store.items.every((i) => i.objective_path.startsWith('C2/'))).toBe(true);
    expect(h.store.instances[0].assembly_report.scope).toEqual({ mode: 'STUDENT_FOCUS', strict: true, chapters: ['C2'] });
  });

  it('a strict focus blueprint asks the student to choose chapters first', async () => {
    const h = build({ blueprints: [blueprint('FOCUS10', { EASY: 4, MEDIUM: 3, HARD: 3 }, { scope: 'STUDENT_FOCUS', strict: true })] });
    await expect(h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'TEST', blueprint: 'FOCUS10' })).rejects.toThrow(/Choose the chapters/);
  });

  it('scores a non-Quick-10 test under the general policy name', async () => {
    const h = build({ blueprints: [blueprint('QUICK10', { EASY: 5, MEDIUM: 3, HARD: 2 }), blueprint('SHORT', { EASY: 1, MEDIUM: 1, HARD: 0 })] });
    const { assessmentId } = await h.service.create(ACCOUNT, { subjectVersionId: 'sv-1', mode: 'TEST', blueprint: 'SHORT' });
    for (let p = 1; p <= 2; p++) {
      await h.service.present(ACCOUNT, assessmentId);
      await h.service.lock(ACCOUNT, assessmentId, p, { slot: correctSlot(h, p), activeMs: 1000, idempotencyKey: key() });
    }
    await h.service.submit(ACCOUNT, assessmentId);
    expect(h.store.results[0]).toMatchObject({ total: 2, correct: 2, scoring_policy: 'ONE_MARK_PER_CORRECT_V1' });
  });
});
