import { FOCUS, QUICK, nextBestAction, summarise, testFor, type HomeAttempt, type HomeUnit } from './home-domain';

const t = (code: string, ready = true) => ({ code, name: code, total: 10, ready });
const unit = (code: string, name: string, over: Partial<HomeUnit> = {}): HomeUnit => ({
  subjectVersionId: `sv-${code}`,
  subjectCode: code,
  subjectName: name,
  ready: true,
  chosenChapters: 0,
  tests: [t(FOCUS), t(QUICK)],
  ...over,
});
const attempt = (subjectCode: string, over: Partial<HomeAttempt> = {}): HomeAttempt => ({
  assessmentId: `a-${subjectCode}-${over.submittedAt ?? 'x'}`,
  mode: 'TEST',
  status: 'SUBMITTED',
  subjectCode,
  subjectName: subjectCode,
  blueprint: QUICK,
  startedAt: '2026-10-01T10:00:00.000Z',
  submittedAt: '2026-10-01T10:10:00.000Z',
  correct: 7,
  total: 10,
  ...over,
});
const PHY = unit('PHY', 'Physics');
const CHEM = unit('CHEM', 'Chemistry');

describe('testFor', () => {
  it('uses Focus 10 only when the student chose chapters, else Quick 10, else anything ready', () => {
    expect(testFor(PHY)).toBe(QUICK);
    expect(testFor({ ...PHY, chosenChapters: 2 })).toBe(FOCUS);
    expect(testFor({ ...PHY, chosenChapters: 2, tests: [t(FOCUS, false), t(QUICK)] })).toBe(QUICK);
    expect(testFor({ ...PHY, tests: [t('SUBJECT20')] })).toBe('SUBJECT20');
    expect(testFor({ ...PHY, tests: [t(QUICK, false)] })).toBeNull();
  });
});

describe('nextBestAction (fixed, explainable order)', () => {
  it('1. resumes the newest open test before anything else', () => {
    const a = nextBestAction({
      hasCohort: true,
      units: [PHY],
      attempts: [attempt('PHY', { status: 'IN_PROGRESS', assessmentId: 'old', startedAt: '2026-10-01T00:00:00Z' }), attempt('PHY', { status: 'IN_PROGRESS', assessmentId: 'new', startedAt: '2026-10-02T00:00:00Z' })],
    });
    expect(a).toMatchObject({ kind: 'RESUME', assessmentId: 'new' });
  });

  it('2. asks for the curriculum and grade when they are missing', () => {
    expect(nextBestAction({ hasCohort: false, units: [], attempts: [] }).kind).toBe('FINISH_PROFILE');
  });

  it('3. says Coming soon for a cohort with nothing served, and 4. Not ready when no test can be built', () => {
    expect(nextBestAction({ hasCohort: true, units: [], attempts: [] }).kind).toBe('COMING_SOON');
    expect(nextBestAction({ hasCohort: true, units: [{ ...PHY, tests: [t(QUICK, false)] }], attempts: [] }).kind).toBe('NOT_READY');
  });

  it('5. first test: a subject with chosen chapters first, as a TEST, building the mastery profile', () => {
    const a = nextBestAction({ hasCohort: true, units: [CHEM, { ...PHY, chosenChapters: 3 }], attempts: [] });
    expect(a).toMatchObject({ kind: 'FIRST_TEST', subjectName: 'Physics', blueprint: FOCUS, mode: 'TEST', reason: 'Building your mastery profile' });
    expect(nextBestAction({ hasCohort: true, units: [PHY, CHEM], attempts: [] })).toMatchObject({ kind: 'FIRST_TEST', subjectName: 'Chemistry', blueprint: QUICK });
    // An expired or cancelled attempt is not a finished one.
    expect(nextBestAction({ hasCohort: true, units: [PHY], attempts: [attempt('PHY', { status: 'VOID' })] }).kind).toBe('FIRST_TEST');
  });

  it('6. then a subject never tested, then the one tested longest ago', () => {
    const one = nextBestAction({ hasCohort: true, units: [PHY, CHEM], attempts: [attempt('CHEM')] });
    expect(one).toMatchObject({ kind: 'TAKE_TEST', subjectName: 'Physics' });
    expect(one.reason).toMatch(/not taken a Physics test/);
    const both = nextBestAction({
      hasCohort: true,
      units: [PHY, CHEM],
      attempts: [attempt('CHEM', { submittedAt: '2026-10-05T00:00:00Z' }), attempt('PHY', { submittedAt: '2026-10-03T00:00:00Z' })],
    });
    expect(both).toMatchObject({ kind: 'TAKE_TEST', subjectName: 'Physics' });
    expect(both.reason).toMatch(/longest ago/);
  });

  it('practice alone does not count as having tested a subject', () => {
    const a = nextBestAction({ hasCohort: true, units: [PHY, CHEM], attempts: [attempt('CHEM'), attempt('PHY', { mode: 'PRACTICE' })] });
    expect(a).toMatchObject({ kind: 'TAKE_TEST', subjectName: 'Physics' });
  });
});

describe('summarise', () => {
  it('gives each subject its latest finished result and how many it has finished', () => {
    const [phy, chem] = summarise(
      [PHY, CHEM],
      [
        attempt('PHY', { submittedAt: '2026-10-01T00:00:00Z', correct: 5 }),
        attempt('PHY', { submittedAt: '2026-10-04T00:00:00Z', correct: 9 }),
        attempt('PHY', { status: 'IN_PROGRESS', correct: null, total: null }),
      ],
    );
    expect(phy).toMatchObject({ completed: 2, lastResult: { correct: 9, total: 10 } });
    expect(chem).toMatchObject({ completed: 0, lastResult: null });
  });
});
