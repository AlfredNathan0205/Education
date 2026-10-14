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
};

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
    tests: TESTS,
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

function home(p) {
  const units = unitsFor(p);
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
    return json(res, 200, { reset: true });
  }
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
  if (key === 'GET exam/units') return json(res, 200, unitsFor(p));
  if (key === 'GET exam/assessments') return json(res, 200, mine(p.email).map(row));
  if (key === 'POST exam/assessments') {
    const subject = unitsFor(p).find((u) => u.subjectVersionId === body.subjectVersionId);
    if (!subject) return json(res, 409, { message: 'This subject is not part of your curriculum and grade' });
    const blueprint = body.blueprint ?? 'QUICK10';
    const open = mine(p.email).find((a) => a.status === 'IN_PROGRESS' && a.mode === body.mode && a.blueprint === blueprint && a.subject.subjectCode === subject.subjectCode);
    if (open) return json(res, 200, { assessmentId: open.id, resumed: true });
    const id = randomUUID();
    const items = Array.from({ length: 10 }, (_, i) => ({
      position: i + 1,
      difficulty: difficulty(i),
      stem: `${subject.subjectName} question ${i + 1}?`,
      options: ['Option A', 'Option B', 'Option C', 'Option D'],
      correctSlot: i % 4,
      state: null,
      skips: 0,
      slot: null,
    }));
    assessments.set(id, { id, email: p.email, subject, mode: body.mode, blueprint, status: 'IN_PROGRESS', revisitUsed: false, items, startedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 86400_000).toISOString(), submittedAt: null, result: null });
    return json(res, 200, { assessmentId: id, resumed: false });
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
