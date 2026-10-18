'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, bff, type AdminUnit } from '@/lib/client-api';

const STATE_LABEL: Record<string, string> = {
  DISCOVERED: 'Started', EVIDENCE_COLLECTION: 'Collecting sources', DRAFT: 'Draft', AI_STRUCTURED: 'Draft', VALIDATION_PENDING: 'Being checked',
  VALIDATED: 'Checked', ADMIN_REVIEW: 'In review', CHANGES_REQUIRED: 'Sent back', APPROVED: 'Approved, not active', ACTIVE: 'Active',
  ACTIVE_WITH_REVIEW: 'Active, under review', SUSPENDED: 'Suspended', SUPERSEDED: 'Replaced', WITHDRAWN: 'Withdrawn', ARCHIVED: 'Archived', REJECTED: 'Rejected',
};
export const stateLabel = (s: string) => STATE_LABEL[s] ?? s;

/**
 * Step 22: the subjects' curricula. Each opens its own page, where the whole workflow is done: sources, content,
 * checks, review, approval and activation, and later suspension or a correction.
 */
export function AdminCurriculum() {
  const [units, setUnits] = useState<AdminUnit[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    bff<AdminUnit[]>('GET', 'admin/curriculum/units')
      .then(setUnits)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load the subjects.');
      });
  }, []);

  if (loadError) {
    return (
      <div className="card">
        <h1>Curriculum</h1>
        <p className="error" role="alert">{loadError}</p>
        <p className="muted">This page is for people who have been given a curriculum role. Ask an administrator.</p>
      </div>
    );
  }
  if (!units) return <p className="muted" role="status">Loading…</p>;

  return (
    <div className="card">
      <p><Link href="/admin">← Administration</Link></p>
      <h1>Curriculum</h1>
      <p className="muted">
        Each subject&apos;s chapters, topics, concepts and learning objectives. Nothing becomes live from an upload: a curriculum is
        checked automatically, its sources verified, reviewed, approved, and then activated by an approver who did not edit it.
        Activation still does not show it to students; that is a release, on the readiness page.
      </p>
      {units.length === 0 ? (
        <p className="muted">No subjects yet.</p>
      ) : (
        <ul aria-label="Subjects">
          {units.map((u) => (
            <li key={u.id}>
              <Link href={`/admin/curriculum/${u.id}`}>
                {u.curriculumCode} {u.versionLabel} · {u.gradeCode.replace('_', ' ')} · {u.subjectName}
              </Link>{' '}
              <span className="muted">revision {u.revision}, {stateLabel(u.state)}</span>
            </li>
          ))}
        </ul>
      )}
      {creating ? <CreateSubject onCancel={() => setCreating(false)} /> : (
        <button className="btn secondary" type="button" onClick={() => setCreating(true)}>Create a subject</button>
      )}
    </div>
  );
}

function CreateSubject({ onCancel }: { onCancel: () => void }) {
  const [f, setF] = useState({ curriculumCode: 'ICSE', curriculumName: 'ICSE', versionLabel: '', gradeCode: 'GRADE_8', subjectCode: '', subjectName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await bff<{ id: string }>('POST', 'admin/curriculum/units', f);
      window.location.assign(`/admin/curriculum/${r.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
      setBusy(false);
    }
  }

  const fields: Array<[keyof typeof f, string, string]> = [
    ['curriculumCode', 'Curriculum code', 'For example ICSE'],
    ['curriculumName', 'Curriculum name', 'For example Indian Certificate of Secondary Education'],
    ['versionLabel', 'Syllabus year or version', 'For example 2026-27'],
    ['gradeCode', 'Grade code', 'For example GRADE_8'],
    ['subjectCode', 'Subject code', 'For example PHYSICS'],
    ['subjectName', 'Subject name', 'For example Physics'],
  ];
  return (
    <form onSubmit={submit} aria-label="Create a subject">
      <h2>Create a subject</h2>
      <p className="muted">Editors only. It starts empty: add its sources and upload its content on the next page.</p>
      {fields.map(([k, label, hint]) => (
        <div className="field" key={k}>
          <label htmlFor={`new-${k}`}>{label}</label>
          <input id={`new-${k}`} value={f[k]} onChange={set(k)} placeholder={hint} required />
        </div>
      ))}
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      <button className="btn" type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create'}</button>{' '}
      <button className="btn secondary" type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}
