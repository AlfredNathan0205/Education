import { QuestionConflictError, QuestionNotFoundError } from './question.errors';
import { QuestionTransitionError, stemHash, type QuestionActor, type QuestionDraft } from './question-domain';
import { QuestionService, type UnitIdentity } from './question.service';
import { parseQuestionsCsv } from './import/question-import';

/**
 * A small in-memory stand-in for the parts of Prisma this service uses. It checks the service's own
 * logic (planning, supersede, separation of duties); real SQL (locks, indexes) is covered by the
 * real-database integration tests.
 */
const UNIT: UnitIdentity = { curriculumVersionId: 'cv', gradeId: 'g', subjectId: 's', latestRevisionId: 'sv2', latestRevisionState: 'DRAFT' };
const TREE = [
  { code: 'C1', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'O1' }, { code: 'O2' }] }] }] },
  { code: 'C2', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'DUP' }] }, { code: 'M2', learning_objectives: [{ code: 'DUP' }] }] }] },
];

function makeDb(tree: any[] = TREE) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const questions: any[] = [];
  const revisions: any[] = [];
  const options: any[] = [];
  const events: any[] = [];
  let currentTree = tree;

  const withRevs = (q: any, take?: number) => ({
    ...q,
    revisions: revisions
      .filter((r) => r.question_id === q.id)
      .sort((a, b) => b.revision - a.revision)
      .slice(0, take ?? 99)
      .map((r) => ({ ...r, options: options.filter((o) => o.revision_id === r.id).sort((a, b) => a.position - b.position) })),
  });

  const client: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    curriculum_subject_version: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === 'sv1' || where.id === 'sv2' ? { curriculum_version_id: 'cv', grade_id: 'g', subject_id: 's' } : null)),
      findFirst: jest.fn(async () => ({ id: 'sv2', state: 'DRAFT' })),
    },
    chapter: { findMany: jest.fn(async () => currentTree) },
    question: {
      findMany: jest.fn(async ({ where }: any) => {
        const list = questions.filter((q) => (where.code?.in ? where.code.in.includes(q.code) : true));
        return list.map((q) => withRevs(q, 1));
      }),
      create: jest.fn(async ({ data }: any) => {
        const q = { id: id('q'), ...data };
        questions.push(q);
        return { id: q.id };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(questions.find((q) => q.id === where.id), data)),
    },
    question_revision: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.stem_hash) {
          return revisions
            .filter((r) => where.stem_hash.in.includes(r.stem_hash) && r.state !== 'SUPERSEDED')
            .map((r) => ({ stem_hash: r.stem_hash, question: { code: questions.find((q) => q.id === r.question_id).code } }));
        }
        return revisions.filter((r) => r.question_id === where.question_id && r.state === where.state && r.id !== where.id.not).map((r) => ({ id: r.id }));
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const r = revisions.find((x) => x.id === where.id);
        if (!r) return null;
        return { ...r, options: options.filter((o) => o.revision_id === r.id), question: questions.find((q) => q.id === r.question_id), events: events.filter((e) => e.revision_id === r.id) };
      }),
      create: jest.fn(async ({ data }: any) => {
        const { options: opts, ...rest } = data;
        const r = { id: id('r'), review_note: null, reviewed_by: null, submitted_by: null, answer_verified: false, ...rest };
        revisions.push(r);
        for (const o of opts.create) options.push({ id: id('o'), revision_id: r.id, ...o });
        return { id: r.id };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(revisions.find((r) => r.id === where.id), data)),
    },
    question_option: {
      deleteMany: jest.fn(async ({ where }: any) => {
        for (let i = options.length - 1; i >= 0; i--) if (options[i].revision_id === where.revision_id) options.splice(i, 1);
      }),
      createMany: jest.fn(async ({ data }: any) => data.forEach((o: any) => options.push({ id: id('o'), ...o }))),
    },
    question_event: { create: jest.fn(async ({ data }: any) => events.push({ occurred_at: new Date(), ...data })) },
  };
  client.$transaction = jest.fn((cb: any) => cb(client));
  const service = new QuestionService({ client } as any);
  return { client, service, questions, revisions, options, events, setTree: (t: any[]) => (currentTree = t) };
}

const HEAD = 'question_code,objective_code,stem,option_a,option_b,option_c,option_d,correct,difficulty,explanation';
const csv = (...rows: string[]) => parseQuestionsCsv([HEAD, ...rows].join('\n'));
const r = (code: string, obj = 'O1', stem = `Which unit measures quantity ${code}?`, correct = 'B') => `${code},${obj},${stem},Volt,Ampere,Ohm,Watt,${correct},EASY,`;
const editor: QuestionActor = { kind: 'HUMAN', accountId: 'acc-editor', role: 'EDITOR' };
const ctx = (actor: QuestionActor = editor) => ({ actor, origin: 'HUMAN' as const });

