import { CurriculumConflictError, CurriculumForbiddenError, CurriculumNotFoundError } from '../curriculum.errors';
import { parseUploadBody } from '../admin-curriculum.controller';
import { AI_ACTOR, runAiImport } from './ai-import';
import { ContentImportService } from './content-import.service';

const HEAD = 'chapter_code,chapter_title,topic_code,topic_title,concept_code,concept_title,objective_code,objective,evidence_ref,provenance,rationale';
const GOOD = [HEAD, 'CH1,One,T1,Topic,M1,Concept,O1,Do it,1,OFFICIAL_INFERRED,from section X'].join('\n');

function make(roles: string[]) {
  const curriculum: any = {
    listSubjectVersions: jest.fn().mockResolvedValue([{ id: 'u1' }]),
    evidenceReferenceIds: jest.fn().mockResolvedValue(['ev-1']),
  };
  const admin: any = {
    replaceContent: jest.fn().mockResolvedValue({ state: 'DRAFT' }),
    submitForValidation: jest.fn().mockResolvedValue({ passed: true, findings: [] }),
  };
  const authz: any = { curriculumRolesFor: jest.fn().mockResolvedValue(roles) };
  return { curriculum, admin, authz, service: new ContentImportService(curriculum, admin, authz) };
}

describe('ContentImportService', () => {
  it('listing needs any curriculum role; none means forbidden', async () => {
    await expect(make([]).service.listUnits('a')).rejects.toBeInstanceOf(CurriculumForbiddenError);
    await expect(make(['REVIEWER']).service.listUnits('a')).resolves.toEqual([{ id: 'u1' }]);
  });

  it.each([[[]], [['REVIEWER']], [['APPROVER']]])('uploading or previewing needs EDITOR or SUPER_ADMIN (held: %p)', async (roles) => {
    const { service, admin } = make(roles as string[]);
    await expect(service.preview('a', 'u1', 'csv', GOOD)).rejects.toBeInstanceOf(CurriculumForbiddenError);
    await expect(service.upload('a', 'u1', 'csv', GOOD)).rejects.toBeInstanceOf(CurriculumForbiddenError);
    expect(admin.replaceContent).not.toHaveBeenCalled();
  });

  it('preview never writes and reports counts and findings', async () => {
    const { service, admin } = make(['EDITOR']);
    const r = await service.preview('a', 'u1', 'csv', GOOD);
    expect(r).toMatchObject({ ok: true, written: false, counts: { chapters: 1, topics: 1, concepts: 1, objectives: 1 } });
    expect(admin.replaceContent).not.toHaveBeenCalled();
  });

  it('upload writes through the account-based admin layer with evidence numbers resolved to ids', async () => {
    const { service, admin } = make(['EDITOR']);
    const r = await service.upload('acct', 'u1', 'csv', GOOD);
    expect(r).toMatchObject({ ok: true, written: true, state: 'DRAFT' });
    const [acct, unit, tree] = admin.replaceContent.mock.calls[0];
    expect([acct, unit]).toEqual(['acct', 'u1']);
    expect(tree.chapters[0].evidenceReferenceId).toBe('ev-1');
  });

  it('a file with problems writes nothing and says what is wrong', async () => {
    const { service, admin } = make(['SUPER_ADMIN']);
    const bad = [HEAD, 'CH1,One,T1,Topic,M1,Concept,O1,Do it,7,SYSTEM_DERIVED,why'].join('\n');
    const r = await service.upload('a', 'u1', 'csv', bad);
    expect(r.ok).toBe(false);
    expect(r.written).toBe(false);
    expect(r.issues.map((i) => i.message).join(' | ')).toMatch(/not allowed here.*|does not exist/);
    expect(admin.replaceContent).not.toHaveBeenCalled();
  });

  it('an unreadable file is an issue on the file, not a server error', async () => {
    const { service } = make(['EDITOR']);
    const r = await service.preview('a', 'u1', 'csv', 'only one line');
    expect(r).toMatchObject({ ok: false, written: false });
    expect(r.issues[0].where).toBe('file');
  });

  it('submit goes through the admin layer', async () => {
    const { service, admin } = make(['EDITOR']);
    await service.submit('a', 'u1');
    expect(admin.submitForValidation).toHaveBeenCalledWith('a', 'u1');
  });
});

