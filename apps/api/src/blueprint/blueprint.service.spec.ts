import { BlueprintInputError } from './blueprint-domain';
import { BlueprintConflictError, BlueprintForbiddenError, BlueprintNotFoundError } from './blueprint.errors';
import { BlueprintService } from './blueprint.service';

/**
 * In-memory stand-in for the Prisma calls this service makes. It checks the service's rules (roles, versioning,
 * publish/retire, switching on, preview). Real SQL, row locks and the partial unique indexes are covered by the
 * real-database integration tests.
 */
const ROLES: Record<string, string[]> = { editor: ['EDITOR'], approver: ['APPROVER'], student: [] };
const SV = '11111111-1111-4111-8111-111111111111';
const CHAPTERS = ['CH01', 'CH02', 'CH03'];

const quick10 = { totalQuestions: 10, difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 }, openingDifficulty: 'EASY' };

function build(opts: { questions?: number; subjectCode?: string } = {}) {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const blueprints: any[] = [];
  const versions: any[] = [];
  const audits: any[] = [];
  const subjectCode = opts.subjectCode ?? 'PHY';

  const unit = {
    id: SV,
    curriculum_version_id: 'cv',
    grade_id: 'g',
    subject_id: 's',
    curriculum_version: { curriculum: { code: 'ICSE' } },
    grade: { code: 'GRADE_8' },
    subject: { code: subjectCode },
  };
  const total = opts.questions ?? 30;
  const revisions = Array.from({ length: total }, (_, k) => ({
    id: `r${String(k + 1).padStart(3, '0')}`,
    difficulty: (['EASY', 'MEDIUM', 'HARD'] as const)[k % 3],
    cognitive: (['C1', 'C2', null] as const)[k % 3],
    question_type: 'MCQ',
    stem_hash: `h${k}`,
    stem: `Question ${k + 1}?`,
    question: { id: `q${k}`, code: `Q${k + 1}`, objective_path: `${CHAPTERS[k % 3]}/T1/M1/O1`, bank_state: k === 0 ? { health: 'WATCH' } : null },
  }));

  const parts = (v: any) => ({
    ...v,
    difficulties: v.difficulties ?? [],
    types: v.types ?? [],
    cells: v.cells ?? [],
    scopes: v.scopes ?? [],
    _count: { runs: v.runs ?? 0 },
  });
  const withVersions = (b: any, where?: any) => ({
    ...b,
    versions: versions
      .filter((v) => v.blueprint_id === b.id && (!where?.status?.in || where.status.in.includes(v.status)))
      .sort((a, c) => c.version - a.version)
      .map(parts),
  });

  const client: any = {
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: async (fn: any) => fn(client),
    assessment_blueprint: {
      findMany: jest.fn(async ({ include }: any) => blueprints.map((b) => withVersions(b, include?.versions?.where))),
      findUnique: jest.fn(async ({ where, include }: any) => {
        const b = blueprints.find((x) => (where.id ? x.id === where.id : x.code === where.code));
        if (!b) return null;
        return include ? withVersions(b) : { ...b };
      }),
      create: jest.fn(async ({ data }: any) => {
        const b = { id: id('bp'), ...data };
        blueprints.push(b);
        return { id: b.id };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(blueprints.find((b) => b.id === where.id), data)),
    },
    assessment_blueprint_version: {
      findMany: jest.fn(async ({ where }: any) => versions.filter((v) => v.blueprint_id === where.blueprint_id)),
      findFirst: jest.fn(async ({ where }: any) => {
        const v = versions.find((x) => x.blueprint_id === where.blueprint_id && x.status === where.status);
        return v ? parts(v) : null;
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const v = versions.find((x) => x.id === where.id);
        return v ? { ...parts(v), blueprint: blueprints.find((b) => b.id === v.blueprint_id) } : null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const { difficulties, types, cells, scopes, ...rest } = data;
        versions.push({
          id: id('bv'),
          created_at: new Date(),
          published_at: null,
          retired_at: null,
          ...rest,
          difficulties: difficulties.create,
          types: types.create,
          cells: cells.create,
          scopes: scopes.create,
        });
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(versions.find((v) => v.id === where.id), data)),
      delete: jest.fn(async ({ where }: any) => versions.splice(versions.findIndex((v) => v.id === where.id), 1)),
    },
    chapter: {
      findMany: jest.fn(async ({ where }: any) => {
        if (where.subject_version_id) {
          return CHAPTERS.map((c) => ({ code: c, topics: [{ code: 'T1', micro_concepts: [{ code: 'M1', learning_objectives: [{ code: 'O1' }] }] }] }));
        }
        return CHAPTERS.filter((c) => where.code.in.includes(c) && where.subject_version.subject.code === subjectCode).map((code) => ({ code }));
      }),
    },
    curriculum_subject_version: { findUnique: jest.fn(async ({ where }: any) => (where.id === SV ? unit : null)) },
    question_revision: { findMany: jest.fn(async () => revisions) },
    student_question_exposure: { findMany: jest.fn(async () => []) },
    audit_event: { create: jest.fn(async ({ data }: any) => audits.push(data)) },
  };
  const authz: any = { curriculumRolesFor: jest.fn(async (a: string) => ROLES[a] ?? []) };
  const events: any[] = [];
  const outbox: any = { publish: jest.fn(async (_tx: any, e: any) => events.push(e)) };
  const service = new BlueprintService({ client } as any, authz, outbox);
  return { service, client, blueprints, versions, audits, events };
}

async function withQuick10(h: ReturnType<typeof build>, header: Record<string, unknown> = {}) {
  return h.service.create('editor', { code: 'QUICK10', name: 'Quick 10', design: quick10, ...header });
}

describe('BlueprintService: who may do what', () => {
  it('needs a curriculum role to read or edit', async () => {
    const h = build();
    await expect(h.service.list('student')).rejects.toBeInstanceOf(BlueprintForbiddenError);
    await expect(withQuick10(h).then(() => h.service.create('student', { code: 'X1', name: 'x x', design: quick10 }))).rejects.toBeInstanceOf(BlueprintForbiddenError);
  });

  it('only an approver publishes or switches a design on', async () => {
    const h = build();
    const b = await withQuick10(h);
    await expect(h.service.publishDraft('editor', b.id)).rejects.toThrow(/only an approver/);
    await expect(h.service.setEnabled('editor', b.id, true)).rejects.toThrow(/only an approver/);
    expect(h.versions[0].status).toBe('DRAFT');
  });
});

describe('BlueprintService: versions', () => {
  it('creates a blueprint switched off, with draft version 1', async () => {
    const h = build();
    const b = await withQuick10(h);
    expect(b).toMatchObject({ code: 'QUICK10', enabled: false, published: null, draft: { version: 1 } });
    expect(b.versions[0]).toMatchObject({ version: 1, status: 'DRAFT', design: { totalQuestions: 10, difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 } } });
    expect(h.audits.map((a) => a.action)).toEqual(['blueprint.created']);
  });

  it('refuses a duplicate code and a design that does not add up', async () => {
    const h = build();
    await withQuick10(h);
    await expect(withQuick10(h)).rejects.toBeInstanceOf(BlueprintConflictError);
    await expect(h.service.create('editor', { code: 'BAD', name: 'Bad one', design: { totalQuestions: 10, difficulty: { EASY: 5, MEDIUM: 3, HARD: 1 } } })).rejects.toThrow(/add up to 9/);
  });

  it('checks named chapters against the bound subject', async () => {
    const h = build();
    const subject = { curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHY' };
    const design = { ...quick10, scope: { mode: 'CHAPTERS', strict: true, chapters: ['CH01', 'CH09'] } };
    await expect(h.service.create('editor', { code: 'PHYCH', name: 'Physics chapters', subject, design })).rejects.toThrow(/chapter CH09 is not in PHY/);
    const ok = await h.service.create('editor', { code: 'PHYCH', name: 'Physics chapters', subject, design: { ...design, scope: { ...design.scope, chapters: ['CH01', 'CH02'] } } });
    expect(ok.subject).toEqual(subject);
  });

  it('saving replaces the open draft; after publishing, saving opens the next version', async () => {
    const h = build();
    const b = await withQuick10(h);
    await h.service.saveDraft('editor', b.id, { ...quick10, notes: 'second try' });
    expect(h.versions).toHaveLength(1);
    expect(h.versions[0]).toMatchObject({ version: 1, status: 'DRAFT', notes: 'second try' });

    await h.service.publishDraft('approver', b.id);
    const next = await h.service.saveDraft('editor', b.id, { totalQuestions: 10, difficulty: { EASY: 4, MEDIUM: 4, HARD: 2 } });
    expect(next.draft).toMatchObject({ version: 2 });
    expect(next.published).toMatchObject({ version: 1 });
  });

  it('publishing retires the version before, and records it', async () => {
    const h = build();
    const b = await withQuick10(h);
    await h.service.publishDraft('approver', b.id);
    await h.service.saveDraft('editor', b.id, { totalQuestions: 10, difficulty: { EASY: 4, MEDIUM: 4, HARD: 2 } });
    const after = await h.service.publishDraft('approver', b.id);
    expect(after.versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'PUBLISHED'],
      [1, 'RETIRED'],
    ]);
    expect(after.versions[1].retiredAt).not.toBeNull();
    expect(h.events.map((e) => e.payload)).toEqual([
      { blueprintId: b.id, code: 'QUICK10', version: 1, retiredVersion: null },
      { blueprintId: b.id, code: 'QUICK10', version: 2, retiredVersion: 1 },
    ]);
    await expect(h.service.publishDraft('approver', b.id)).rejects.toThrow(/no draft to publish/);
  });

  it('discards a draft, and says when there is none', async () => {
    const h = build();
    const b = await withQuick10(h);
    const after = await h.service.discardDraft('editor', b.id);
    expect(after.versions).toEqual([]);
    await expect(h.service.discardDraft('editor', b.id)).rejects.toThrow(/no draft/);
  });

  it('switching on needs a published version', async () => {
    const h = build();
    const b = await withQuick10(h);
    await expect(h.service.setEnabled('approver', b.id, true)).rejects.toThrow(/publish a version/);
    await h.service.publishDraft('approver', b.id);
    expect((await h.service.setEnabled('approver', b.id, true)).enabled).toBe(true);
    expect((await h.service.setEnabled('approver', b.id, false)).enabled).toBe(false);
    expect(h.audits.map((a) => a.action)).toEqual(expect.arrayContaining(['blueprint.enabled', 'blueprint.disabled']));
  });

  it('an unknown blueprint is not found', async () => {
    await expect(build().service.detail('editor', 'nope')).rejects.toBeInstanceOf(BlueprintNotFoundError);
  });
});

