'use client';

import { useEffect, useMemo, useState, type ChangeEvent } from 'react';
import {
  ApiError,
  bff,
  type AdminUnit,
  type QuestionDetail,
  type QuestionRow,
  type QuestionUploadResult,
} from '@/lib/client-api';

const MAX_BYTES = 2_000_000;
const STATE_LABEL: Record<QuestionRow['state'], string> = {
  DRAFT: 'Draft',
  IN_REVIEW: 'In review',
  CHANGES_REQUIRED: 'Sent back',
  APPROVED: 'Approved',
  RETIRED: 'Retired',
  SUPERSEDED: 'Replaced',
};
const FILTERS: Array<{ key: 'ALL' | QuestionRow['state']; label: string }> = [
  { key: 'ALL', label: 'All' },
  { key: 'DRAFT', label: 'Draft' },
  { key: 'IN_REVIEW', label: 'In review' },
  { key: 'CHANGES_REQUIRED', label: 'Sent back' },
  { key: 'APPROVED', label: 'Approved' },
];

/** One entry per subject (the newest revision), so a corrected curriculum does not list the subject twice. */
function latestUnits(units: AdminUnit[]): AdminUnit[] {
  const best = new Map<string, AdminUnit>();
  for (const u of units) {
    const key = `${u.curriculumCode}|${u.versionLabel}|${u.gradeCode}|${u.subjectCode}`;
    const cur = best.get(key);
    if (!cur || u.revision > cur.revision) best.set(key, u);
  }
  return [...best.values()];
}

