// A small stand-in for the Exam App API, for the browser end-to-end tests only. It follows the real API's request and
// response shapes for the routes the student journey uses, and keeps everything in memory. It is not the API: the
// real rules are tested in the API's unit and real-database integration tests. Sign-in code is always 123456.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.env.STUB_API_PORT ?? 4010);

/** Test accounts, chosen by the email used to sign in. */
const PEOPLE = {
  'student@example.com': { name: 'Asha', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }, chapters: {} },
  'focus@example.com': { name: 'Ravi', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }, chapters: { PHYSICS: ['PHY-CH01', 'PHY-CH02'] } },
  'soon@example.com': { name: 'Mei', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_9' }, chapters: {} },
  'new@example.com': { name: null, cohort: null, chapters: {}, isNew: true },
  'kid@example.com': { name: 'Kiran', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }, chapters: {}, minor: true },
  'solo@example.com': { name: 'Sol', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }, chapters: {}, socialOff: true },
  // Step 17: Kiran's approving guardian, and a parent an adult student (Asha) can invite.
  'mum@example.com': { name: null, cohort: null, chapters: {}, guardianOf: ['kid@example.com'] },
  'parent@example.com': { name: null, cohort: null, chapters: {} },
  // Step 18: everyone above has the Beta plan (as during the private beta); these two see a long test offered.
  'free@example.com': { name: 'Farah', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }, chapters: {}, plan: 'FREE', longTest: true },
  'beta@example.com': { name: 'Bea', cohort: { curriculumCode: 'ICSE', gradeCode: 'GRADE_8' }, chapters: {}, longTest: true },
};
const SUBJECT20 = { code: 'SUBJECT20', name: 'Subject 20', total: 20, ready: true };
const FREE = { SELF_TESTS_PER_DAY: 3, LONG_TESTS: false, PARENT_REPORT_WEEKS: 4 };
const ALL = { SELF_TESTS_PER_DAY: null, LONG_TESTS: true, PARENT_REPORT_WEEKS: null };
function planOf(p) {
  const values = p.plan === 'FREE' ? FREE : ALL;
  const startedToday = [...assessments.values()].filter((a) => a.email === p.email && !a.recommendationId && a.blueprint !== 'CHALLENGE10').length;
  return {
    planName: p.plan === 'FREE' ? 'Free' : 'Beta',
    sources: p.plan === 'FREE' ? [] : [{ planName: 'Beta', source: 'BETA', endsAt: '2027-03-31T18:30:00.000Z' }],
    values,
    startedToday,
    leftToday: values.SELF_TESTS_PER_DAY === null ? null : Math.max(0, values.SELF_TESTS_PER_DAY - startedToday),
  };
}

const SUBJECTS = [
  { subjectVersionId: '11111111-1111-4111-8111-111111111111', subjectCode: 'CHEMISTRY', subjectName: 'Chemistry' },
  { subjectVersionId: '22222222-2222-4222-8222-222222222222', subjectCode: 'PHYSICS', subjectName: 'Physics' },
];
const TESTS = [
  { code: 'FOCUS10', name: 'Focus 10', total: 10, ready: true },
  { code: 'QUICK10', name: 'Quick 10', total: 10, ready: true },
];