describe('BlueprintService.preview', () => {
  it('shows what a draft would build, why each question was chosen, and writes nothing', async () => {
    const h = build();
    const b = await withQuick10(h);
    const writesBefore = h.client.audit_event.create.mock.calls.length;
    const p = await h.service.preview('editor', b.versions[0].versionId, SV, 'fixed-seed');
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p).toMatchObject({ blueprint: 'QUICK10', version: 1, status: 'DRAFT', seed: 'fixed-seed', note: null });
    expect(p.items).toHaveLength(10);
    expect(p.items[0].difficulty).toBe('EASY');
    expect(p.items.every((i) => i.code.startsWith('Q') && i.stem.endsWith('?') && i.reasons.includes('UNSEEN'))).toBe(true);
    expect(p.report.delivered).toEqual({ EASY: 5, MEDIUM: 3, HARD: 2 });
    expect(p.report.chapters).toBe(3);
    // The WATCH question is not needed, so it is not used.
    expect(p.items.some((i) => i.health === 'WATCH')).toBe(false);
    expect(await h.service.preview('editor', b.versions[0].versionId, SV, 'fixed-seed')).toEqual(p);
    expect(h.client.audit_event.create.mock.calls.length).toBe(writesBefore);
    expect(h.client.assessment_blueprint_version.update).not.toHaveBeenCalled();
  });

  it('says how many questions are missing instead of failing', async () => {
    const h = build({ questions: 6 });
    const b = await withQuick10(h);
    expect(await h.service.preview('editor', b.versions[0].versionId, SV)).toMatchObject({ ok: false, available: 6, needed: 10 });
  });

  it('explains that a focus design previews the whole subject', async () => {
    const h = build();
    const b = await h.service.create('editor', { code: 'FOCUS10', name: 'Focus 10', design: { ...quick10, scope: { mode: 'STUDENT_FOCUS' } } });
    const p = await h.service.preview('editor', b.versions[0].versionId, SV);
    expect(p.note).toMatch(/whole subject/);
  });

  it('refuses a design bound to another subject, a bad seed and an unknown version', async () => {
    const h = build({ subjectCode: 'CHEM' });
    const subject = { curriculumCode: 'ICSE', gradeCode: 'GRADE_8', subjectCode: 'PHY' };
    const b = await h.service.create('editor', { code: 'PHY10', name: 'Physics 10', subject, design: quick10 });
    await expect(h.service.preview('editor', b.versions[0].versionId, SV)).rejects.toThrow(/for PHY, not CHEM/);
    await expect(h.service.preview('editor', b.versions[0].versionId, SV, 'bad seed!')).rejects.toBeInstanceOf(BlueprintInputError);
    await expect(h.service.preview('editor', 'missing', SV)).rejects.toBeInstanceOf(BlueprintNotFoundError);
  });
});
