import { QuestionBankService } from './question-bank.service';
import { QuestionForbiddenError } from './question.errors';

const UNIT = { curriculumVersionId: 'cv', gradeId: 'g', subjectId: 's', latestRevisionId: 'sv', latestRevisionState: 'DRAFT' };
const HEAD = 'question_code,objective_code,stem,option_a,option_b,option_c,option_d,correct,difficulty,explanation';
const FILE = `${HEAD}\nQ1,O1,Which unit measures electric current?,Volt,Ampere,Ohm,Watt,B,EASY,`;

function make(roles: string[], planIssues: { where: string; message: string }[] = []) {
  const questions = {
    unitIdentity: jest.fn().mockResolvedValue(UNIT),
    plan: jest.fn(async (_u: unknown, parsed: any) => ({
      items: planIssues.length ? [] : parsed.questions.map((q: any) => ({ where: q.where, draft: q.draft, objectivePath: 'C/T/M/O1', action: 'CREATE' })),
      issues: [...parsed.issues, ...planIssues],
    })),
    apply: jest.fn().mockResolvedValue({ CREATE: 1, UPDATE: 0, NEW_REVISION: 0, UNCHANGED: 0 }),
    transition: jest.fn().mockResolvedValue('IN_REVIEW'),
    list: jest.fn().mockResolvedValue([]),
    detail: jest.fn().mockResolvedValue({}),
    approvedRevisionIdsFromSource: jest.fn().mockResolvedValue([]),
  };
  const curriculum = { listSubjectVersions: jest.fn().mockResolvedValue([]) };
  const authz = { curriculumRolesFor: jest.fn().mockResolvedValue(roles) };
  const service = new QuestionBankService(questions as any, curriculum as any, authz as any);
  return { service, questions, curriculum, authz };
}

describe('QuestionBankService: who may do what', () => {
  it('refuses an account with no curriculum role everywhere (a student)', async () => {
    const { service, questions } = make([]);
    await expect(service.listUnits('a')).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.list('a', 'u')).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.detail('a', 'r')).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.preview('a', 'u', 'csv', FILE)).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.upload('a', 'u', 'csv', FILE)).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.submit('a', 'r')).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.approve('a', 'r', { answerVerified: true })).rejects.toBeInstanceOf(QuestionForbiddenError);
    expect(questions.apply).not.toHaveBeenCalled();
    expect(questions.transition).not.toHaveBeenCalled();
  });

  it('a reviewer or approver can read and decide but not upload or submit', async () => {
    const { service, questions } = make(['REVIEWER', 'APPROVER']);
    await expect(service.list('a', 'u')).resolves.toEqual([]);
    await expect(service.upload('a', 'u', 'csv', FILE)).rejects.toThrow(/editor/);
    await expect(service.submit('a', 'r')).rejects.toThrow(/editor/);
    await service.approve('a', 'r', { answerVerified: true });
    expect(questions.transition).toHaveBeenCalledWith('r', 'APPROVED', expect.objectContaining({ kind: 'HUMAN', accountId: 'a' }), { answerVerified: true });
  });

  it('an editor can upload and submit but not approve, send back or retire', async () => {
    const { service } = make(['EDITOR']);
    await expect(service.submit('a', 'r')).resolves.toEqual({ state: 'IN_REVIEW' });
    await expect(service.approve('a', 'r', { answerVerified: true })).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.requestChanges('a', 'r', { reasonCode: 'OTHER', note: 'needs work' })).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(service.retire('a', 'r', { reasonCode: 'OFF_CURRICULUM', note: 'old syllabus' })).rejects.toBeInstanceOf(QuestionForbiddenError);
  });
});

describe('QuestionBankService: upload', () => {
  it('preview reports without writing', async () => {
    const { service, questions } = make(['EDITOR']);
    const r = await service.preview('a', 'u', 'csv', FILE);
    expect(r).toMatchObject({ ok: true, written: false, counts: { CREATE: 1 } });
    expect(questions.apply).not.toHaveBeenCalled();
  });

  it('upload writes as the signed-in human when the whole file is clean', async () => {
    const { service, questions } = make(['EDITOR']);
    const r = await service.upload('acc-1', 'u', 'csv', FILE);
    expect(r.written).toBe(true);
    expect(questions.apply).toHaveBeenCalledWith(UNIT, expect.anything(), { actor: expect.objectContaining({ accountId: 'acc-1', role: 'EDITOR' }), origin: 'HUMAN' });
  });

  it('upload writes nothing if any row has a problem', async () => {
    const { service, questions } = make(['EDITOR'], [{ where: 'row 2', message: 'objective X does not exist' }]);
    const r = await service.upload('a', 'u', 'csv', FILE);
    expect(r).toMatchObject({ ok: false, written: false });
    expect(questions.apply).not.toHaveBeenCalled();
  });

  it('an unreadable file is an issue on the file, not an error', async () => {
    const { service } = make(['EDITOR']);
    const r = await service.preview('a', 'u', 'json', '{ not json');
    expect(r).toMatchObject({ ok: false, issues: [{ where: 'file', message: expect.stringMatching(/not valid JSON/) }] });
  });
});

describe('QuestionBankService: quarantine', () => {
  const why = { reasonCode: 'ANSWER_WRONG', note: 'The key is wrong.' };

  it('a reviewer can quarantine, an editor and a student cannot', async () => {
    const { service, questions } = make(['REVIEWER']);
    await service.quarantine('a', 'r', why);
    expect(questions.transition).toHaveBeenCalledWith('r', 'QUARANTINED', expect.objectContaining({ role: 'REVIEWER' }), why);
    await expect(make(['EDITOR']).service.quarantine('a', 'r', why)).rejects.toBeInstanceOf(QuestionForbiddenError);
    await expect(make([]).service.quarantine('a', 'r', why)).rejects.toBeInstanceOf(QuestionForbiddenError);
  });

  it('restore goes through the transition rules as APPROVED', async () => {
    const { service, questions } = make(['APPROVER']);
    await service.restore('a', 'r', why);
    expect(questions.transition).toHaveBeenCalledWith('r', 'APPROVED', expect.objectContaining({ role: 'APPROVER' }), why);
  });

  it('a batch quarantines each approved question from the source and reports failures without stopping', async () => {
    const { service, questions } = make(['REVIEWER']);
    questions.approvedRevisionIdsFromSource.mockResolvedValue(['r1', 'r2', 'r3']);
    questions.transition.mockResolvedValueOnce('QUARANTINED').mockRejectedValueOnce(new Error('changed state')).mockResolvedValueOnce('QUARANTINED');
    const out = await service.quarantineBatch('a', 'operator x; file sha256 abc', why);
    expect(out).toEqual({ quarantined: 2, failed: [{ revisionId: 'r2', message: 'changed state' }] });
    expect(questions.approvedRevisionIdsFromSource).toHaveBeenCalledWith('operator x; file sha256 abc');
  });

  it('a batch for a non-reviewer touches nothing', async () => {
    const { service, questions } = make(['EDITOR']);
    await expect(service.quarantineBatch('a', 'src', why)).rejects.toBeInstanceOf(QuestionForbiddenError);
    expect(questions.approvedRevisionIdsFromSource).not.toHaveBeenCalled();
  });
});