async function seedApproved(db: ReturnType<typeof makeDb>, code = 'Q1') {
  const plan = await db.service.plan(UNIT, csv(r(code)));
  await db.service.apply(UNIT, plan, ctx());
  const rev = db.revisions[db.revisions.length - 1];
  await db.service.transition(rev.id, 'IN_REVIEW', editor, {});
  await db.service.transition(rev.id, 'APPROVED', { kind: 'HUMAN', accountId: 'acc-rev', role: 'REVIEWER' }, { answerVerified: true });
  return rev;
}

describe('QuestionService.plan', () => {
  it('plans a CREATE for a new question and resolves its full objective path', async () => {
    const db = makeDb();
    const plan = await db.service.plan(UNIT, csv(r('Q1')));
    expect(plan.issues).toEqual([]);
    expect(plan.items[0]).toMatchObject({ action: 'CREATE', objectivePath: 'C1/T1/M1/O1' });
  });

  it('reports an unknown objective, an ambiguous one, and an empty curriculum', async () => {
    const db = makeDb();
    const plan = await db.service.plan(UNIT, csv(r('Q1', 'NOPE'), r('Q2', 'DUP')));
    const msgs = plan.issues.map((i) => i.message).join('\n');
    expect(msgs).toMatch(/objective NOPE does not exist/);
    expect(msgs).toMatch(/DUP is used more than once/);

    db.setTree([]);
    const empty = await db.service.plan(UNIT, csv(r('Q1')));
    expect(empty.issues[0].message).toMatch(/no curriculum content yet/);
  });

  it('refuses the same wording under a different code', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    const plan = await db.service.plan(UNIT, csv(r('Q2', 'O1', 'Which unit measures quantity Q1?')));
    expect(plan.issues[0].message).toMatch(/already exists as Q1/);
  });

  it('plans UPDATE for a draft, UNCHANGED for identical approved content, NEW_REVISION for changed approved content', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    expect((await db.service.plan(UNIT, csv(r('Q1', 'O1', 'Which unit measures quantity Q1 now?')))).items[0].action).toBe('UPDATE');

    const db2 = makeDb();
    await seedApproved(db2);
    expect((await db2.service.plan(UNIT, csv(r('Q1')))).items[0].action).toBe('UNCHANGED');
    expect((await db2.service.plan(UNIT, csv(r('Q1', 'O1', 'Which unit measures quantity Q1 exactly?')))).items[0].action).toBe('NEW_REVISION');
  });

  it('refuses to change a question that is in review or retired', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    db.revisions[0].state = 'IN_REVIEW';
    expect((await db.service.plan(UNIT, csv(r('Q1', 'O1', 'A different wording for Q1?')))).issues[0].message).toMatch(/in review/);
    db.revisions[0].state = 'RETIRED';
    expect((await db.service.plan(UNIT, csv(r('Q1', 'O1', 'A different wording for Q1?')))).issues[0].message).toMatch(/retired; use a new/);
  });
});

describe('QuestionService.apply', () => {
  it('creates the question, revision, four options with one correct, and a history entry', async () => {
    const db = makeDb();
    const counts = await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    expect(counts.CREATE).toBe(1);
    expect(db.questions[0]).toMatchObject({ code: 'Q1', objective_path: 'C1/T1/M1/O1' });
    expect(db.revisions[0]).toMatchObject({ state: 'DRAFT', origin: 'HUMAN', authored_by: 'acc-editor', contributor_ids: ['acc-editor'], stem_hash: stemHash('Which unit measures quantity Q1?') });
    expect(db.options.map((o) => o.is_correct)).toEqual([false, true, false, false]);
    expect(db.events[0]).toMatchObject({ from_state: null, to_state: 'DRAFT', actor_kind: 'HUMAN' });
  });

  it('an update replaces the options, clears the answer confirmation and records another contributor', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    db.revisions[0].answer_verified = true;
    const other: QuestionActor = { kind: 'HUMAN', accountId: 'acc-other', role: 'EDITOR' };
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1', 'O2', 'Which unit measures quantity Q1 again?', 'C'))), ctx(other));
    expect(db.revisions).toHaveLength(1);
    expect(db.revisions[0]).toMatchObject({ answer_verified: false });
    expect(db.revisions[0].contributor_ids.sort()).toEqual(['acc-editor', 'acc-other']);
    expect(db.options.filter((o) => o.is_correct).map((o) => o.position)).toEqual([2]);
    expect(db.questions[0].objective_path).toBe('C1/T1/M1/O2');
  });

  it('a change to an approved question makes revision 2 and leaves revision 1 approved until 2 is approved', async () => {
    const db = makeDb();
    await seedApproved(db);
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1', 'O1', 'Which unit measures quantity Q1 exactly?'))), ctx());
    expect(db.revisions.map((x) => [x.revision, x.state])).toEqual([[1, 'APPROVED'], [2, 'DRAFT']]);
  });

  it('writes nothing for an unchanged question', async () => {
    const db = makeDb();
    await seedApproved(db);
    const before = db.revisions.length;
    const counts = await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    expect(counts.UNCHANGED).toBe(1);
    expect(db.revisions).toHaveLength(before);
  });

  it('refuses an update if the question left an editable state after planning', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    const plan = await db.service.plan(UNIT, csv(r('Q1', 'O1', 'Which unit measures quantity Q1 now?')));
    db.revisions[0].state = 'IN_REVIEW';
    await expect(db.service.apply(UNIT, plan, ctx())).rejects.toBeInstanceOf(QuestionConflictError);
  });
});

