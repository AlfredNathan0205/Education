'use client';

import { useEffect, useState } from 'react';
import {
  ApiError,
  bff,
  type AdminUnit,
  type BlueprintDesign,
  type BlueprintDetail,
  type BlueprintDifficulty,
  type BlueprintPreview,
  type BlueprintRelaxation,
  type BlueprintScopeMode,
  type BlueprintSummary,
} from '@/lib/client-api';

const DIFFS: BlueprintDifficulty[] = ['EASY', 'MEDIUM', 'HARD'];
const COGS = ['C1', 'C2', 'C3', 'C4'] as const;
const SCOPE_LABEL: Record<BlueprintScopeMode, string> = {
  WHOLE_SUBJECT: 'Whole subject',
  CHAPTERS: 'Listed chapters',
  STUDENT_FOCUS: "The student's chosen chapters",
  OBJECTIVES: 'Objectives from a recommendation (practice, retest)',
};
const STATUS_LABEL = { DRAFT: 'Draft', PUBLISHED: 'Published', RETIRED: 'Retired' } as const;
const REASON_LABEL: Record<string, string> = {
  IN_SCOPE: 'in scope',
  OUT_OF_SCOPE: 'outside scope',
  UNSEEN: 'unseen',
  SEEN_BEFORE: 'seen before',
  HEALTH_WATCH: 'on watch',
  NEW_CHAPTER: 'new chapter',
  NEW_OBJECTIVE: 'new objective',
  NEW_COGNITIVE: 'new cognitive level',
  UNTAGGED_COGNITIVE: 'no cognitive level',
  TIE_BREAK_RANDOM: 'random tie-break',
};

const EMPTY: BlueprintDesign = {
  totalQuestions: 10,
  difficulty: { EASY: 5, MEDIUM: 3, HARD: 2 },
  types: [{ type: 'MCQ', count: 10 }],
  scope: { mode: 'WHOLE_SUBJECT', strict: false, chapters: [] },
  cells: [],
  preferUnseen: true,
  openingDifficulty: 'EASY',
  notes: null,
};

function latestUnits(units: AdminUnit[]): AdminUnit[] {
  const best = new Map<string, AdminUnit>();
  for (const u of units) {
    const key = `${u.curriculumCode}|${u.versionLabel}|${u.gradeCode}|${u.subjectCode}`;
    const cur = best.get(key);
    if (!cur || u.revision > cur.revision) best.set(key, u);
  }
  return [...best.values()];
}

const mix = (d: BlueprintDesign) => DIFFS.map((k) => `${d.difficulty[k]} ${k.toLowerCase()}`).join(' / ');

export function relaxationText(r: BlueprintRelaxation): string {
  switch (r.kind) {
    case 'DIFFICULTY_SUBSTITUTED':
      return `${r.count} ${r.wanted.toLowerCase()} slot${r.count === 1 ? '' : 's'} filled with ${r.got.toLowerCase()} questions`;
    case 'CELL_MINIMUM_UNMET':
      return `cell ${r.cell} wanted at least ${r.wanted}, got ${r.got}`;
    case 'SCOPE_WIDENED':
      return r.reason === 'NO_FOCUS_CHAPTERS'
        ? 'no chapters chosen, so the whole subject was used'
        : `too few questions in scope; ${r.outOfScope} taken from other chapters`;
    case 'SEEN_QUESTIONS_USED':
      return `${r.count} question${r.count === 1 ? '' : 's'} the student has seen before`;
    case 'HEALTH_WATCH_USED':
      return `${r.count} question${r.count === 1 ? '' : 's'} on watch used`;
  }
}

