'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { ApiError, bff, type CurriculumDetail, type UploadResult, type WorkflowAction } from '@/lib/client-api';
import { stateLabel } from './AdminCurriculum';

const MAX_BYTES = 2_000_000;
const MIN_NOTE = 10;
const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

/** The workflow's steps, in the order they usually happen. `note`: the step needs a written reason. */
const STEPS: Array<{ action: WorkflowAction; path: string; label: string; note: boolean; danger?: boolean; done: string }> = [
  { action: 'submit', path: 'submit', label: 'Submit for automated checks', note: false, done: 'Checked.' },
  { action: 'verifyEvidence', path: 'verify-evidence', label: 'Verify the sources', note: true, done: 'Sources verified.' },
  { action: 'sendToReview', path: 'send-to-review', label: 'Start the review', note: false, done: 'In review.' },
  { action: 'requestChanges', path: 'request-changes', label: 'Send back for changes', note: true, done: 'Sent back to the editors.' },
  { action: 'approve', path: 'approve', label: 'Approve', note: true, done: 'Approved. An approver who did not edit it can now activate it.' },
  { action: 'activate', path: 'activate', label: 'Activate', note: true, done: 'Active. Students still see nothing until the subject is released on the readiness page.' },
  { action: 'suspend', path: 'suspend', label: 'Suspend', note: true, danger: true, done: 'Suspended. Students are no longer served this curriculum.' },
  { action: 'resume', path: 'resume', label: 'Resume', note: true, done: 'Active again.' },
  { action: 'startCorrection', path: 'correction', label: 'Start a correction (new revision)', note: false, done: 'A new draft revision was created.' },
  { action: 'withdraw', path: 'withdraw', label: 'Withdraw this revision', note: true, danger: true, done: 'Withdrawn.' },
];
/** Reasons that only say the step does not apply in this state: those steps are not shown at all. */
const NOT_APPLICABLE = /^(Not possible while|Only a suspended|Only a live|The evidence is already verified)/;

/**
 * Step 22: one subject's curriculum, end to end, on one page. The API decides what this person may do next and why
 * not, and checks every rule again when a step is taken.
 */
