// Step 22, for the browser tests only: the admin home, one subject's curriculum workflow, one question in a form, and
// AI drafting, kept in memory. It follows the real API's shapes. The real rules (the state machine, roles, the
// separation of duties) are tested in the API's unit and integration tests; this only mirrors enough of them for the
// page's behaviour to be seen.
import { randomUUID } from 'node:crypto';

const UNIT_ID = '77777777-7777-4777-8777-777777777771';
const EDIT_EVENTS = ['created', 'evidence_added', 'content_replaced', 'correction_revision_created'];
let units;
let questions;
let batches;

export function resetAdmin() {
  units = new Map();
  questions = [];
  batches = [];
  const now = new Date().toISOString();
  units.set(UNIT_ID, {
    id: UNIT_ID, curriculumCode: 'ICSE', versionLabel: '2026-27', gradeCode: 'GRADE_8', subjectCode: 'PHYSICS', subjectName: 'Physics',
    revision: 1, state: 'APPROVED', supersedesId: null, activatedAt: null,
    references: [{ title: 'CISCE Physics syllabus 2026-27', url: 'https://example.org/syllabus.pdf', locator: 'pages 4 to 9', retrievedAt: '2026-10-01T00:00:00.000Z' }],
    evidenceStatus: 'VERIFIED', verifiedBy: 'approver@example.com', verifiedAt: now,
    chapters: [{ code: 'CH01', title: 'Matter', objectives: 2 }],
    history: [
      { type: 'created', from: null, to: 'DRAFT', actor: 'admin@example.com', note: null, at: now },
      { type: 'state_changed', from: 'ADMIN_REVIEW', to: 'APPROVED', actor: 'approver@example.com', note: 'Matches the official syllabus', at: now },
    ],
  });
}
resetAdmin();

/** Roles per stub person: the admin is a super administrator who edited the subject; the approver did not. */
export const ADMIN_ROLES = { 'admin@example.com': ['SUPER_ADMIN'], 'approver@example.com': ['APPROVER'] };

const no = (reason) => ({ allowed: false, reason });
const yes = { allowed: true };
function actions(u, email) {
  const roles = ADMIN_ROLES[email] ?? [];
  const edit = roles.includes('SUPER_ADMIN') || roles.includes('EDITOR');
  const editor = u.history.some((h) => EDIT_EVENTS.includes(h.type) && h.actor === email);
  const editable = ['DISCOVERED', 'EVIDENCE_COLLECTION', 'DRAFT', 'AI_STRUCTURED', 'CHANGES_REQUIRED'].includes(u.state);
  const not = () => no(`Not possible while the curriculum is ${u.state}`);
  const activation = editor ? no('You edited this revision: an approver who did not edit it must do this') : u.evidenceStatus !== 'VERIFIED' ? no('The syllabus evidence must be verified first') : yes;
  return {
    addEvidence: editable ? (edit ? yes : no('Only an editor can add evidence')) : no(`Evidence cannot change while the curriculum is ${u.state}: start a correction`),
    uploadContent: editable ? (edit ? yes : no('Only an editor can upload content')) : no(`Content cannot change while the curriculum is ${u.state}: start a correction`),
    verifyEvidence: u.evidenceStatus === 'VERIFIED' ? no('The evidence is already verified') : u.references.length ? yes : no('Add at least one syllabus source first'),
    submit: editable && edit ? (u.chapters.length ? yes : no('Upload the chapters first')) : not(),
    sendToReview: u.state === 'VALIDATED' ? yes : not(),
    requestChanges: u.state === 'ADMIN_REVIEW' ? yes : not(),
    approve: u.state === 'ADMIN_REVIEW' ? yes : not(),
    activate: u.state === 'APPROVED' ? activation : not(),
    suspend: u.state === 'ACTIVE' ? yes : not(),
    resume: u.state === 'SUSPENDED' ? activation : no('Only a suspended curriculum can be resumed'),
    startCorrection: ['ACTIVE', 'SUSPENDED'].includes(u.state) ? ([...units.values()].some((x) => x.supersedesId === u.id) ? no('A correction is already being prepared') : edit ? yes : no('Only an editor can start a correction')) : no('Only a live curriculum is corrected with a new revision (edit this one directly)'),
    // As the real state machine: any pre-active revision (editors) or a suspended one (approvers).
    withdraw: ['DISCOVERED', 'EVIDENCE_COLLECTION', 'DRAFT', 'AI_STRUCTURED', 'VALIDATION_PENDING', 'VALIDATED', 'ADMIN_REVIEW', 'CHANGES_REQUIRED', 'APPROVED', 'SUSPENDED'].includes(u.state) ? yes : not(),
  };
}

