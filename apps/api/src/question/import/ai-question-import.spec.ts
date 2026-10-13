import { runAiQuestionImport } from './ai-question-import';
import { QuestionFormatError } from './question-import';
import { QuestionNotFoundError } from '../question.errors';

const UNIT = { curriculumVersionId: 'cv', gradeId: 'g', subjectId: 's', latestRevisionId: 'sv', latestRevisionState: 'AI_STRUCTURED' };
const q = (code: string) => ({ code, objectiveCode: 'O1', stem: `Which unit measures quantity ${code}?`, options: ['Volt', 'Ampere', 'Ohm', 'Watt'], correct: 'B', difficulty: 'EASY' });
const file = (questions: unknown[], over: Record<string, unknown> = {}) =>
  JSON.stringify({ curriculumCode: 'ICSE', versionLabel: '2026-27', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS', questions, ...over });

function deps(action: 'CREATE' | 'UPDATE' = 'CREATE', found = true) {
  return {
    curriculum: { findSubjectVersion: jest.fn().mockResolvedValue(found ? { id: 'sv', state: 'AI_STRUCTURED' } : null) },
    questions: {
      unitIdentity: jest.fn().mockResolvedValue(UNIT),
      plan: jest.fn(async (_u: unknown, parsed: any) => ({
        items: parsed.questions.map((x: any) => ({ where: x.where, draft: x.draft, objectivePath: 'C/T/M/O1', action })),
        issues: parsed.issues,
      })),
      apply: jest.fn().mockResolvedValue({ CREATE: 2, UPDATE: 0, NEW_REVISION: 0, UNCHANGED: 0 }),
    },
  };
}

describe('runAiQuestionImport', () => {
  it('adds the questions as the AI actor, recording the operator and the file hash', async () => {
    const d = deps();
    const text = file([q('a1'), q('a2')]);
    const out = await runAiQuestionImport(text, d as any, 'alfred');
    expect(out.result).toMatchObject({ ok: true, written: true });
    const ctx = d.questions.apply.mock.calls[0][2];
    expect(ctx.actor).toEqual({ kind: 'AI', accountId: null });
    expect(ctx.origin).toBe('AI_DRAFT');
    expect(ctx.aiSource).toContain('operator alfred');
    expect(ctx.aiSource).toContain(out.sha256);
  });

  it('refuses to touch an existing question: the AI only adds', async () => {
    const d = deps('UPDATE');
    const out = await runAiQuestionImport(file([q('a1')]), d as any, 'alfred');
    expect(out.result.ok).toBe(false);
    expect(out.result.issues[0].message).toMatch(/only adds new questions/);
    expect(d.questions.apply).not.toHaveBeenCalled();
  });

  it('writes nothing when the file has problems', async () => {
    const d = deps();
    const out = await runAiQuestionImport(file([{ ...q('a1'), correct: 'Z' }]), d as any, 'alfred');
    expect(out.result.ok).toBe(false);
    expect(d.questions.apply).not.toHaveBeenCalled();
  });

  it('needs a valid unit header and an existing unit', async () => {
    await expect(runAiQuestionImport(file([q('a1')], { subjectCode: 'bad code' }), deps() as any, 'x')).rejects.toBeInstanceOf(QuestionFormatError);
    await expect(runAiQuestionImport(file([q('a1')], { versionLabel: '' }), deps() as any, 'x')).rejects.toThrow(/versionLabel/);
    await expect(runAiQuestionImport(file([q('a1')]), deps('CREATE', false) as any, 'x')).rejects.toBeInstanceOf(QuestionNotFoundError);
    await expect(runAiQuestionImport('nope', deps() as any, 'x')).rejects.toThrow(/not valid JSON/);
  });
});
