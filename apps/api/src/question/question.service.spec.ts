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
  const runs: any[] = [];
  const publications: any[] = [];
  const pubEvents: any[] = [];
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
        return { ...r, options: options.filter((o) => o.revision_id === r.id), question: questions.find((q) => q.id === r.question_id), events: events.filter((e) => e.revision_id === r.id), validation_runs: runs.filter((x) => x.revision_id === r.id).slice(-1) };
      }),
      create: jest.fn(async ({ data }: any) => {
        const { options: opts, ...rest } = data;
        const r = { id: id('r'), review_note: null, reviewed_by: null, submitted_by: null, answer_verified: false, ...rest };
        revisions.push(r);
        for (const o of opts.create) options.push({ id: id('o'), revision_id: r.id, ...o });
        return { id: r.id };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(revisions.find((r) => r.id === where.id), data)),
      count: jest.fn(async ({ where }: any) => revisions.filter((r) => r.question_id === where.question_id && r.state === where.state && r.id !== where.id.not).length),
    },
    question_validation_run: {
      create: jest.fn(async ({ data }: any) => runs.push({ created_at: new Date(), ...data })),
      findFirst: jest.fn(async ({ where }: any) => [...runs].reverse().find((x) => x.revision_id === where.revision_id) ?? null),
    },
    generation_attempt: { findFirst: jest.fn(async () => null) },
    question_publication: {
      findUnique: jest.fn(async ({ where }: any) => publications.find((p) => p.revision_id === where.revision_id) ?? null),
      update: jest.fn(async ({ where, data }: any) => Object.assign(publications.find((p) => p.revision_id === where.revision_id), data)),
    },
    question_publication_event: { create: jest.fn(async ({ data }: any) => pubEvents.push(data)) },
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
  return { client, service, questions, revisions, options, events, runs, publications, pubEvents, setTree: (t: any[]) => (currentTree = t) };
}

const HEAD = 'question_code,objective_code,stem,option_a,option_b,option_c,option_d,correct,difficulty,cognitive,explanation';
const csv = (...rows: string[]) => parseQuestionsCsv([HEAD, ...rows].join('\n'));
const r = (code: string, obj = 'O1', stem = `Which unit measures quantity ${code}?`, correct = 'B') => `${code},${obj},${stem},Volt,Ampere,Ohm,Watt,${correct},EASY,C1,Because the ampere measures current.`;
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
    await db.service.transition(rev.id, 'CHANGES_REQUIRED', reviewer, { note: 'Option C is also correct.', reasonCode: 'ANSWER_AMBIGUOUS' });
    expect(rev).toMatchObject({ state: 'CHANGES_REQUIRED', review_note: 'Option C is also correct.' });
    expect(db.events[db.events.length - 1]).toMatchObject({ to_state: 'CHANGES_REQUIRED', reason_code: 'ANSWER_AMBIGUOUS' });
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