const row = (u) => ({ id: u.id, curriculumCode: u.curriculumCode, versionLabel: u.versionLabel, gradeCode: u.gradeCode, subjectCode: u.subjectCode, subjectName: u.subjectName, revision: u.revision, state: u.state });
function detail(u, email) {
  const editors = [...new Set(u.history.filter((h) => EDIT_EVENTS.includes(h.type)).map((h) => h.actor))];
  const siblings = [...units.values()].filter((x) => x.subjectCode === u.subjectCode).sort((a, b) => b.revision - a.revision);
  return {
    unit: { ...row(u), supersedesId: u.supersedesId, activatedAt: u.activatedAt },
    evidence: { status: u.evidenceStatus, verifiedAt: u.verifiedAt, verifiedBy: u.verifiedBy, note: null, references: u.references.map((r, i) => ({ number: i + 1, ...r })) },
    content: { chapters: u.chapters.length, topics: u.chapters.length, concepts: u.chapters.length, objectives: u.chapters.reduce((n, c) => n + c.objectives, 0), chapterList: u.chapters },
    validation: null,
    revisions: siblings.map((s) => ({ id: s.id, revision: s.revision, state: s.state })),
    editors,
    history: [...u.history].reverse().map((h) => ({ ...h, actorKind: 'HUMAN' })),
    actions: actions(u, email),
  };
}

const OBJECTIVES = [
  { code: 'LO01', path: 'CH01/T01/MC01/LO01', statement: 'Describe the three states of matter', chapter: 'CH01 Matter', ambiguous: false },
  { code: 'LO02', path: 'CH01/T01/MC01/LO02', statement: 'Explain changes of state using particles', chapter: 'CH01 Matter', ambiguous: false },
];
const LETTERS = ['A', 'B', 'C', 'D'];