const sessions = new Map(); // token -> email
const assessments = new Map(); // id -> assessment
const recs = new Map(); // id -> recommendation (Step 14)
const hidden = new Set(); // emails of adults who chose to be hidden (Step 15)
const social = new Map(); // email -> { code, friends, challenges } (Step 16)
const shares = new Map(); // student email -> { viewers: [{ grantId, viewerEmail, maskedEmail, since }], pending } (Step 17)
let lastShareToken = null;
const STUDENT_IDS = { 'kid@example.com': '33333333-3333-4333-8333-333333333333', 'student@example.com': '44444444-4444-4444-8444-444444444444' };
const REPORT_ID = '55555555-5555-4555-8555-555555555555';
const SHARING_WORDING = {
  version: 1,
  title: 'Share your progress summary with a parent',
  draft: true,
  paragraphs: ['DRAFT. This wording has not been reviewed by a lawyer and must not be used with real families.', 'The person you invite will be able to see a summary of your progress.'],
};
const mask = (e) => `${e[0]}***@${e.split('@')[1]}`;
function sharesOf(email) {
  if (!shares.has(email)) shares.set(email, { viewers: [], pending: null });
  return shares.get(email);
}
/** What a parent sees (Step 17): labels and fixed sentences only; activity from this student's finished tests. */
function parentSummary(email) {
  const done = mine(email).filter((a) => a.status === 'SUBMITTED');
  const claim = (kind, text, statement) => ({ kind, subjectName: 'Chemistry', chapterTitle: 'Chemical reactions', statement, label: kind === 'FOCUS' ? 'NEEDS_ATTENTION' : kind === 'STRENGTH' ? 'STRONG' : 'DEVELOPING', fromLabel: kind === 'IMPROVEMENT' ? 'NEEDS_ATTENTION' : null, text });
  const now = new Date();
  return {
    period: { start: new Date(now.getTime() - 3 * 86400_000).toISOString(), end: now.toISOString() },
    activity: { tests: done.filter((a) => a.mode === 'TEST').length, practice: done.filter((a) => a.mode === 'PRACTICE').length, questionsAnswered: done.length * 10, activeDays: done.length ? 1 : 0 },
    subjects: [
      { subjectName: 'Chemistry', objectives: 6, reportable: 3, counts: { NOT_STARTED: 2, BUILDING_EVIDENCE: 1, NEEDS_ATTENTION: 1, DEVELOPING: 1, SECURE: 0, STRONG: 1 }, chapters: [{ title: 'Chemical reactions', label: 'DEVELOPING' }, { title: 'Acids and bases', label: 'BUILDING_EVIDENCE' }] },
    ],
    strengths: [claim('STRENGTH', 'Shows strong understanding: Balance a chemical equation', 'Balance a chemical equation')],
    focus: [claim('FOCUS', 'Worth more practice: Name the products of a reaction', 'Name the products of a reaction')],
    improvements: [claim('IMPROVEMENT', 'Moved from needs attention to developing: Use word equations', 'Use word equations')],
    claimPolicy: 'CLAIM_V1',
  };
}
function childrenOf(p) {
  const out = (p.guardianOf ?? []).map((e) => ({ studentId: STUDENT_IDS[e], label: PEOPLE[e].name, basis: 'GUARDIAN', email: e }));
  for (const [email, s] of shares) if (s.viewers.some((v) => v.viewerEmail === p.email)) out.push({ studentId: STUDENT_IDS[email], label: PEOPLE[email].name, basis: 'STUDENT_SHARE', email });
  return out;
}
/** The stub knows one other student, whose code is ABC234. */
const RIVAL = { code: 'ABC234', handle: 'Learner-R1V4LS' };

function socialOf(p) {
  if (!social.has(p.email)) social.set(p.email, { code: null, friends: [], challenges: [] });
  return social.get(p.email);
}
function socialView(p) {
  if (p.socialOff) return { enabled: false };
  const s = socialOf(p);
  return {
    enabled: true,
    restricted: false,
    handle: p.minor ? 'Learner-KQ7M2D' : 'Learner-AB3XYZ',
    code: s.code,
    friends: s.friends,
    challenges: s.challenges.map((c) => {
      const a = c.myAssessmentId ? assessments.get(c.myAssessmentId) : null;
      return { ...c, myState: !a ? 'NOT_STARTED' : a.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'FINISHED' };
    }),
    subjects: unitsFor(p).map((u) => ({ subjectVersionId: u.subjectVersionId, subjectName: u.subjectName })),
  };
}

/** Step 15. The real API scores tests about 30 seconds after submit; the stub scores at once: 90 x correct / total. */
function competeFor(p) {
  const units = unitsFor(p);
  const tests = mine(p.email).filter((a) => a.status === 'SUBMITTED' && a.mode === 'TEST' && ['QUICK10', 'FOCUS10'].includes(a.blueprint));
  const xp = mine(p.email).filter((a) => a.status === 'SUBMITTED').reduce((s, a) => s + a.items.filter((i) => i.state === 'LOCKED').length + 5, 0);
  const handle = p.minor ? 'Learner-KQ7M2D' : 'Learner-AB3XYZ';
  const shown = !p.minor && !hidden.has(p.email);
  const board = (scope, title, subjectCode) => {
    const mineHere = tests.filter((a) => !subjectCode || a.subject.subjectCode === subjectCode);
    const cp = mineHere.reduce((s, a) => s + Math.round((90 * a.result.correct) / a.result.total), 0);
    const ranked = mineHere.length >= 2;
    const rivals = [{ handle: 'Learner-R1V4LS', cp: subjectCode ? 120 : 150 }];
    const all = [...rivals.map((r) => ({ ...r, you: false })), ...(ranked ? [{ handle, cp, you: true }] : [])].sort((a, b) => b.cp - a.cp);
    const entries = all.map((e, i) => ({ rank: i + 1, ...e }));
    return {
      scope,
      title,
      subjectCode,
      entries,
      rankedCount: entries.length,
      you: { cp, qualified: mineHere.length, eligibleQuestions: 10 * mineHere.length, rank: entries.find((e) => e.you)?.rank ?? null, needs: { tests: Math.max(0, 2 - mineHere.length), questions: Math.max(0, 20 - 10 * mineHere.length) } },
    };
  };
  return {
    policy: 'CP_V1',
    week: { start: '2026-10-11T18:30:00.000Z', end: '2026-10-18T18:30:00.000Z' },
    handle,
    shownToOthers: shown,
    canChangeVisibility: !p.minor,
    xp: { week: xp, total: xp },
    boards: units.length ? [board('COHORT', 'All subjects · ICSE Grade 8', null), ...units.map((u) => board('SUBJECT', u.subjectName, u.subjectCode))] : [],
    pending: 0,
  };
}
const difficulty = (i) => (i < 5 ? 'EASY' : i < 8 ? 'MEDIUM' : 'HARD');