export function AdminCurriculumUnit({ id }: { id: string }) {
  const [d, setD] = useState<CurriculumDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    bff<CurriculumDetail>('GET', `admin/curriculum/units/${id}`)
      .then(setD)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(msg(e));
      });
  }, [id]);
  useEffect(load, [load]);

  async function step(s: (typeof STEPS)[number]) {
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const r = await bff<Record<string, unknown>>('POST', `admin/curriculum/units/${id}/${s.path}`, s.note ? { note: note.trim() } : {});
      if (s.action === 'startCorrection' && typeof r.id === 'string') {
        window.location.assign(`/admin/curriculum/${r.id}`);
        return;
      }
      if (s.action === 'submit') {
        const findings = (r.findings as Array<{ severity: string; message: string }> | undefined) ?? [];
        const errs = findings.filter((f) => f.severity === 'ERROR');
        setMessage(r.passed ? 'The automated checks passed. Next: verify the sources and start the review.' : `The checks found ${errs.length} problem(s). Fix them and upload again.`);
      } else setMessage(s.done);
      setNote('');
      load();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <div className="card"><p><Link href="/admin/curriculum">← Curriculum</Link></p><p className="error" role="alert">{loadError}</p></div>;
  if (!d) return <p className="muted" role="status">Loading…</p>;

  const u = d.unit;
  const shown = STEPS.filter((s) => d.actions[s.action].allowed || !NOT_APPLICABLE.test((d.actions[s.action] as { reason: string }).reason));
  const anyNote = shown.some((s) => s.note && d.actions[s.action].allowed);
  const noteOk = note.trim().length >= MIN_NOTE;

  return (
    <>
      <p><Link href="/admin/curriculum">← Curriculum</Link></p>
      <h1>{u.subjectName} · {u.curriculumCode} {u.versionLabel} · {u.gradeCode.replace('_', ' ')}</h1>
      <p role="status" aria-label="Curriculum state">
        Revision {u.revision}: <strong>{stateLabel(u.state)}</strong>
        {u.activatedAt ? ` (activated ${WHEN.format(new Date(u.activatedAt))})` : ''}.
      </p>
      {d.editors.length > 0 && <p className="muted">Edited by {d.editors.join(', ')}. None of them can activate this revision.</p>}

      <section className="card" aria-labelledby="next">
        <h2 id="next">Next steps</h2>
        {shown.length === 0 && <p className="muted">Nothing to do on this revision.</p>}
        {anyNote && (
          <div className="field">
            <label htmlFor="note">Note (at least {MIN_NOTE} characters; kept in the history)</label>
            <textarea id="note" rows={2} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
        )}
        <ul aria-label="Steps" style={{ listStyle: 'none', padding: 0 }}>
          {shown.map((s) => {
            const v = d.actions[s.action];
            const disabled = busy || !v.allowed || (s.note && !noteOk);
            return (
              <li key={s.action} style={{ marginBottom: '0.5rem' }}>
                <button className={s.danger ? 'btn secondary' : 'btn'} type="button" disabled={disabled} onClick={() => step(s)}>{s.label}</button>
                {!v.allowed && <span className="muted"> {v.reason}</span>}
                {v.allowed && s.note && !noteOk && <span className="muted"> Write a note first.</span>}
              </li>
            );
          })}
        </ul>
        <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
        {message && <p role="status">{message}</p>}
        {(u.state === 'ACTIVE' || u.state === 'ACTIVE_WITH_REVIEW') && (
          <p className="muted">Students see this subject only once it is released: <Link href="/admin/readiness">Readiness and release</Link>.</p>
        )}
      </section>

      <Evidence d={d} id={id} onChanged={load} />
      <Content d={d} id={id} onChanged={load} />

      {d.validation && (
        <section className="card" aria-labelledby="checks">
          <h2 id="checks">Automated checks</h2>
          <p className="muted">
            {d.validation.status}, {WHEN.format(new Date(d.validation.at))}: {d.validation.errors} errors, {d.validation.warnings} warnings.
          </p>
          {d.validation.findings.length > 0 && (
            <ul>{d.validation.findings.map((f, n) => <li key={n} className={f.severity === 'ERROR' ? 'error' : 'muted'}>{f.message} <span className="muted">({f.path})</span></li>)}</ul>
          )}
        </section>
      )}

      {d.revisions.length > 1 && (
        <section className="card" aria-labelledby="revs">
          <h2 id="revs">Revisions</h2>
          <ul aria-label="Revisions">
            {d.revisions.map((r) => (
              <li key={r.id}>
                {r.id === id ? <strong>Revision {r.revision} (this one)</strong> : <Link href={`/admin/curriculum/${r.id}`}>Revision {r.revision}</Link>}: {stateLabel(r.state)}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card" aria-labelledby="hist">
        <h2 id="hist">History</h2>
        <ul aria-label="Curriculum history">
          {d.history.map((h, n) => (
            <li key={n}>
              {WHEN.format(new Date(h.at))}: {h.from && h.to ? `${stateLabel(h.from)} → ${stateLabel(h.to)}` : h.type.replace(/_/g, ' ')}
              {h.actor ? ` by ${h.actor}` : h.actorKind !== 'HUMAN' ? ` (${h.actorKind.toLowerCase()})` : ''}
              {h.note ? `: “${h.note}”` : ''}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}

function Evidence({ d, id, onChanged }: { d: CurriculumDetail; id: string; onChanged: () => void }) {
  const [f, setF] = useState({ title: '', url: '', locator: '', retrievedAt: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can = d.actions.addEvidence;

  async function add(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bff('POST', `admin/curriculum/units/${id}/evidence`, f);
      setF({ title: '', url: '', locator: '', retrievedAt: '' });
      onChanged();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" aria-labelledby="evidence">
      <h2 id="evidence">Syllabus sources</h2>
      <p className="muted">
        The official syllabus documents this curriculum is taken from. A reviewer or approver checks them against the content.{' '}
        {d.evidence.status === 'VERIFIED'
          ? `Verified by ${d.evidence.verifiedBy ?? 'a reviewer'}${d.evidence.verifiedAt ? ` on ${WHEN.format(new Date(d.evidence.verifiedAt))}` : ''}${d.evidence.note ? `: “${d.evidence.note}”` : ''}.`
          : d.evidence.references.length ? 'Not verified yet.' : 'None added yet.'}
      </p>
      {d.evidence.references.length > 0 && (
        <ol aria-label="Sources">
          {d.evidence.references.map((r) => (
            <li key={r.number}>
              {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">{r.title}</a> : r.title}
              {r.locator ? `, ${r.locator}` : ''}
              {r.retrievedAt ? <span className="muted"> (retrieved {r.retrievedAt.slice(0, 10)})</span> : null}
            </li>
          ))}
        </ol>
      )}
      {can.allowed ? (
        <form onSubmit={add} aria-label="Add a source">
          <div className="field"><label htmlFor="ev-title">Source title</label><input id="ev-title" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required minLength={3} maxLength={500} /></div>
          <div className="field"><label htmlFor="ev-url">Link (optional)</label><input id="ev-url" type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} placeholder="https://" /></div>
          <div className="field"><label htmlFor="ev-loc">Where in it (optional)</label><input id="ev-loc" value={f.locator} onChange={(e) => setF({ ...f, locator: e.target.value })} placeholder="For example pages 4 to 9" /></div>
          <div className="field"><label htmlFor="ev-date">Retrieved on (optional)</label><input id="ev-date" type="date" value={f.retrievedAt} onChange={(e) => setF({ ...f, retrievedAt: e.target.value })} /></div>
          <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
          <button className="btn secondary" type="submit" disabled={busy}>Add the source</button>
        </form>
      ) : (
        <p className="muted">{can.reason}.</p>
      )}
    </section>
  );
}

function Content({ d, id, onChanged }: { d: CurriculumDetail; id: string; onChanged: () => void }) {
  const [file, setFile] = useState<{ name: string; text: string; format: 'csv' | 'json' } | null>(null);
  const [preview, setPreview] = useState<UploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const can = d.actions.uploadContent;
  const c = d.content;

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    setPreview(null);
    setError(null);
    const f = e.target.files?.[0];
    if (!f) return setFile(null);
    const lower = f.name.toLowerCase();
    const format = lower.endsWith('.json') ? 'json' : lower.endsWith('.csv') ? 'csv' : null;
    if (!format) return setError('Choose a .csv or .json file. In Excel, use Save As, CSV (Comma delimited).');
    if (f.size > MAX_BYTES) return setError('That file is too large (limit about 2 MB).');
    f.text().then((text) => setFile({ name: f.name, text, format }));
  }

  async function run(save: boolean) {
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      const r = await bff<UploadResult>(save ? 'PUT' : 'POST', `admin/curriculum/units/${id}/${save ? 'content' : 'content/preview'}`, { format: file.format, text: file.text });
      setPreview(r);
      if (r.written) onChanged();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  const errs = preview?.findings.filter((f) => f.severity === 'ERROR') ?? [];
  return (
    <section className="card" aria-labelledby="content">
      <h2 id="content">Content</h2>
      <p className="muted">{c.chapters} chapters, {c.topics} topics, {c.concepts} concepts, {c.objectives} learning objectives.</p>
      {c.chapterList.length > 0 && (
        <ul aria-label="Chapters">{c.chapterList.map((ch) => <li key={ch.code}>{ch.code} {ch.title} <span className="muted">({ch.objectives} objectives)</span></li>)}</ul>
      )}
      {can.allowed ? (
        <>
          <p className="muted">
            Upload the whole subject at once: it replaces any earlier draft content. <a href="/curriculum-upload-template.csv" download>Download the CSV template</a>.
          </p>
          <div className="field">
            <label htmlFor="file">File (.csv or .json)</label>
            <input id="file" type="file" accept=".csv,.json" onChange={onFile} />
          </div>
          <button className="btn secondary" type="button" disabled={busy || !file} onClick={() => run(false)}>{busy ? 'Checking…' : 'Check the file (nothing is saved)'}</button>
          <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
          {preview && (
            <section aria-label="Check result">
              <h3>{preview.written ? 'Saved as the draft content' : preview.ok ? 'File is readable' : 'Fix these first'}</h3>
              <p className="muted">{preview.counts.chapters} chapters, {preview.counts.topics} topics, {preview.counts.concepts} concepts, {preview.counts.objectives} objectives.</p>
              {preview.issues.length > 0 && (
                <ul>
                  {preview.issues.slice(0, 50).map((i, n) => <li key={n} className="error"><strong>{i.where}:</strong> {i.message}</li>)}
                  {preview.issues.length > 50 && <li className="muted">…and {preview.issues.length - 50} more</li>}
                </ul>
              )}
              {preview.ok && errs.length > 0 && (
                <>
                  <p className="muted">It can be saved, but the automated checks would currently stop on:</p>
                  <ul>{errs.slice(0, 20).map((f, n) => <li key={n}>{f.message} <span className="muted">({f.path})</span></li>)}</ul>
                </>
              )}
              {preview.ok && !preview.written && <button className="btn" type="button" disabled={busy} onClick={() => run(true)}>Save as draft</button>}
            </section>
          )}
        </>
      ) : (
        <p className="muted">{can.reason}.</p>
      )}
    </section>
  );
}