/** Handles a Step 22 route, or returns false. `send(status, body)` writes the response. */
export function handleAdmin(p, method, path, body, send) {
  const key = `${method} ${path}`;
  const roles = ADMIN_ROLES[p.email] ?? [];
  if (key === 'GET admin/me') return send(200, { roles });
  const staffOnly = /^admin\/(curriculum|questions|factory)\//.test(path);
  if (staffOnly && !roles.length) return send(403, { message: 'Only curriculum staff may do this' });

  if (key === 'GET admin/curriculum/units' || key === 'GET admin/questions/units') return send(200, [...units.values()].map(row));
  if (key === 'POST admin/curriculum/units') {
    if (!roles.includes('SUPER_ADMIN')) return send(403, { message: 'Only an editor may create a subject' });
    const id = randomUUID();
    const now = new Date().toISOString();
    units.set(id, { id, curriculumCode: String(body.curriculumCode).toUpperCase(), versionLabel: body.versionLabel, gradeCode: String(body.gradeCode).toUpperCase(), subjectCode: String(body.subjectCode).toUpperCase(), subjectName: body.subjectName, revision: 1, state: 'DRAFT', supersedesId: null, activatedAt: null, references: [], evidenceStatus: 'NONE', verifiedBy: null, verifiedAt: null, chapters: [], history: [{ type: 'created', from: null, to: 'DRAFT', actor: p.email, note: null, at: now }] });
    return send(200, { id, revision: 1 });
  }
  let m = path.match(/^admin\/curriculum\/units\/([0-9a-f-]{36})(?:\/(.+))?$/);
  if (m) {
    const u = units.get(m[1]);
    if (!u) return send(404, { message: 'Subject version not found' });
    const step = m[2];
    if (method === 'GET' && !step) return send(200, detail(u, p.email));
    const a = actions(u, p.email);
    const at = new Date().toISOString();
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    const needsNote = ['verify-evidence', 'request-changes', 'approve', 'activate', 'suspend', 'resume', 'withdraw'];
    if (needsNote.includes(step) && note.length < 10) return send(409, { message: 'Write a note of at least 10 characters' });
    const move = (to, type = 'state_changed') => { u.history.push({ type, from: u.state, to, actor: p.email, note: note || null, at }); u.state = to; };
    const gate = (v) => (v.allowed ? null : send(409, { message: v.reason }));
    if (step === 'evidence') {
      if (gate(a.addEvidence)) return true;
      u.references.push({ title: body.title, url: body.url || null, locator: body.locator || null, retrievedAt: body.retrievedAt ? new Date(body.retrievedAt).toISOString() : null });
      u.evidenceStatus = 'COLLECTING';
      u.history.push({ type: 'evidence_added', from: null, to: null, actor: p.email, note: null, at });
      return send(200, { referenceId: randomUUID() });
    }
    if (step === 'content/preview' || step === 'content') {
      if (gate(a.uploadContent)) return true;
      const lines = String(body.text ?? '').trim().split('\n').slice(1).filter(Boolean);
      const chapters = [...new Set(lines.map((l) => l.split(',')[0]))].map((code) => ({ code, title: `Chapter ${code}`, objectives: lines.filter((l) => l.startsWith(`${code},`)).length }));
      const result = { ok: chapters.length > 0, written: method === 'PUT' && chapters.length > 0, counts: { chapters: chapters.length, topics: chapters.length, concepts: chapters.length, objectives: lines.length }, issues: chapters.length ? [] : [{ where: 'file', message: 'No rows' }], findings: [] };
      if (result.written) {
        u.chapters = chapters;
        u.history.push({ type: 'content_replaced', from: null, to: null, actor: p.email, note: null, at });
      }
      return send(200, result);
    }
    if (step === 'submit') {
      if (gate(a.submit)) return true;
      move('VALIDATION_PENDING');
      move('VALIDATED');
      return send(200, { passed: true, findings: [] });
    }
    const steps = {
      'verify-evidence': () => { u.evidenceStatus = 'VERIFIED'; u.verifiedBy = p.email; u.verifiedAt = at; u.history.push({ type: 'evidence_verified', from: null, to: null, actor: p.email, note, at }); return { verified: true }; },
      'send-to-review': () => (move('ADMIN_REVIEW'), { state: u.state }),
      'request-changes': () => (move('CHANGES_REQUIRED'), { state: u.state }),
      approve: () => (move('APPROVED'), { state: u.state }),
      activate: () => (move('ACTIVE'), (u.activatedAt = at), { state: u.state }),
      suspend: () => (move('SUSPENDED'), { state: u.state }),
      resume: () => (move('ACTIVE'), { state: u.state }),
      withdraw: () => (move('WITHDRAWN'), { state: u.state }),
      correction: () => {
        const id = randomUUID();
        units.set(id, { ...u, id, revision: u.revision + 1, state: 'DRAFT', supersedesId: u.id, activatedAt: null, references: [...u.references], history: [{ type: 'correction_revision_created', from: null, to: 'DRAFT', actor: p.email, note: null, at }] });
        return { id, revision: u.revision + 1 };
      },
    };
    const toAction = { 'verify-evidence': 'verifyEvidence', 'send-to-review': 'sendToReview', 'request-changes': 'requestChanges', approve: 'approve', activate: 'activate', suspend: 'suspend', resume: 'resume', withdraw: 'withdraw', correction: 'startCorrection' };
    if (!steps[step]) return send(404, { message: 'Unknown step' });
    if (gate(a[toAction[step]])) return true;
    return send(200, steps[step]());
  }

  // Questions: the list, the summary, one question in a form, and a question's detail.
  m = path.match(/^admin\/questions\/units\/([0-9a-f-]{36})\/(questions|objectives|question)$/);
  if (m) {
    if (m[2] === 'objectives') return send(200, OBJECTIVES);
    if (m[2] === 'questions' && method === 'GET') return send(200, questions.map(({ options, correct, explanation, ...r }) => r));
    if (m[2] === 'question' && method === 'POST') {
      if (!roles.includes('SUPER_ADMIN')) return send(403, { message: 'only an editor may upload questions' });
      const issues = [];
      if (!body.code) issues.push({ where: 'question 1', message: 'code is required' });
      if (!OBJECTIVES.some((o) => o.code === body.objectiveCode)) issues.push({ where: 'question 1', message: `no learning objective with code ${body.objectiveCode}` });
      if (!Array.isArray(body.options) || body.options.some((o) => !String(o).trim())) issues.push({ where: 'question 1', message: 'every option needs text' });
      if (issues.length) return send(200, { ok: false, written: false, counts: { CREATE: 0, UPDATE: 0, NEW_REVISION: 0, UNCHANGED: 0 }, issues, revisionId: null });
      const revisionId = randomUUID();
      const obj = OBJECTIVES.find((o) => o.code === body.objectiveCode);
      questions.push({ questionId: randomUUID(), revisionId, code: String(body.code).toUpperCase(), objectivePath: obj.path, stem: body.stem, difficulty: body.difficulty, cognitive: body.cognitive || null, state: 'DRAFT', revision: 1, origin: 'HUMAN', bankStatus: 'NOT_PUBLISHED', options: body.options, correct: LETTERS.indexOf(body.correct), explanation: body.explanation || null });
      return send(200, { ok: true, written: true, counts: { CREATE: 1, UPDATE: 0, NEW_REVISION: 0, UNCHANGED: 0 }, issues: [], revisionId });
    }
  }
  m = path.match(/^admin\/questions\/revisions\/([0-9a-f-]{36})$/);
  if (m) {
    const q = questions.find((x) => x.revisionId === m[1]);
    if (!q) return send(404, { message: 'Question not found' });
    const { options, correct, ...r } = q;
    return send(200, { ...r, publication: null, options: options.map((t, i) => ({ label: LETTERS[i], text: t, isCorrect: i === correct })), reviewNote: null, answerVerified: false, aiSource: null, validation: null, generation: null, history: [{ from: null, to: 'DRAFT', actorKind: 'HUMAN', reasonCode: null, note: null, at: new Date().toISOString() }] });
  }
  if (/^admin\/publication\/units\/[0-9a-f-]{36}\/summary$/.test(path)) {
    return send(200, { total: questions.length, byState: { DRAFT: questions.length }, byStatus: { NOT_PUBLISHED: questions.length, WITHDRAWN: 0, NEW: 0, HEALTHY: 0, WATCH: 0, DEGRADED: 0, QUARANTINED: 0, RETIRED: 0 }, awaitingPublication: 0 });
  }

  // AI drafting, with the mock provider switched on.
  if (key === 'GET admin/factory/status') {
    const used = batches.reduce((n, b) => n + b.stored * 400, 0);
    return send(200, { available: true, reason: null, provider: 'mock', dailyTokenBudget: 200000, tokensUsedToday: used });
  }
  if (/^admin\/factory\/units\/[0-9a-f-]{36}\/suggestions$/.test(path)) {
    return send(200, { target: 8, cells: [{ objectivePath: 'CH01/T01/MC01/LO02', objectiveCode: 'LO02', difficulty: 'HARD', approved: 0, inPipeline: 0, requestable: 8 }] });
  }
  if (key === 'GET admin/factory/batches') return send(200, batches);
  if (key === 'POST admin/factory/batches') {
    if (!roles.includes('SUPER_ADMIN')) return send(403, { message: 'Only an editor can start AI drafting' });
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 10) return send(400, { message: 'From this page, ask for 1 to 10 drafts at a time' });
    const obj = OBJECTIVES.find((o) => o.code === body.objectiveCode);
    if (!obj) return send(409, { message: `No objective ${body.objectiveCode} in this subject` });
    const batchId = randomUUID();
    for (let i = 0; i < count; i++) {
      questions.push({ questionId: randomUUID(), revisionId: randomUUID(), code: `AI-${batchId.slice(0, 6).toUpperCase()}-${i + 1}`, objectivePath: obj.path, stem: `Mock draft ${i + 1}: which statement about particles is correct?`, difficulty: body.difficulty, cognitive: body.cognitive, state: 'DRAFT', revision: 1, origin: 'AI_DRAFT', bankStatus: 'NOT_PUBLISHED', options: ['One', 'Two', 'Three', 'Four'], correct: 1, explanation: null });
    }
    batches.unshift({ id: batchId, startedAt: new Date().toISOString(), status: 'COMPLETED', objectivePath: obj.path, difficulty: body.difficulty, cognitive: body.cognitive, requested: count, stored: count, rejected: 0, duplicates: 0, failed: 0, provider: 'mock/mock-1' });
    return send(200, { batchId, status: 'COMPLETED', stopReason: null, requested: count, attempted: count, draftsStored: count, rejected: 0, duplicates: 0, failed: 0, routes: {} });
  }
  return false;
}