function person(req) {
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const email = sessions.get(token);
  return email ? { email, ...PEOPLE[email] } : null;
}
const mine = (email) => [...assessments.values()].filter((a) => a.email === email).sort((a, b) => b.startedAt.localeCompare(a.startedAt));

function unitsFor(p) {
  if (!p.cohort || p.cohort.gradeCode !== 'GRADE_8') return [];
  return SUBJECTS.map((s) => ({
    ...s,
    curriculumCode: 'ICSE',
    versionLabel: '2026-27',
    gradeCode: 'GRADE_8',
    usableQuestions: 40,
    ready: true,
    chosenChapters: (p.chapters[s.subjectCode] ?? []).length,
    tests: p.longTest ? [...TESTS, SUBJECT20] : TESTS,
  }));
}

function row(a) {
  return {
    assessmentId: a.id,
    mode: a.mode,
    status: a.status,
    subjectCode: a.subject.subjectCode,
    subjectName: a.subject.subjectName,
    gradeCode: 'GRADE_8',
    blueprint: a.blueprint,
    startedAt: a.startedAt,
    expiresAt: a.expiresAt,
    submittedAt: a.submittedAt,
    correct: a.result?.correct ?? null,
    total: a.result?.total ?? null,
  };
}

/** Step 14: the student's open and started recommendations, in the API's shape. */
function focusFor(p) {
  return [...recs.values()]
    .filter((r) => r.email === p.email && (r.status === 'OPEN' || r.status === 'STARTED'))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((r) => {
      const open = [...assessments.values()].find((a) => a.recommendationId === r.id && a.status === 'IN_PROGRESS');
      return {
        id: r.id,
        kind: r.kind,
        status: r.status,
        source: r.source,
        subjectVersionId: r.subject.subjectVersionId,
        subjectCode: r.subject.subjectCode,
        subjectName: r.subject.subjectName,
        objectives: r.objectives.map((o) => ({ path: o, statement: `Objective ${o.slice(-1)} of ${r.subject.subjectName}`, chapterTitle: `${r.subject.subjectName} chapter 1` })),
        reasons: r.objectives.map((o) => ({ path: o, code: r.kind === 'RETEST' ? 'PRACTISED' : 'MISSED_IN_TEST' })),
        inProgressAssessmentId: open ? open.id : null,
        createdAt: r.createdAt,
      };
    });
}

function newAssessment(p, subject, mode, blueprint, recommendationId = null) {
  const id = randomUUID();
  const items = Array.from({ length: 10 }, (_, i) => ({
    position: i + 1,
    difficulty: difficulty(i),
    stem: `${subject.subjectName} ${mode === 'PRACTICE' ? 'practice' : 'question'} ${i + 1}?`,
    options: ['Option A', 'Option B', 'Option C', 'Option D'],
    correctSlot: i % 4,
    state: null,
    skips: 0,
    slot: null,
  }));
  assessments.set(id, { id, email: p.email, subject, mode, blueprint, recommendationId, status: 'IN_PROGRESS', revisitUsed: false, items, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), submittedAt: null, result: null });
  return id;
}