export function Blueprints() {
  const [list, setList] = useState<BlueprintSummary[] | null>(null);
  const [units, setUnits] = useState<AdminUnit[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [detail, setDetail] = useState<BlueprintDetail | null>(null);
  const [design, setDesign] = useState<BlueprintDesign | null>(null);
  const [chaptersText, setChaptersText] = useState('');
  const [creating, setCreating] = useState(false);
  const [header, setHeader] = useState({ code: '', name: '', description: '', unitId: '' });
  const [previewVersion, setPreviewVersion] = useState('');
  const [previewUnit, setPreviewUnit] = useState('');
  const [seed, setSeed] = useState('');
  const [preview, setPreview] = useState<BlueprintPreview | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function reloadList() {
    setList(await bff<BlueprintSummary[]>('GET', 'admin/blueprints'));
  }

  useEffect(() => {
    Promise.all([bff<BlueprintSummary[]>('GET', 'admin/blueprints'), bff<AdminUnit[]>('GET', 'admin/questions/units')])
      .then(([b, u]) => {
        setList(b);
        setUnits(latestUnits(u));
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load test designs.');
      });
  }, []);

  async function guarded(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function show(d: BlueprintDetail) {
    setDetail(d);
    const draft = d.versions.find((v) => v.status === 'DRAFT');
    const published = d.versions.find((v) => v.status === 'PUBLISHED');
    const start = draft?.design ?? published?.design ?? null;
    setDesign(start ? structuredClone(start) : null);
    setChaptersText(start ? start.scope.chapters.join(', ') : '');
    setPreviewVersion((draft ?? published)?.versionId ?? '');
    setPreview(null);
  }

  const open = (id: string) =>
    guarded(async () => {
      setCreating(false);
      show(await bff<BlueprintDetail>('GET', `admin/blueprints/${id}`));
    });

  function startCreate() {
    setDetail(null);
    setPreview(null);
    setCreating(true);
    setHeader({ code: '', name: '', description: '', unitId: '' });
    setDesign(structuredClone(EMPTY));
    setChaptersText('');
  }

  /** What is sent: the design with chapters parsed and type counts kept equal to the total. */
  function body(d: BlueprintDesign) {
    const chapters = d.scope.mode === 'CHAPTERS' ? chaptersText.split(/[\s,]+/).map((c) => c.trim()).filter(Boolean) : [];
    return { ...d, types: [{ type: 'MCQ' as const, count: d.totalQuestions }], scope: { ...d.scope, chapters } };
  }

  const create = () =>
    guarded(async () => {
      if (!design) return;
      const unit = units.find((u) => u.id === header.unitId);
      const d = await bff<BlueprintDetail>('POST', 'admin/blueprints', {
        code: header.code,
        name: header.name,
        description: header.description || null,
        subject: unit ? { curriculumCode: unit.curriculumCode, gradeCode: unit.gradeCode, subjectCode: unit.subjectCode } : null,
        design: body(design),
      });
      setCreating(false);
      show(d);
      await reloadList();
      setMessage(`Created ${d.code} with draft version 1. It is switched off until a version is published and an approver switches it on.`);
    });

  const save = () =>
    guarded(async () => {
      if (!detail || !design) return;
      const d = await bff<BlueprintDetail>('PUT', `admin/blueprints/${detail.id}/draft`, body(design));
      show(d);
      await reloadList();
      setMessage(`Draft version ${d.draft?.version} saved. Nothing changes for students until it is published.`);
    });

  const act = (path: string, payload: unknown, done: string) =>
    guarded(async () => {
      if (!detail) return;
      const d = await bff<BlueprintDetail>('POST', `admin/blueprints/${detail.id}/${path}`, payload);
      show(d);
      await reloadList();
      setMessage(done);
    });

  const runPreview = () =>
    guarded(async () => {
      if (!previewVersion || !previewUnit) return;
      setPreview(await bff<BlueprintPreview>('POST', `admin/blueprints/versions/${previewVersion}/preview`, { unitId: previewUnit, seed: seed.trim() }));
    });

  const setD = (patch: Partial<BlueprintDesign>) => setDesign((d) => (d ? { ...d, ...patch } : d));
  const sum = design ? DIFFS.reduce((a, k) => a + design.difficulty[k], 0) : 0;

  if (loadError) {
    return (
      <div className="card">
        <h1>Test designs</h1>
        <p className="error" role="alert">{loadError}</p>
        <p className="muted">This page is for people who have been given a curriculum role. Ask an administrator.</p>
      </div>
    );
  }
  if (!list) return <p className="muted" role="status">Loading…</p>;

  const draft = detail?.versions.find((v) => v.status === 'DRAFT');
  const units4preview = detail?.subject
    ? units.filter((u) => u.curriculumCode === detail.subject!.curriculumCode && u.gradeCode === detail.subject!.gradeCode && u.subjectCode === detail.subject!.subjectCode)
    : units;

  return (
    <div className="card">
      <h1>Test designs</h1>
      <p className="muted">
        A test design (blueprint) says how many questions a test has, the difficulty mix and which chapters it draws on. Each
        change is a new version; a published version is never edited. Students are given a design only when it has a published
        version and an approver has switched it on. Tests already started keep the version they were built from.
      </p>

      <div role="alert" aria-live="polite">
        {error && <p className="error">{error}</p>}
        {message && <p className="muted">{message}</p>}
      </div>

      <h2>Designs</h2>
      {list.length === 0 && <p className="muted">No designs yet.</p>}
      <ul style={{ listStyle: 'none', padding: 0 }}>
        {list.map((b) => (
          <li key={b.id} style={{ borderTop: '1px solid var(--line, #ddd)', padding: '8px 0' }}>
            <button type="button" className="btn secondary" onClick={() => open(b.id)} aria-label={`Open design ${b.code}`}>
              {b.code}
            </button>{' '}
            <span>{b.name}</span>{' '}
            <span className="muted">
              · {b.enabled ? 'on' : 'off'}
              {b.published ? ` · v${b.published.version} published (${b.published.totalQuestions} questions)` : ' · nothing published'}
              {b.draft ? ` · draft v${b.draft.version}` : ''}
              {b.subject ? ` · ${b.subject.subjectCode} only` : ' · any subject'}
            </span>
          </li>
        ))}
      </ul>
      <button type="button" className="btn secondary" onClick={startCreate} disabled={busy}>New design</button>

      {creating && design && (
        <section aria-label="New design">
          <h2>New design</h2>
          <div className="field">
            <label htmlFor="bp-code">Code (capital letters, digits, _)</label>
            <input id="bp-code" value={header.code} maxLength={32} onChange={(e) => setHeader({ ...header, code: e.target.value.toUpperCase() })} />
          </div>
          <div className="field">
            <label htmlFor="bp-name">Name</label>
            <input id="bp-name" value={header.name} maxLength={120} onChange={(e) => setHeader({ ...header, name: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bp-desc">Description (optional)</label>
            <input id="bp-desc" value={header.description} maxLength={1000} onChange={(e) => setHeader({ ...header, description: e.target.value })} />
          </div>
          <div className="field">
            <label htmlFor="bp-subject">For</label>
            <select id="bp-subject" value={header.unitId} onChange={(e) => setHeader({ ...header, unitId: e.target.value })}>
              <option value="">Any subject</option>
              {units.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.curriculumCode} · {u.gradeCode.replace('_', ' ')} · {u.subjectName} only
                </option>
              ))}
            </select>
            <p className="hint">Choose one subject when the design names chapters. This cannot be changed later.</p>
          </div>
          <DesignEditor design={design} setD={setD} sum={sum} chaptersText={chaptersText} setChaptersText={setChaptersText} bound={header.unitId !== ''} />
          <button className="btn" disabled={busy || !header.code || !header.name} onClick={create}>
            {busy ? 'Working…' : 'Create (as draft version 1)'}
          </button>
        </section>
      )}

      {detail && (
        <section aria-label={`Design ${detail.code}`}>
          <h2>
            {detail.code} · {detail.name}
          </h2>
          {detail.description && <p className="muted">{detail.description}</p>}
          <p className="muted">
            {detail.subject ? `Only for ${detail.subject.curriculumCode} ${detail.subject.gradeCode} ${detail.subject.subjectCode}.` : 'For any subject.'}{' '}
            Students {detail.enabled ? 'can' : 'cannot'} be given this test.
          </p>
          {detail.enabled ? (
            <button className="btn secondary" disabled={busy} onClick={() => act('enabled', { enabled: false }, 'Switched off. No new tests are built from it; tests already started carry on.')}>
              Switch off (approvers only)
            </button>
          ) : (
            <button className="btn secondary" disabled={busy || !detail.published} onClick={() => act('enabled', { enabled: true }, 'Switched on. Students can now be given this test.')}>
              Switch on (approvers only)
            </button>
          )}

          <h3>Versions</h3>
          <ul>
            {detail.versions.map((v) => (
              <li key={v.versionId}>
                v{v.version} · {STATUS_LABEL[v.status]} · {v.design.totalQuestions} questions ({mix(v.design)}) · {SCOPE_LABEL[v.design.scope.mode]}
                {v.design.scope.strict ? ' (strict)' : ''}
                {v.design.cells.length ? ` · ${v.design.cells.length} cell rule${v.design.cells.length === 1 ? '' : 's'}` : ''}
                <span className="muted"> · {v.testsBuilt} test{v.testsBuilt === 1 ? '' : 's'} built{v.publishedAt ? ` · published ${new Date(v.publishedAt).toLocaleDateString()}` : ''}</span>
              </li>
            ))}
            {detail.versions.length === 0 && <li className="muted">No versions. Save a draft to start one.</li>}
          </ul>

          <h3>{draft ? `Edit draft v${draft.version}` : 'Start a new draft'}</h3>
          {!draft && <p className="muted">The form starts from the published version. Saving creates the next version as a draft.</p>}
          {!design && <button className="btn secondary" onClick={() => setDesign(structuredClone(EMPTY))}>Start from a blank design</button>}
          {design && (
            <>
              <DesignEditor design={design} setD={setD} sum={sum} chaptersText={chaptersText} setChaptersText={setChaptersText} bound={detail.subject !== null} />
              <button className="btn" disabled={busy} onClick={save}>{busy ? 'Working…' : 'Save draft'}</button>{' '}
              {draft && (
                <>
                  <button className="btn" disabled={busy} onClick={() => act('draft/publish', undefined, `Version ${draft.version} published. New tests use it from now on${detail.enabled ? '' : ' once the design is switched on'}.`)}>
                    Publish draft (approvers only)
                  </button>{' '}
                  <button className="btn secondary" disabled={busy} onClick={() => act('draft/discard', undefined, 'Draft discarded.')}>Discard draft</button>
                </>
              )}
            </>
          )}

          <h3>Preview</h3>
          <p className="muted">
            Builds the test this version would give a student who has seen nothing, from the questions published now. Nothing is
            saved. The same seed gives the same test.
          </p>
          <div className="field">
            <label htmlFor="pv-version">Version</label>
            <select id="pv-version" value={previewVersion} onChange={(e) => setPreviewVersion(e.target.value)}>
              <option value="">Choose…</option>
              {detail.versions.map((v) => (
                <option key={v.versionId} value={v.versionId}>v{v.version} ({STATUS_LABEL[v.status].toLowerCase()})</option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pv-unit">Subject</label>
            <select id="pv-unit" value={previewUnit} onChange={(e) => setPreviewUnit(e.target.value)}>
              <option value="">Choose…</option>
              {units4preview.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.curriculumCode} {u.versionLabel} · {u.gradeCode.replace('_', ' ')} · {u.subjectName}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="pv-seed">Seed (optional)</label>
            <input id="pv-seed" value={seed} maxLength={64} onChange={(e) => setSeed(e.target.value)} />
          </div>
          <button className="btn secondary" disabled={busy || !previewVersion || !previewUnit} onClick={runPreview}>
            {busy ? 'Working…' : 'Preview'}
          </button>
          {preview && <PreviewView p={preview} />}
        </section>
      )}
    </div>
  );
}

function DesignEditor(props: {
  design: BlueprintDesign;
  setD: (p: Partial<BlueprintDesign>) => void;
  sum: number;
  chaptersText: string;
  setChaptersText: (s: string) => void;
  bound: boolean;
}) {
  const { design, setD, sum, chaptersText, setChaptersText, bound } = props;
  const num = (v: string) => (v === '' ? 0 : Math.max(0, Math.floor(Number(v)) || 0));
  return (
    <div aria-label="Design">
      <div className="field">
        <label htmlFor="d-total">Questions</label>
        <input id="d-total" type="number" min={1} max={50} value={design.totalQuestions} onChange={(e) => setD({ totalQuestions: num(e.target.value) })} />
      </div>
      <div className="pair">
        {DIFFS.map((k) => (
          <div className="field" key={k}>
            <label htmlFor={`d-${k}`}>{k.charAt(0) + k.slice(1).toLowerCase()}</label>
            <input
              id={`d-${k}`}
              type="number"
              min={0}
              max={50}
              value={design.difficulty[k]}
              onChange={(e) => setD({ difficulty: { ...design.difficulty, [k]: num(e.target.value) } })}
            />
          </div>
        ))}
      </div>
      {sum !== design.totalQuestions && <p className="error">The difficulty counts add up to {sum}, not {design.totalQuestions}.</p>}
      <p className="hint">
        The bank has three difficulty levels. The spec&apos;s five-level mix (D1 to D5) is not used until the bank has five levels.
      </p>
      <div className="field">
        <label htmlFor="d-scope">Chapters</label>
        <select id="d-scope" value={design.scope.mode} onChange={(e) => setD({ scope: { ...design.scope, mode: e.target.value as BlueprintScopeMode } })}>
          {(Object.keys(SCOPE_LABEL) as BlueprintScopeMode[]).map((m) => (
            <option key={m} value={m} disabled={m === 'CHAPTERS' && !bound}>
              {SCOPE_LABEL[m]}{m === 'CHAPTERS' && !bound ? ' (needs a single-subject design)' : ''}
            </option>
          ))}
        </select>
      </div>
      {design.scope.mode === 'CHAPTERS' && (
        <div className="field">
          <label htmlFor="d-chapters">Chapter codes (comma separated)</label>
          <input id="d-chapters" value={chaptersText} onChange={(e) => setChaptersText(e.target.value)} />
        </div>
      )}
      {design.scope.mode !== 'WHOLE_SUBJECT' && (
        <label className="option">
          <input type="checkbox" checked={design.scope.strict} onChange={(e) => setD({ scope: { ...design.scope, strict: e.target.checked } })} /> Strict: never use
          other chapters (if they hold too few questions, no test is built)
        </label>
      )}
      <label className="option">
        <input type="checkbox" checked={design.preferUnseen} onChange={(e) => setD({ preferUnseen: e.target.checked })} /> Prefer questions the student has not seen
      </label>
      <div className="field">
        <label htmlFor="d-open">First question</label>
        <select id="d-open" value={design.openingDifficulty ?? ''} onChange={(e) => setD({ openingDifficulty: (e.target.value || null) as BlueprintDifficulty | null })}>
          <option value="">Any difficulty</option>
          {DIFFS.map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}
        </select>
      </div>

      <h4>Cell rules (optional)</h4>
      <p className="hint">
        &quot;At least N questions matching&quot; a chapter, difficulty and/or cognitive level. Cognitive levels only spread the test
        across C1 to C4; what each level means is not defined yet.
      </p>
      {design.cells.map((c, i) => (
        <div className="pair" key={i} aria-label={`Cell ${i + 1}`}>
          <div className="field">
            <label htmlFor={`c-ch-${i}`}>Chapter</label>
            <input
              id={`c-ch-${i}`}
              value={c.chapterCode ?? ''}
              disabled={!bound}
              placeholder={bound ? 'any' : 'any (single-subject designs only)'}
              onChange={(e) => setD({ cells: design.cells.map((x, j) => (j === i ? { ...x, chapterCode: e.target.value.trim() || null } : x)) })}
            />
          </div>
          <div className="field">
            <label htmlFor={`c-d-${i}`}>Difficulty</label>
            <select id={`c-d-${i}`} value={c.difficulty ?? ''} onChange={(e) => setD({ cells: design.cells.map((x, j) => (j === i ? { ...x, difficulty: (e.target.value || null) as BlueprintDifficulty | null } : x)) })}>
              <option value="">any</option>
              {DIFFS.map((k) => <option key={k} value={k}>{k.toLowerCase()}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`c-c-${i}`}>Cognitive</label>
            <select
              id={`c-c-${i}`}
              value={c.cognitive ?? ''}
              onChange={(e) => setD({ cells: design.cells.map((x, j) => (j === i ? { ...x, cognitive: (e.target.value || null) as BlueprintDesign['cells'][number]['cognitive'] } : x)) })}
            >
              <option value="">any</option>
              {COGS.map((k) => <option key={k} value={k}>{k}</option>)}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`c-n-${i}`}>At least</label>
            <input id={`c-n-${i}`} type="number" min={1} value={c.minCount} onChange={(e) => setD({ cells: design.cells.map((x, j) => (j === i ? { ...x, minCount: Math.max(1, num(e.target.value)) } : x)) })} />
          </div>
          <button type="button" className="btn secondary" onClick={() => setD({ cells: design.cells.filter((_, j) => j !== i) })} aria-label={`Remove cell ${i + 1}`}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" className="btn secondary" onClick={() => setD({ cells: [...design.cells, { chapterCode: null, difficulty: null, cognitive: null, minCount: 1 }] })}>
        Add a cell rule
      </button>
      <div className="field">
        <label htmlFor="d-notes">Notes (optional)</label>
        <textarea id="d-notes" maxLength={1000} value={design.notes ?? ''} onChange={(e) => setD({ notes: e.target.value || null })} />
      </div>
    </div>
  );
}

function PreviewView({ p }: { p: BlueprintPreview }) {
  if (!p.ok) {
    return (
      <p className="error">
        No test could be built: {p.available} usable question{p.available === 1 ? '' : 's'} for this design, {p.needed} needed. Publish more
        questions for this subject (or widen the scope).
      </p>
    );
  }
  const r = p.report;
  return (
    <section aria-label="Preview result">
      <p>
        <strong>{p.blueprint} v{p.version}</strong> <span className="muted">({p.status.toLowerCase()}) · seed {p.seed}</span>
      </p>
      {p.note && <p className="muted">{p.note}</p>}
      <p className="muted">
        Asked {mix({ difficulty: r.requested } as BlueprintDesign)}; got {mix({ difficulty: r.delivered } as BlueprintDesign)}. {r.chapters} chapter
        {r.chapters === 1 ? '' : 's'}, {r.objectives} objective{r.objectives === 1 ? '' : 's'}. Cognitive: C1 {r.cognitive.C1}, C2 {r.cognitive.C2}, C3{' '}
        {r.cognitive.C3}, C4 {r.cognitive.C4}, untagged {r.cognitive.UNTAGGED}. {r.pool.eligible} of {r.pool.offered} published questions could be used.
      </p>
      {r.relaxations.length === 0 ? (
        <p className="muted">The design was met exactly.</p>
      ) : (
        <>
          <p>Where the design could not be met exactly:</p>
          <ul>{r.relaxations.map((x, i) => <li key={i}>{relaxationText(x)}</li>)}</ul>
        </>
      )}
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: '0.9em' }}>
          <thead>
            <tr>
              {['#', 'Question', 'Chapter', 'Difficulty', 'Cognitive', 'Bank', 'Why'].map((h) => (
                <th key={h} style={{ textAlign: 'left', padding: '4px 6px', borderBottom: '1px solid var(--line, #ddd)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {p.items.map((i) => (
              <tr key={i.position}>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }}>{i.position}</td>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }}>
                  <strong>{i.code}</strong> {i.stem}
                </td>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }}>{i.chapter}</td>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }}>{i.difficulty.toLowerCase()}</td>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }}>{i.cognitive ?? '—'}</td>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }}>{i.health.toLowerCase()}</td>
                <td style={{ padding: '4px 6px', verticalAlign: 'top' }} className="muted">
                  {i.requirement === 'CELL' ? 'cell rule; ' : i.requirement === 'SUBSTITUTE' ? 'filled a short difficulty; ' : ''}
                  {i.reasons.map((x) => REASON_LABEL[x] ?? x).join(', ')} ({i.candidates} to choose from)
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