describe('parseUploadBody', () => {
  it('requires a format of csv or json and a text string', () => {
    expect(parseUploadBody({ format: 'csv', text: 'x' })).toEqual({ format: 'csv', text: 'x' });
    for (const v of [null, [], { format: 'xlsx', text: 'x' }, { format: 'csv' }, { format: 'csv', text: 5 }]) {
      expect(() => parseUploadBody(v)).toThrow();
    }
  });
});

describe('runAiImport', () => {
  const draft = (over: Record<string, unknown> = {}) =>
    JSON.stringify({
      curriculumCode: 'ICSE', versionLabel: '2026-27', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS',
      chapters: [{ code: 'CH1', title: 'One', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why',
        topics: [{ code: 'T1', title: 'T', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why',
          microConcepts: [{ code: 'M1', title: 'C', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why',
            learningObjectives: [{ code: 'O1', statement: 'Do it', provenance: 'OFFICIAL_INFERRED', evidenceRef: 1, rationale: 'why' }] }] }] }],
      ...over,
    });
  const deps = (state = 'DRAFT') => ({
    findSubjectVersion: jest.fn().mockResolvedValue({ id: 'u1', state }),
    evidenceReferenceIds: jest.fn().mockResolvedValue(['ev-1']),
    replaceContent: jest.fn().mockResolvedValue({ state }),
    transition: jest.fn().mockResolvedValue(undefined),
  });

  it('acts as the AI actor, imports, and moves DRAFT to AI_STRUCTURED with operator and file hash in the note', async () => {
    const d = deps();
    const out = await runAiImport(draft(), d, 'alfred');
    expect(out.result).toMatchObject({ ok: true, written: true, state: 'AI_STRUCTURED' });
    expect(d.replaceContent.mock.calls[0][2]).toBe(AI_ACTOR);
    const [, to, actor, note] = d.transition.mock.calls[0];
    expect([to, actor]).toEqual(['AI_STRUCTURED', AI_ACTOR]);
    expect(note).toContain('alfred');
    expect(note).toContain(out.sha256);
    expect(AI_ACTOR).toEqual({ kind: 'AI', accountId: null, role: 'AI_RESEARCH' });
  });

  it('re-import while already AI_STRUCTURED replaces content without another transition', async () => {
    const d = deps('AI_STRUCTURED');
    await runAiImport(draft(), d, 'alfred');
    expect(d.replaceContent).toHaveBeenCalledTimes(1);
    expect(d.transition).not.toHaveBeenCalled();
  });

  it.each(['VALIDATED', 'ADMIN_REVIEW', 'APPROVED', 'ACTIVE'])('refuses to touch a unit in %s', async (state) => {
    const d = deps(state);
    await expect(runAiImport(draft(), d, 'a')).rejects.toBeInstanceOf(CurriculumConflictError);
    expect(d.replaceContent).not.toHaveBeenCalled();
  });

  it('refuses an unknown unit and a header with bad codes', async () => {
    const d = deps();
    d.findSubjectVersion.mockResolvedValue(null);
    await expect(runAiImport(draft(), d, 'a')).rejects.toBeInstanceOf(CurriculumNotFoundError);
    await expect(runAiImport(draft({ subjectCode: 'phys ics' }), deps(), 'a')).rejects.toThrow(/subjectCode/);
    await expect(runAiImport('{nope', deps(), 'a')).rejects.toThrow(/not valid JSON/);
  });

  it('the AI can never claim OFFICIAL_EXPLICIT: nothing is written', async () => {
    const d = deps();
    const text = draft().replace(/OFFICIAL_INFERRED/g, 'OFFICIAL_EXPLICIT');
    const out = await runAiImport(text, d, 'a');
    expect(out.result.ok).toBe(false);
    expect(d.replaceContent).not.toHaveBeenCalled();
    expect(d.transition).not.toHaveBeenCalled();
  });
});