export function QuestionBank() {
  const [units, setUnits] = useState<AdminUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unitId, setUnitId] = useState('');
  const [rows, setRows] = useState<QuestionRow[] | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]['key']>('ALL');
  const [file, setFile] = useState<{ name: string; text: string; format: 'csv' | 'json' } | null>(null);
  const [preview, setPreview] = useState<QuestionUploadResult | null>(null);
  const [detail, setDetail] = useState<QuestionDetail | null>(null);
  const [note, setNote] = useState('');
  const [verified, setVerified] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bff<AdminUnit[]>('GET', 'admin/questions/units')
      .then((u) => setUnits(latestUnits(u)))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load the subjects.');
      });
  }, []);

  async function loadRows(id: string) {
    setRows(null);
    try {
      setRows(await bff<QuestionRow[]>('GET', `admin/questions/units/${id}/questions`));
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load the questions.');
      setRows([]);
    }
  }

  function chooseUnit(id: string) {
    setUnitId(id);
    setPreview(null);
    setDetail(null);
    setMessage(null);
    setError(null);
    setFile(null);
    if (id) void loadRows(id);
    else setRows(null);
  }

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    setPreview(null);
    setMessage(null);
    setError(null);
    const f = e.target.files?.[0];
    if (!f) return setFile(null);
    const name = f.name.toLowerCase();
    const format = name.endsWith('.json') ? 'json' : name.endsWith('.csv') ? 'csv' : null;
    if (!format) return setError('Choose a .csv or .json file. In Excel, use Save As, CSV (Comma delimited).');
    if (f.size > MAX_BYTES) return setError('That file is too large (limit about 2 MB).');
    f.text().then((text) => setFile({ name: f.name, text, format }));
  }

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

  const upload = (save: boolean) =>
    guarded(async () => {
      if (!file || !unitId) return;
      const path = save ? `admin/questions/units/${unitId}/questions` : `admin/questions/units/${unitId}/preview`;
      const r = await bff<QuestionUploadResult>(save ? 'PUT' : 'POST', path, { format: file.format, text: file.text });
      setPreview(r);
      if (r.written) {
        setMessage('Saved as drafts. Open a question below and submit it for review.');
        await loadRows(unitId);
      }
    });

  async function open(row: QuestionRow) {
    setNote('');
    setVerified(false);
    setMessage(null);
    await guarded(async () => setDetail(await bff<QuestionDetail>('GET', `admin/questions/revisions/${row.revisionId}`)));
  }

  const act = (action: 'submit' | 'approve' | 'request-changes' | 'retire', body?: unknown, done?: string) =>
    guarded(async () => {
      if (!detail) return;
      await bff('POST', `admin/questions/revisions/${detail.revisionId}/${action}`, body);
      setMessage(done ?? 'Done.');
      const fresh = await bff<QuestionDetail>('GET', `admin/questions/revisions/${detail.revisionId}`);
      setDetail(fresh);
      setNote('');
      setVerified(false);
      await loadRows(unitId);
    });

  const shown = useMemo(() => (rows ?? []).filter((r) => filter === 'ALL' || r.state === filter), [rows, filter]);

  if (loadError) {
    return (
      <div className="card">
        <h1>Question bank</h1>
        <p className="error" role="alert">{loadError}</p>
        <p className="muted">This page is for people who have been given a curriculum role. Ask an administrator.</p>
      </div>
    );
  }
  if (!units) return <p className="muted" role="status">Loading…</p>;

  return (
    <div className="card">
      <h1>Question bank</h1>
      <p className="muted">
        Multiple-choice questions, each tied to one learning objective. Nothing here reaches students. A question is saved as a
        draft, submitted by an editor, then approved by a different person who confirms the answer key.{' '}
        <a href="/question-upload-template.csv" download>Download the CSV template</a>.
      </p>

      <div className="field">
        <label htmlFor="unit">Subject</label>
        <select id="unit" value={unitId} onChange={(e) => chooseUnit(e.target.value)}>
          <option value="">Choose…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.curriculumCode} {u.versionLabel} · {u.gradeCode.replace('_', ' ')} · {u.subjectName}
            </option>
          ))}
        </select>
        {units.length === 0 && <p className="muted">No subjects exist yet.</p>}
      </div>

      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>

      {unitId && (
        <>
          <h2>Add or correct questions</h2>
          <p className="muted">
            Each row needs a question code. Uploading a code that already exists changes that question while it is a draft or sent
            back; if it was approved, it becomes a new version that needs approving again.
          </p>
          <div className="field">
            <label htmlFor="file">File (.csv or .json)</label>
            <input id="file" type="file" accept=".csv,.json" onChange={onFile} />
          </div>
          <button className="btn secondary" disabled={busy || !file} onClick={() => upload(false)}>
            {busy ? 'Working…' : 'Check the file (nothing is saved)'}
          </button>

          {preview && (
            <section aria-label="Check result">
              <h3>{preview.written ? 'Saved' : preview.ok ? 'File is readable' : 'Fix these first'}</h3>
              <p className="muted">
                {preview.counts.CREATE} new, {preview.counts.UPDATE} changed, {preview.counts.NEW_REVISION} new versions of approved
                questions, {preview.counts.UNCHANGED} unchanged.
              </p>
              {preview.issues.length > 0 && (
                <ul>
                  {preview.issues.slice(0, 50).map((i, n) => <li key={n} className="error"><strong>{i.where}:</strong> {i.message}</li>)}
                  {preview.issues.length > 50 && <li className="muted">…and {preview.issues.length - 50} more</li>}
                </ul>
              )}
              {preview.ok && !preview.written && (
                <button className="btn" disabled={busy} onClick={() => upload(true)}>Save as drafts</button>
              )}
            </section>
          )}

          <h2>Questions</h2>
          <div className="seg" role="group" aria-label="Show">
            {FILTERS.map((f) => (
              <button key={f.key} type="button" aria-pressed={filter === f.key} onClick={() => setFilter(f.key)}>{f.label}</button>
            ))}
          </div>
          {rows === null && <p className="muted" role="status">Loading…</p>}
          {rows && shown.length === 0 && <p className="muted">No questions here yet.</p>}
          {shown.length > 0 && (
            <ul style={{ listStyle: 'none', padding: 0 }}>
              {shown.map((r) => (
                <li key={r.revisionId} style={{ borderTop: '1px solid var(--line, #ddd)', padding: '8px 0' }}>
                  <button type="button" className="btn secondary" onClick={() => open(r)} aria-label={`Open question ${r.code}`}>
                    {r.code}
                  </button>{' '}
                  <span className="muted">{STATE_LABEL[r.state]} · {r.difficulty.toLowerCase()} · v{r.revision}{r.origin === 'AI_DRAFT' ? ' · AI draft' : ''}</span>
                  <div>{r.stem}</div>
                  <div className="muted">{r.objectivePath}</div>
                </li>
              ))}
            </ul>
          )}
        </>
      )}

      {detail && (
        <section aria-label={`Question ${detail.code}`}>
          <h2>{detail.code} · {STATE_LABEL[detail.state]}</h2>
          <p><strong>{detail.stem}</strong></p>
          <ol type="A">
            {detail.options.map((o) => (
              <li key={o.label}>{o.text}{o.isCorrect ? <strong> ✔ correct</strong> : null}</li>
            ))}
          </ol>
          {detail.explanation && <p className="muted">Explanation: {detail.explanation}</p>}
          {detail.aiSource && <p className="muted">AI draft ({detail.aiSource}). Its answer key has not been checked by a person.</p>}
          {detail.reviewNote && <p className="muted">Reviewer note: {detail.reviewNote}</p>}

          {(detail.state === 'DRAFT' || detail.state === 'CHANGES_REQUIRED') && (
            <button className="btn" disabled={busy} onClick={() => act('submit', undefined, 'Submitted for review.')}>Submit for review</button>
          )}

          {detail.state === 'IN_REVIEW' && (
            <>
              <div className="field">
                <label>
                  <input type="checkbox" checked={verified} onChange={(e) => setVerified(e.target.checked)} />{' '}
                  I checked the answer key myself and it is correct
                </label>
              </div>
              <div className="field">
                <label htmlFor="note">Note (needed to send back)</label>
                <input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <button className="btn" disabled={busy || !verified} onClick={() => act('approve', { answerVerified: true, note: note || undefined }, 'Approved.')}>Approve</button>{' '}
              <button className="btn secondary" disabled={busy || note.trim().length < 5} onClick={() => act('request-changes', { note }, 'Sent back to the editor.')}>Send back</button>
            </>
          )}

          {detail.state === 'APPROVED' && (
            <>
              <div className="field">
                <label htmlFor="note2">Reason for retiring</label>
                <input id="note2" value={note} onChange={(e) => setNote(e.target.value)} />
              </div>
              <button className="btn secondary" disabled={busy || note.trim().length < 5} onClick={() => act('retire', { note }, 'Retired.')}>Retire this question</button>
            </>
          )}

          <h3>History</h3>
          <ul>
            {detail.history.map((h, n) => (
              <li key={n} className="muted">
                {new Date(h.at).toLocaleString()} · {h.actorKind.toLowerCase()} · {h.from ? `${h.from} → ` : ''}{h.to}{h.note ? ` · ${h.note}` : ''}
              </li>
            ))}
          </ul>
        </section>
      )}

      {message && <p role="status">{message}</p>}
    </div>
  );
}