function home(p) {
  const units = unitsFor(p);
  const focus = focusFor(p);
  const rows = mine(p.email).map(row);
  const finished = rows.filter((r) => r.status === 'SUBMITTED');
  const open = rows.filter((r) => r.status === 'IN_PROGRESS');
  const testFor = (u) => (u.chosenChapters > 0 ? 'FOCUS10' : 'QUICK10');
  let nextAction;
  if (open.length) nextAction = { kind: 'RESUME', assessmentId: open[0].assessmentId, subjectName: open[0].subjectName, mode: open[0].mode, reason: 'You have a test in progress.' };
  else if (!p.cohort) nextAction = { kind: 'FINISH_PROFILE', reason: 'Choose your curriculum and grade to see your subjects.' };
  else if (!units.length) nextAction = { kind: 'COMING_SOON', reason: 'Your curriculum and grade are not available yet.' };
  else if (!finished.length) {
    const u = [...units].sort((a, b) => Number(b.chosenChapters > 0) - Number(a.chosenChapters > 0) || a.subjectName.localeCompare(b.subjectName))[0];
    nextAction = { kind: 'FIRST_TEST', subjectVersionId: u.subjectVersionId, subjectName: u.subjectName, blueprint: testFor(u), mode: 'TEST', reason: 'Building your mastery profile' };
  } else if (focus.some((r) => r.kind === 'RETEST')) {
    const r = focus.find((x) => x.kind === 'RETEST');
    nextAction = { kind: 'RETEST', recommendationId: r.id, subjectName: r.subjectName, objectives: r.objectives.length, reason: `You practised ${r.objectives.length} objectives in ${r.subjectName}. A short retest shows what has stuck.` };
  } else if (focus.length) {
    const r = focus[0];
    nextAction = { kind: 'PRACTICE', recommendationId: r.id, subjectName: r.subjectName, objectives: r.objectives.length, reason: `Practise ${r.objectives.length} objectives in ${r.subjectName}, chosen from your recent answers.` };
  } else {
    const u = units.find((x) => !finished.some((f) => f.subjectCode === x.subjectCode && f.mode === 'TEST')) ?? units[0];
    nextAction = { kind: 'TAKE_TEST', subjectVersionId: u.subjectVersionId, subjectName: u.subjectName, blueprint: testFor(u), mode: 'TEST', reason: `You have not taken a ${u.subjectName} test yet.` };
  }
  return {
    displayName: p.name,
    cohort: p.cohort,
    supported: units.length > 0,
    nextAction,
    firstExperience: !finished.length,
    firstExperienceMessage: 'Building your mastery profile',
    subjects: units.map((u) => {
      const done = finished.filter((f) => f.subjectCode === u.subjectCode);
      const last = done[0];
      return { ...u, completed: done.length, lastResult: last ? { assessmentId: last.assessmentId, correct: last.correct, total: last.total, mode: last.mode, at: last.submittedAt } : null };
    }),
    inProgress: open,
    focus,
  };
}