describe('QuestionService.transition', () => {
  const reviewer: QuestionActor = { kind: 'HUMAN', accountId: 'acc-rev', role: 'REVIEWER' };

  async function inReview(db: ReturnType<typeof makeDb>) {
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    const rev = db.revisions[0];
    await db.service.transition(rev.id, 'IN_REVIEW', editor, {});
    return rev;
  }

  it('records who submitted, and writes a history row for each step', async () => {
    const db = makeDb();
    const rev = await inReview(db);
    expect(rev).toMatchObject({ state: 'IN_REVIEW', submitted_by: 'acc-editor' });
    expect(db.events.map((e) => e.to_state)).toEqual(['DRAFT', 'IN_REVIEW']);
  });

  it('refuses approval by the author or the submitter, and without the answer-key confirmation', async () => {
    const db = makeDb();
    const rev = await inReview(db);
    const selfApprover: QuestionActor = { kind: 'HUMAN', accountId: 'acc-editor', role: 'SUPER_ADMIN' };
    await expect(db.service.transition(rev.id, 'APPROVED', selfApprover, { answerVerified: true })).rejects.toBeInstanceOf(QuestionTransitionError);
    await expect(db.service.transition(rev.id, 'APPROVED', reviewer, {})).rejects.toThrow(/answer key/);
    expect(rev.state).toBe('IN_REVIEW');
  });

  it('refuses approval by someone who edited the wording even though they did not create it', async () => {
    const db = makeDb();
    const rev = await inReview(db);
    rev.contributor_ids.push('acc-rev');
    await expect(db.service.transition(rev.id, 'APPROVED', reviewer, { answerVerified: true })).rejects.toThrow(/wrote, edited or submitted/);
  });

  it('approves for a different reviewer, stores the confirmation and the note', async () => {
    const db = makeDb();
    const rev = await inReview(db);
    await db.service.transition(rev.id, 'APPROVED', reviewer, { answerVerified: true, note: 'Checked against the textbook.' });
    expect(rev).toMatchObject({ state: 'APPROVED', reviewed_by: 'acc-rev', answer_verified: true, review_note: 'Checked against the textbook.' });
  });

  it('supersedes the previously approved revision when a newer one is approved', async () => {
    const db = makeDb();
    const first = await seedApproved(db);
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1', 'O1', 'Which unit measures quantity Q1 exactly?'))), ctx());
    const second = db.revisions[1];
    await db.service.transition(second.id, 'IN_REVIEW', editor, {});
    await db.service.transition(second.id, 'APPROVED', reviewer, { answerVerified: true });
    expect([first.state, second.state]).toEqual(['SUPERSEDED', 'APPROVED']);
    expect(db.events.some((e) => e.to_state === 'SUPERSEDED' && e.actor_kind === 'SYSTEM')).toBe(true);
  });

  it('refuses to approve when the objective has gone from the curriculum', async () => {
    const db = makeDb();
    const rev = await inReview(db);
    db.setTree([{ code: 'C1', topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'O2' }] }] }] }]);
    await expect(db.service.transition(rev.id, 'APPROVED', reviewer, { answerVerified: true })).rejects.toThrow(/no longer exists/);
  });

  it('refuses to submit a question whose stored content is invalid', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'))), ctx());
    db.options[0].text = db.options[1].text; // two options now the same
    await expect(db.service.transition(db.revisions[0].id, 'IN_REVIEW', editor, {})).rejects.toThrow(/not ready/);
  });

  it('sends back and retires with a note, and unknown ids are not found', async () => {
    const db = makeDb();
    const rev = await inReview(db);
    await db.service.transition(rev.id, 'CHANGES_REQUIRED', reviewer, { note: 'Option C is also correct.' });
    expect(rev).toMatchObject({ state: 'CHANGES_REQUIRED', review_note: 'Option C is also correct.' });
    await expect(db.service.transition('nope', 'IN_REVIEW', editor, {})).rejects.toBeInstanceOf(QuestionNotFoundError);
  });
});

describe('QuestionService.list / detail', () => {
  it('lists the latest revision per question and gives a reviewer the options with the correct flag', async () => {
    const db = makeDb();
    await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1'), r('Q2'))), ctx());
    const rows = await db.service.list(UNIT);
    expect(rows.map((x) => x.code)).toEqual(expect.arrayContaining(['Q1', 'Q2']));
    const d = await db.service.detail(db.revisions[0].id);
    expect(d.options.map((o) => [o.label, o.isCorrect])).toEqual([['A', false], ['B', true], ['C', false], ['D', false]]);
    expect(d.history[0].to).toBe('DRAFT');
  });
});