describe('QuestionService: governance', () => {
  const approver: QuestionActor = { kind: 'HUMAN', accountId: 'acc-appr', role: 'APPROVER' };
  const reviewer2: QuestionActor = { kind: 'HUMAN', accountId: 'acc-rev', role: 'REVIEWER' };

  it('refuses to submit without a cognitive level and stores nothing', async () => {
    const db = makeDb();
    const noCog = parseQuestionsCsv(['question_code,objective_code,stem,option_a,option_b,option_c,option_d,correct,difficulty', 'Q1,O1,Which unit measures electric current?,Volt,Ampere,Ohm,Watt,B,EASY'].join('\n'));
    await db.service.apply(UNIT, await db.service.plan(UNIT, noCog), ctx());
    await expect(db.service.transition(db.revisions[0].id, 'IN_REVIEW', editor, {})).rejects.toThrow(/cognitive level/);
    expect(db.runs).toHaveLength(0);
    expect(db.revisions[0].state).toBe('DRAFT');
  });

  it('records the deterministic run on submit and shows it with the question', async () => {
    const db = makeDb();
    const rev = await seedApproved(db);
    expect(db.runs).toHaveLength(1);
    expect(db.runs[0]).toMatchObject({ revision_id: rev.id, passed: true, validator_version: 'det-1', critical_count: 0 });
    const d = await db.service.detail(rev.id);
    expect(d.cognitive).toBe('C1');
    expect(d.validation).toMatchObject({ passed: true, validatorVersion: 'det-1' });
  });

  it('runs the checks at approval for a question that was submitted before they existed', async () => {
    const db = makeDb();
    const plan = await db.service.plan(UNIT, csv(r('Q1')));
    await db.service.apply(UNIT, plan, ctx());
    const rev = db.revisions[0];
    rev.state = 'IN_REVIEW'; // legacy: in review, no run on record
    rev.submitted_by = 'acc-editor';
    await db.service.transition(rev.id, 'APPROVED', reviewer2, { answerVerified: true });
    expect(db.runs).toHaveLength(1);
    expect(rev.state).toBe('APPROVED');
  });

  it('blocks approval of a legacy in-review question that still has no cognitive level', async () => {
    const db = makeDb();
    const noCog = parseQuestionsCsv(['question_code,objective_code,stem,option_a,option_b,option_c,option_d,correct,difficulty', 'Q1,O1,Which unit measures electric current?,Volt,Ampere,Ohm,Watt,B,EASY'].join('\n'));
    await db.service.apply(UNIT, await db.service.plan(UNIT, noCog), ctx());
    const rev = db.revisions[0];
    rev.state = 'IN_REVIEW';
    await expect(db.service.transition(rev.id, 'APPROVED', reviewer2, { answerVerified: true })).rejects.toThrow(/automatic checks/);
    expect(rev.state).toBe('IN_REVIEW');
  });

  it('quarantines an approved question with a reason, and keeps the history', async () => {
    const db = makeDb();
    const rev = await seedApproved(db);
    await db.service.transition(rev.id, 'QUARANTINED', reviewer2, { reasonCode: 'ANSWER_WRONG', note: 'A student reported the key is wrong.' });
    expect(rev.state).toBe('QUARANTINED');
    expect(db.events[db.events.length - 1]).toMatchObject({ from_state: 'APPROVED', to_state: 'QUARANTINED', reason_code: 'ANSWER_WRONG' });
  });

  describe('publication follows the question', () => {
    const publish = (db: ReturnType<typeof makeDb>, revId: string) => db.publications.push({ revision_id: revId, state: 'PUBLISHED', withdrawn_by: null });

    it('quarantine withdraws the publication, and restoring does not publish it again', async () => {
      const db = makeDb();
      const rev = await seedApproved(db);
      publish(db, rev.id);
      await db.service.transition(rev.id, 'QUARANTINED', reviewer2, { reasonCode: 'ANSWER_WRONG', note: 'Key looks wrong.' });
      expect(db.publications[0]).toMatchObject({ state: 'WITHDRAWN', withdrawn_by: 'acc-rev', withdraw_reason_code: 'ANSWER_WRONG' });
      expect(db.pubEvents[0]).toMatchObject({ action: 'WITHDRAW', actor_kind: 'HUMAN', reason_code: 'ANSWER_WRONG' });
      await db.service.transition(rev.id, 'APPROVED', approver, { reasonCode: 'OTHER', note: 'Checked, fine.' });
      expect(db.publications[0].state).toBe('WITHDRAWN');
    });

    it('retiring withdraws it', async () => {
      const db = makeDb();
      const rev = await seedApproved(db);
      publish(db, rev.id);
      await db.service.transition(rev.id, 'RETIRED', reviewer2, { reasonCode: 'OTHER', note: 'No longer needed.' });
      expect(db.publications[0].state).toBe('WITHDRAWN');
    });

    it('a newer approved version replaces it, and the old publication is withdrawn by the system', async () => {
      const db = makeDb();
      const first = await seedApproved(db);
      publish(db, first.id);
      await db.service.apply(UNIT, await db.service.plan(UNIT, csv(r('Q1', 'O1', 'Which unit measures quantity Q1 exactly?'))), ctx());
      const second = db.revisions[1];
      await db.service.transition(second.id, 'IN_REVIEW', editor, {});
      await db.service.transition(second.id, 'APPROVED', reviewer2, { answerVerified: true });
      expect(db.publications[0].state).toBe('WITHDRAWN');
      expect(db.pubEvents[0]).toMatchObject({ actor_kind: 'SYSTEM', actor_account_id: null });
      expect(db.publications.some((p) => p.revision_id === second.id)).toBe(false);
    });

    it('does nothing for a question that was never published', async () => {
      const db = makeDb();
      const rev = await seedApproved(db);
      await db.service.transition(rev.id, 'QUARANTINED', reviewer2, { reasonCode: 'OTHER', note: 'Pulled while checked.' });
      expect(db.pubEvents).toHaveLength(0);
    });
  });

  it('restores only by an approver, and not when a newer version is already approved', async () => {
    const db = makeDb();
    const rev = await seedApproved(db);
    await db.service.transition(rev.id, 'QUARANTINED', reviewer2, { reasonCode: 'OTHER', note: 'Pulled while checked.' });
    await expect(db.service.transition(rev.id, 'APPROVED', reviewer2, { reasonCode: 'OTHER', note: 'Checked, fine.' })).rejects.toBeInstanceOf(QuestionTransitionError);
    await db.service.transition(rev.id, 'APPROVED', approver, { reasonCode: 'OTHER', note: 'Checked, fine.' });
    expect(rev.state).toBe('APPROVED');

    await db.service.transition(rev.id, 'QUARANTINED', reviewer2, { reasonCode: 'OTHER', note: 'Pulled again.' });
    db.revisions.push({ id: 'r-new', question_id: rev.question_id, state: 'APPROVED', revision: 2 });
    await expect(db.service.transition(rev.id, 'APPROVED', approver, { reasonCode: 'OTHER', note: 'Try to restore.' })).rejects.toThrow(/newer version/);
    expect(rev.state).toBe('QUARANTINED');
  });

  it('a quarantined question is not counted as approved for the exam pool filter', async () => {
    const db = makeDb();
    const rev = await seedApproved(db);
    await db.service.transition(rev.id, 'QUARANTINED', reviewer2, { reasonCode: 'ANSWER_WRONG', note: 'Key is wrong.' });
    expect(db.revisions.filter((x) => x.state === 'APPROVED')).toHaveLength(0);
  });
});