/** The same one-at-a-time rule as the API: main pass in order, then skipped ones once. */
function step(a) {
  if (!a.revisitUsed) {
    const fresh = a.items.find((i) => i.state === null);
    if (fresh) return { kind: 'ITEM', position: fresh.position, pass: 'MAIN' };
  } else {
    const pending = a.items.find((i) => i.state === 'SKIPPED' && i.skips === 1);
    if (pending) return { kind: 'ITEM', position: pending.position, pass: 'REVISIT' };
  }
  const answered = a.items.filter((i) => i.state === 'LOCKED').length;
  return { kind: 'SUMMARY', answered, unanswered: a.items.length - answered, canReviewSkipped: !a.revisitUsed && answered < a.items.length };
}
function view(a) {
  const base = { assessmentId: a.id, mode: a.mode, status: a.status, expiresAt: a.expiresAt, total: a.items.length, answered: a.items.filter((i) => i.state === 'LOCKED').length, removed: 0 };
  if (a.status !== 'IN_PROGRESS') return { ...base, phase: 'ENDED' };
  const s = step(a);
  if (s.kind === 'SUMMARY') return { ...base, phase: 'SUMMARY', summary: { answered: s.answered, unanswered: s.unanswered, canReviewSkipped: s.canReviewSkipped } };
  const it = a.items[s.position - 1];
  return { ...base, phase: 'QUESTION', question: { position: it.position, total: a.items.length, pass: s.pass, stem: it.stem, options: it.options.map((text, slot) => ({ slot, text })) } };
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body === undefined ? '' : JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : {};
  const url = new URL(req.url, 'http://stub');
  const path = url.pathname.replace(/^\//, '');
  const key = `${req.method} ${path}`;

  if (key === 'GET health') return json(res, 200, { status: 'ok' });
  // Test-only: forget every test taken, so each browser test starts from a clean slate. Not reachable through the web proxy.
  if (key === 'POST __reset') {
    assessments.clear();
    recs.clear();
    hidden.clear();
    social.clear();
    shares.clear();
    lastShareToken = null;
    return json(res, 200, { reset: true });
  }
  // Test-only: the token of the last sharing email (the real API emails it). Not reachable through the web proxy.
  if (key === 'GET __share-token') return json(res, 200, { token: lastShareToken });
  if (key === 'POST identity/otp/request') return json(res, 202, { sent: true });
  if (key === 'POST identity/otp/verify') {
    if (body.code !== '123456' || !PEOPLE[body.identifier]) return json(res, 401, { message: 'Invalid code' });
    const token = randomUUID();
    sessions.set(token, body.identifier);
    return json(res, 200, { sessionToken: token, expiresAt: new Date(Date.now() + 86400_000).toISOString(), isNewAccount: !!PEOPLE[body.identifier].isNew });
  }

  const p = person(req);
  if (!p) return json(res, 401, { message: 'Sign in first' });

  if (key === 'GET students/me') return json(res, 200, { studentId: 'stub', displayName: p.name, ageClassified: !p.isNew, requiresGuardianConsent: false });
  if (key === 'GET students/me/academic') {
    const options = [{ curriculumCode: 'ICSE', gradeCode: 'GRADE_8', label: 'ICSE · Grade 8' }];
    const grade = p.cohort ? { ...p.cohort, label: `${p.cohort.curriculumCode} · ${p.cohort.gradeCode.replace('_', ' ')}` } : null;
    return json(res, 200, { cohortOptions: options, grade, school: null });
  }
  if (key === 'GET home') return json(res, 200, home(p));
  if (key === 'GET mastery') {
    const finished = mine(p.email).filter((a) => a.status === 'SUBMITTED');
    return json(res, 200, {
      policy: 'MASTERY_V1',
      pending: 0,
      subjects: unitsFor(p).map((u) => {
        const tested = finished.some((a) => a.subject.subjectCode === u.subjectCode);
        const chapters = [1, 2].map((c) => {
          const label = tested && c === 1 ? 'BUILDING_EVIDENCE' : 'NOT_STARTED';
          return {
            code: `CH0${c}`,
            title: `${u.subjectName} chapter ${c}`,
            label,
            objectives: 2,
            started: label === 'NOT_STARTED' ? 0 : 2,
            reportable: 0,
            items: [1, 2].map((o) => ({ path: `CH0${c}/T01/MC01/LO0${o}`, code: `LO0${o}`, statement: `Objective ${c}.${o}`, label, answers: label === 'NOT_STARTED' ? 0 : 3 })),
          };
        });
        return { subjectVersionId: u.subjectVersionId, subjectCode: u.subjectCode, subjectName: u.subjectName, objectives: 4, started: tested ? 2 : 0, reportable: 0, chapters };
      }),
    });
  }
  if (key === 'GET compete') return json(res, 200, competeFor(p));
  if (key === 'GET entitlements') return json(res, 200, planOf(p));
  // Step 17: the parent view and sharing.
  if (key === 'GET parent/children') return json(res, 200, childrenOf(p).map(({ email, ...c }) => c));
  const pc = path.match(/^parent\/children\/([0-9a-f-]{36})(?:\/(leave)|\/reports\/([0-9a-f-]{36}))?$/);
  if (pc) {
    const child = childrenOf(p).find((c) => c.studentId === pc[1]);
    if (!child) return json(res, 404, { message: 'Not found' });
    if (pc[2] === 'leave') {
      if (child.basis === 'GUARDIAN') return json(res, 409, { message: 'You see this summary through your approval.' });
      const s = sharesOf(child.email);
      s.viewers = s.viewers.filter((v) => v.viewerEmail !== p.email);
      return json(res, 200, { left: true });
    }
    if (pc[3]) {
      if (pc[3] !== REPORT_ID) return json(res, 404, { message: 'Report not found' });
      const now = new Date();
      return json(res, 200, { ...parentSummary(child.email), period: { start: new Date(now.getTime() - 10 * 86400_000).toISOString(), end: new Date(now.getTime() - 3 * 86400_000).toISOString() }, id: REPORT_ID, version: 1, reason: 'WEEK_ENDED', generatedAt: now.toISOString() });
    }
    const now = new Date();
    return json(res, 200, {
      ...parentSummary(child.email),
      child: { studentId: child.studentId, label: child.label },
      basis: child.basis,
      pending: false,
      lastActiveAt: null,
      reports: [{ id: REPORT_ID, weekStart: new Date(now.getTime() - 10 * 86400_000).toISOString(), weekEnd: new Date(now.getTime() - 3 * 86400_000).toISOString(), version: 1 }],
    });
  }
  const pi = path.match(/^parent\/invitations\/(preview|accept|decline)$/);
  if (pi && req.method === 'POST') {
    const owner = [...shares.entries()].find(([, s]) => s.pending?.token === body.token);
    if (!owner) return json(res, 404, { message: 'This link is not valid' });
    const [studentEmail, s] = owner;
    if (s.pending.email !== p.email) return json(res, 403, { message: 'Sign in with the email address this invitation was sent to' });
    if (pi[1] === 'preview') return json(res, 200, { expiresAt: s.pending.expiresAt });
    if (pi[1] === 'accept') s.viewers.push({ grantId: randomUUID(), viewerEmail: p.email, maskedEmail: mask(p.email), since: new Date().toISOString() });
    s.pending = null;
    return json(res, 200, pi[1] === 'accept' ? { studentId: STUDENT_IDS[studentEmail] } : { declined: true });
  }
  if (key === 'GET parent-sharing') {
    const s = sharesOf(p.email);
    if (p.minor) return json(res, 200, { canShare: false, refusal: 'Your parent or guardian already sees your progress summary through their approval', isMinor: true, guardianViewers: 1, viewers: [], pending: null, consent: null });
    const full = s.viewers.length + (s.pending ? 1 : 0) >= 2;
    return json(res, 200, {
      canShare: !full,
      refusal: full ? 'You can share with up to 2 people at a time. Stop sharing with someone first.' : null,
      isMinor: false,
      guardianViewers: 0,
      viewers: s.viewers.map(({ viewerEmail, ...v }) => v),
      pending: s.pending ? { maskedEmail: mask(s.pending.email), expiresAt: s.pending.expiresAt } : null,
      consent: SHARING_WORDING,
    });
  }
  if (key === 'POST parent-sharing/invitations') {
    if (p.minor) return json(res, 409, { message: 'Your parent or guardian already sees your progress summary through their approval' });
    if (body.agreed !== true) return json(res, 400, { message: 'Tick the box to agree before sending' });
    if (body.consentVersion !== SHARING_WORDING.version) return json(res, 409, { message: 'The wording has changed. Please read it again before agreeing.' });
    const email = String(body.email ?? '').trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json(res, 400, { message: 'Enter a valid email address' });
    if (email === p.email) return json(res, 400, { message: "Enter a parent's own email address, not yours" });
    lastShareToken = randomUUID().replace(/-/g, '') + 'abcdefghijk';
    sharesOf(p.email).pending = { email, token: lastShareToken, expiresAt: new Date(Date.now() + 7 * 86400_000).toISOString() };
    return json(res, 200, { maskedEmail: mask(email), expiresAt: sharesOf(p.email).pending.expiresAt });
  }
  if (key === 'POST parent-sharing/invitations/cancel') {
    sharesOf(p.email).pending = null;
    return json(res, 200, { cancelled: true });
  }
  const ps = path.match(/^parent-sharing\/viewers\/([0-9a-f-]{36})\/stop$/);
  if (ps && req.method === 'POST') {
    const s = sharesOf(p.email);
    if (!s.viewers.some((v) => v.grantId === ps[1])) return json(res, 404, { message: 'Not found' });
    s.viewers = s.viewers.filter((v) => v.grantId !== ps[1]);
    return json(res, 200, { stopped: true });
  }
  if (key === 'GET parent-sharing/preview') {
    return json(res, 200, { ...parentSummary(p.email), child: { studentId: STUDENT_IDS[p.email] ?? 'stub', label: p.name ?? 'Student' }, basis: 'SELF_PREVIEW', pending: false, lastActiveAt: null, reports: [] });
  }
  // Step 16. Off for solo@example.com, as when SOCIAL_FEATURES_ENABLED is false.
  if (key === 'GET social') return json(res, 200, socialView(p));
  if (path.startsWith('social') && p.socialOff) return json(res, 404, { message: 'Not found' });
  if (key === 'POST social/code') {
    const s = socialOf(p);
    s.code = { code: 'XYZ789', expiresAt: new Date(Date.now() + 15 * 60_000).toISOString() };
    return json(res, 200, s.code);
  }
  if (key === 'POST social/friends') {
    const typed = String(body.code ?? '').replace(/[\s-]/g, '').toUpperCase();
    if (typed !== RIVAL.code) return json(res, 404, { message: 'That code is not valid, has been used, or has expired. Ask your friend to show you a new one.' });
    const s = socialOf(p);
    if (s.friends.length) return json(res, 409, { message: 'You are already friends (or waiting for approval)' });
    const f = { friendshipId: randomUUID(), handle: RIVAL.handle, status: p.minor ? 'PENDING_GUARDIAN' : 'ACTIVE', waitingFor: p.minor ? ['YOUR_GUARDIAN'] : [] };
    s.friends.push(f);
    return json(res, 200, { friendshipId: f.friendshipId, status: f.status });
  }
  const sf = path.match(/^social\/friends\/([0-9a-f-]{36})\/(unfriend|block|report)$/);
  if (req.method === 'POST' && sf) {
    const s = socialOf(p);
    if (!s.friends.some((f) => f.friendshipId === sf[1])) return json(res, 404, { message: 'Friend not found' });
    if (sf[2] === 'report' && !['UNWANTED_CONTACT', 'CHALLENGE_SPAM', 'SUSPECTED_CHEATING', 'MADE_ME_UNCOMFORTABLE', 'OTHER'].includes(body.reason)) return json(res, 400, { message: 'Choose one of the reasons' });
    s.friends = s.friends.filter((f) => f.friendshipId !== sf[1]);
    for (const c of s.challenges) if (c.status === 'PENDING' || c.status === 'ACTIVE') c.status = 'CANCELLED';
    return json(res, 200, { [sf[2] === 'unfriend' ? 'ended' : sf[2] === 'block' ? 'blocked' : 'reported']: true });
  }
  if (key === 'POST social/challenges') {
    const s = socialOf(p);
    const f = s.friends.find((x) => x.friendshipId === body.friendshipId);
    if (!f || f.status !== 'ACTIVE') return json(res, 409, { message: 'You can only challenge a friend whose friendship is active' });
    const u = unitsFor(p).find((x) => x.subjectVersionId === body.subjectVersionId);
    if (s.challenges.some((c) => c.subjectName === u.subjectName && (c.status === 'PENDING' || c.status === 'ACTIVE'))) return json(res, 409, { message: 'You already have an open challenge with this friend' });
    const c = { id: randomUUID(), role: 'CHALLENGER', status: 'PENDING', subjectName: u.subjectName, subject: u, opponentHandle: f.handle, expiresAt: new Date(Date.now() + 48 * 3600_000).toISOString(), myAssessmentId: null, result: null };
    s.challenges.push(c);
    return json(res, 200, { challengeId: c.id });
  }
  const sc = path.match(/^social\/challenges\/([0-9a-f-]{36})\/start$/);
  if (req.method === 'POST' && sc) {
    const c = socialOf(p).challenges.find((x) => x.id === sc[1]);
    if (!c) return json(res, 404, { message: 'Challenge not found' });
    if (!c.myAssessmentId) c.myAssessmentId = newAssessment(p, c.subject, 'TEST', 'CHALLENGE10');
    return json(res, 200, { assessmentId: c.myAssessmentId });
  }
  if (key === 'PUT compete/visibility') {
    if (p.minor) return json(res, 409, { message: 'Students who are minors are not shown to other students on leaderboards yet, so there is nothing to change' });
    if (body.shown) hidden.delete(p.email);
    else hidden.add(p.email);
    return json(res, 200, { shownToOthers: !!body.shown });
  }
  if (key === 'GET exam/units') return json(res, 200, unitsFor(p));
  if (key === 'GET exam/assessments') return json(res, 200, mine(p.email).map(row));
  if (key === 'POST exam/assessments') {
    const subject = unitsFor(p).find((u) => u.subjectVersionId === body.subjectVersionId);
    if (!subject) return json(res, 409, { message: 'This subject is not part of your curriculum and grade' });
    const blueprint = body.blueprint ?? 'QUICK10';
    const open = mine(p.email).find((a) => a.status === 'IN_PROGRESS' && a.mode === body.mode && a.blueprint === blueprint && a.subject.subjectCode === subject.subjectCode);
    if (open) return json(res, 200, { assessmentId: open.id, resumed: true });
    // Step 18: the plan limits only NEW tests the student chose themselves.
    const plan = planOf(p);
    if (blueprint === 'SUBJECT20' && !plan.values.LONG_TESTS) return json(res, 403, { message: 'Longer tests are not included in your plan.' });
    if (plan.leftToday === 0) return json(res, 403, { message: "You've started all the tests your plan includes today. Your recommended practice and retests are still open, and you can start more tests tomorrow." });
    return json(res, 200, { assessmentId: newAssessment(p, subject, body.mode, blueprint), resumed: false });
  }

  // Step 14. The real API refreshes recommendations about a minute after mastery; the stub does it at once.
  if (key === 'GET recommendations') return json(res, 200, focusFor(p));
  const fr = path.match(/^recommendations\/from-result\/([0-9a-f-]{36})$/);
  if (req.method === 'POST' && fr) {
    const t = assessments.get(fr[1]);
    if (!t || t.email !== p.email) return json(res, 404, { message: 'Assessment not found' });
    if (t.status !== 'SUBMITTED' || t.mode !== 'TEST') return json(res, 409, { message: 'Finish the test first' });
    const same = [...recs.values()].find((r) => r.sourceAssessmentId === t.id && (r.status === 'OPEN' || r.status === 'STARTED'));
    if (same) {
      const open = [...assessments.values()].find((a) => a.recommendationId === same.id && a.status === 'IN_PROGRESS');
      if (open) return json(res, 200, { assessmentId: open.id, resumed: true, recommendationId: same.id });
    }
    const missedPositions = t.items.filter((i) => i.state !== 'LOCKED' || i.slot !== i.correctSlot).map((i) => i.position);
    if (!missedPositions.length) return json(res, 409, { message: 'You got every question in this test right: there is nothing to practise from it' });
    for (const r of recs.values()) if (r.email === p.email && r.subject.subjectCode === t.subject.subjectCode && r.status === 'OPEN') r.status = 'SUPERSEDED';
    const rec = { id: randomUUID(), email: p.email, kind: 'PRACTICE', status: 'STARTED', source: 'RESULT', subject: t.subject, objectives: ['CH01/T01/MC01/LO01', 'CH01/T01/MC01/LO02'].slice(0, Math.min(2, missedPositions.length)), sourceAssessmentId: t.id, createdAt: new Date().toISOString() };
    recs.set(rec.id, rec);
    return json(res, 200, { assessmentId: newAssessment(p, t.subject, 'PRACTICE', 'PRACTICE10', rec.id), resumed: false, recommendationId: rec.id });
  }
  const ra = path.match(/^recommendations\/([0-9a-f-]{36})\/(start|dismiss)$/);
  if (req.method === 'POST' && ra) {
    const rec = recs.get(ra[1]);
    if (!rec || rec.email !== p.email) return json(res, 404, { message: 'Recommendation not found' });
    if (rec.status !== 'OPEN' && rec.status !== 'STARTED') return json(res, 409, { message: 'This recommendation is no longer open' });
    const open = [...assessments.values()].find((a) => a.recommendationId === rec.id && a.status === 'IN_PROGRESS');
    if (ra[2] === 'dismiss') {
      if (open) return json(res, 409, { message: 'Finish or leave the practice you started first' });
      rec.status = 'DISMISSED';
      return json(res, 200, { dismissed: true });
    }
    if (open) return json(res, 200, { assessmentId: open.id, resumed: true });
    rec.status = 'STARTED';
    const mode = rec.kind === 'PRACTICE' ? 'PRACTICE' : 'TEST';
    return json(res, 200, { assessmentId: newAssessment(p, rec.subject, mode, rec.kind === 'PRACTICE' ? 'PRACTICE10' : 'RETEST10', rec.id), resumed: false });
  }

  const m = path.match(/^exam\/assessments\/([0-9a-f-]{36})(?:\/(present|review-skipped|submit|result|questions\/(\d{1,2})\/(lock|skip)))?$/);
  const a = m ? assessments.get(m[1]) : null;
  if (!a || a.email !== p.email) return json(res, 404, { message: 'Assessment not found' });
  const action = m[4] ?? m[2];
  if (req.method === 'POST' && action === 'present') return json(res, 200, view(a));
  if (req.method === 'POST' && (action === 'lock' || action === 'skip')) {
    const s = step(a);
    const pos = Number(m[3]);
    if (s.kind !== 'ITEM' || s.position !== pos) return json(res, 409, { message: 'That is not the current question' });
    const it = a.items[pos - 1];
    if (action === 'skip') {
      it.state = 'SKIPPED';
      it.skips++;
      return json(res, 200, { skipped: true });
    }
    it.state = 'LOCKED';
    it.slot = body.slot;
    if (a.mode === 'PRACTICE') return json(res, 200, { locked: true, reveal: { correct: body.slot === it.correctSlot, correctSlot: it.correctSlot, explanation: 'Because.' } });
    return json(res, 200, { locked: true });
  }
  if (req.method === 'POST' && action === 'review-skipped') {
    a.revisitUsed = true;
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && action === 'submit') {
    if (step(a).kind !== 'SUMMARY') return json(res, 409, { message: 'Answer or skip every question first' });
    const correct = a.items.filter((i) => i.state === 'LOCKED' && i.slot === i.correctSlot).length;
    const unanswered = a.items.filter((i) => i.state !== 'LOCKED').length;
    a.status = 'SUBMITTED';
    a.submittedAt = new Date().toISOString();
    a.result = { correct, total: a.items.length, unanswered };
    // Stand-in for the recommendation refresh: a finished practice (5+ answers) becomes a retest; a finished retest is done.
    const rec = a.recommendationId ? recs.get(a.recommendationId) : null;
    if (rec && rec.status === 'STARTED') {
      if (rec.kind === 'RETEST') rec.status = 'COMPLETED';
      else if (a.items.filter((i) => i.state === 'LOCKED').length >= 5) {
        rec.status = 'COMPLETED';
        const retest = { ...rec, id: randomUUID(), kind: 'RETEST', status: 'OPEN', source: 'PRACTICE_DONE', sourceAssessmentId: null, createdAt: new Date().toISOString() };
        recs.set(retest.id, retest);
      } else rec.status = 'OPEN';
    }
    return json(res, 200, { submitted: true });
  }
  if (req.method === 'GET' && action === 'result') {
    if (a.status !== 'SUBMITTED') return json(res, 409, { message: 'The result is available after you submit' });
    const by = { EASY: { total: 0, correct: 0 }, MEDIUM: { total: 0, correct: 0 }, HARD: { total: 0, correct: 0 } };
    for (const i of a.items) {
      by[i.difficulty].total++;
      if (i.state === 'LOCKED' && i.slot === i.correctSlot) by[i.difficulty].correct++;
    }
    return json(res, 200, {
      assessmentId: a.id,
      mode: a.mode,
      total: a.result.total,
      correct: a.result.correct,
      unanswered: a.result.unanswered,
      removed: 0,
      corrected: false,
      byDifficulty: by,
      competitiveEligible: a.mode === 'TEST',
      items: a.items.map((i) => ({
        position: i.position,
        difficulty: i.difficulty,
        stem: i.stem,
        outcome: i.state !== 'LOCKED' ? 'UNANSWERED' : i.slot === i.correctSlot ? 'CORRECT' : 'INCORRECT',
        excludedReason: null,
        explanation: 'Because.',
        options: i.options.map((text, slot) => ({ slot, text, isCorrect: slot === i.correctSlot, chosen: i.slot === slot })),
      })),
    });
  }
  return json(res, 404, { message: `stub: no route for ${key}` });
});

server.listen(PORT, '127.0.0.1', () => console.log(`stub API on ${PORT}`));
