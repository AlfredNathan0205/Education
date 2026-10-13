'use client';

import { useEffect, useState, type ChangeEvent } from 'react';
import { ApiError, bff, type AdminUnit, type UploadResult } from '@/lib/client-api';

const MAX_BYTES = 2_000_000;

export function AdminCurriculum() {
  const [units, setUnits] = useState<AdminUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unitId, setUnitId] = useState('');
  const [file, setFile] = useState<{ name: string; text: string; format: 'csv' | 'json' } | null>(null);
  const [preview, setPreview] = useState<UploadResult | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bff<AdminUnit[]>('GET', 'admin/curriculum/units')
      .then(setUnits)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load the units.');
      });
  }, []);

  function onFile(e: ChangeEvent<HTMLInputElement>) {
    setPreview(null);
    setMessage(null);
    setError(null);
    const f = e.target.files?.[0];
    if (!f) return setFile(null);
    const format = f.name.toLowerCase().endsWith('.json') ? 'json' : f.name.toLowerCase().endsWith('.csv') ? 'csv' : null;
    if (!format) return setError('Choose a .csv or .json file. In Excel, use Save As, CSV (Comma delimited).');
    if (f.size > MAX_BYTES) return setError('That file is too large (limit about 2 MB).');
    f.text().then((text) => setFile({ name: f.name, text, format }));
  }

  async function run(path: string, method: 'POST' | 'PUT', done: (r: UploadResult) => void) {
    if (!file || !unitId) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      done(await bff<UploadResult>(method, `admin/curriculum/units/${unitId}/${path}`, { format: file.format, text: file.text }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function submitForValidation() {
    setBusy(true);
    setError(null);
    try {
      const r = await bff<{ passed: boolean; findings: Array<{ severity: string; message: string }> }>('POST', `admin/curriculum/units/${unitId}/submit`);
      const errs = r.findings.filter((f) => f.severity === 'ERROR');
      setMessage(r.passed ? 'Automated validation passed. A reviewer verifies the evidence next.' : `Validation found ${errs.length} problem(s). Fix them and upload again:\n${errs.slice(0, 20).map((f) => `• ${f.message}`).join('\n')}`);
      setUnits(await bff<AdminUnit[]>('GET', 'admin/curriculum/units'));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (loadError) {
    return (
      <div className="card">
        <h1>Curriculum content</h1>
        <p className="error" role="alert">{loadError}</p>
        <p className="muted">This page is for people who have been given a curriculum role. Ask an administrator.</p>
      </div>
    );
  }
  if (!units) return <p className="muted" role="status">Loading…</p>;

  const unit = units.find((u) => u.id === unitId);
  const editable = unit && ['DRAFT', 'AI_STRUCTURED', 'CHANGES_REQUIRED'].includes(unit.state);
  const errs = preview?.findings.filter((f) => f.severity === 'ERROR') ?? [];

  return (
    <div className="card">
      <h1>Curriculum content</h1>
      <p className="muted">
        Upload the chapters, topics, concepts and learning objectives for one subject. Nothing becomes live from here:
        it is saved as a draft, checked automatically, then verified and approved by other people.{' '}
        <a href="/curriculum-upload-template.csv" download>Download the CSV template</a>.
      </p>

      <div className="field">
        <label htmlFor="unit">Subject</label>
        <select id="unit" value={unitId} onChange={(e) => { setUnitId(e.target.value); setPreview(null); setMessage(null); }}>
          <option value="">Choose…</option>
          {units.map((u) => (
            <option key={u.id} value={u.id}>
              {u.curriculumCode} {u.versionLabel} · {u.gradeCode.replace('_', ' ')} · {u.subjectName} (rev {u.revision}, {u.state})
            </option>
          ))}
        </select>
        {units.length === 0 && <p className="muted">No subjects exist yet. An operator creates them with the seed command.</p>}
      </div>

      {unit && !editable && (
        <p className="error">This subject is in state {unit.state}, so its content cannot be changed from here.</p>
      )}

      {unit && editable && (
        <>
          <div className="field">
            <label htmlFor="file">File (.csv or .json)</label>
            <input id="file" type="file" accept=".csv,.json" onChange={onFile} />
          </div>
          <button className="btn secondary" disabled={busy || !file} onClick={() => run('content/preview', 'POST', setPreview)}>
            {busy ? 'Checking…' : 'Check the file (nothing is saved)'}
          </button>
        </>
      )}

      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>

      {preview && (
        <section aria-label="Check result">
          <h2>{preview.written ? 'Saved' : preview.ok ? 'File is readable' : 'Fix these first'}</h2>
          <p className="muted">
            {preview.counts.chapters} chapters, {preview.counts.topics} topics, {preview.counts.concepts} concepts, {preview.counts.objectives} objectives.
          </p>
          {preview.issues.length > 0 && (
            <ul>
              {preview.issues.slice(0, 50).map((i, n) => <li key={n} className="error"><strong>{i.where}:</strong> {i.message}</li>)}
              {preview.issues.length > 50 && <li className="muted">…and {preview.issues.length - 50} more</li>}
            </ul>
          )}
          {preview.ok && errs.length > 0 && (
            <>
              <p className="muted">The file can be saved, but the automatic check would currently stop on:</p>
              <ul>{errs.slice(0, 20).map((f, n) => <li key={n}>{f.message} <span className="muted">({f.path})</span></li>)}</ul>
            </>
          )}
          {preview.ok && !preview.written && (
            <button className="btn" disabled={busy} onClick={() => run('content', 'PUT', (r) => { setPreview(r); setMessage('Saved as a draft. It replaces any earlier draft content for this subject.'); })}>
              Save as draft
            </button>
          )}
          {preview.written && (
            <button className="btn" disabled={busy} onClick={submitForValidation}>Submit for automated validation</button>
          )}
        </section>
      )}

      {message && <p role="status" style={{ whiteSpace: 'pre-line' }}>{message}</p>}
    </div>
  );
}
