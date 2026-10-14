'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, bff, type ExamUnit, type MyAssessment } from '@/lib/client-api';

export function TestHome() {
  const [units, setUnits] = useState<ExamUnit[] | null>(null);
  const [mine, setMine] = useState<MyAssessment[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([bff<ExamUnit[]>('GET', 'exam/units'), bff<MyAssessment[]>('GET', 'exam/assessments')])
      .then(([u, m]) => {
        setUnits(u);
        setMine(m);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else if (e instanceof ApiError && e.status === 403) setLoadError(e.message);
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load your tests.');
      });
  }, []);

  async function start(unit: ExamUnit, mode: 'TEST' | 'PRACTICE') {
    setBusy(`${unit.subjectVersionId}:${mode}`);
    setError(null);
    try {
      const r = await bff<{ assessmentId: string }>('POST', 'exam/assessments', { subjectVersionId: unit.subjectVersionId, mode });
      window.location.assign(`/tests/${r.assessmentId}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <section className="card">
        <h1>Tests</h1>
        <p className="error" role="alert">{loadError}</p>
        <Link className="btn secondary" href="/profile">Go to your profile</Link>
      </section>
    );
  }
  if (!units) return <p className="muted" role="status">Loading…</p>;

  const open = mine.filter((m) => m.status === 'IN_PROGRESS');
  const done = mine.filter((m) => m.status !== 'IN_PROGRESS');

  return (
    <>
      <h1>Tests</h1>
      <p className="muted">Ten questions at a time. In a Test, answers are not shown until you submit. In Practice, you see the answer after each question.</p>

      {open.length > 0 && (
        <section className="card" aria-labelledby="open">
          <h2 id="open">Pick up where you left off</h2>
          {open.map((m) => (
            <p key={m.assessmentId}>
              <Link className="btn" href={`/tests/${m.assessmentId}`}>
                Continue {m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}
              </Link>
            </p>
          ))}
        </section>
      )}

      <section className="card" aria-labelledby="start">
        <h2 id="start">Start a new one</h2>
        {units.length === 0 && <p className="muted" style={{ marginBottom: 0 }}>No subjects are open for tests yet. Check back soon.</p>}
        {units.map((u) => (
          <div key={u.subjectVersionId} className="field">
            <p style={{ marginBottom: 6 }}>
              <strong>{u.subjectName}</strong> <span className="muted">· {u.curriculumCode} {u.gradeCode.replace('_', ' ')}</span>
            </p>
            {u.ready ? (
              <div className="pair">
                <button className="btn" disabled={busy !== null} onClick={() => start(u, 'TEST')}>
                  {busy === `${u.subjectVersionId}:TEST` ? 'Preparing…' : 'Start test'}
                </button>
                <button className="btn secondary" disabled={busy !== null} onClick={() => start(u, 'PRACTICE')}>
                  {busy === `${u.subjectVersionId}:PRACTICE` ? 'Preparing…' : 'Practice'}
                </button>
              </div>
            ) : (
              <p className="muted" style={{ marginBottom: 0 }}>Not enough questions yet. Check back soon.</p>
            )}
          </div>
        ))}
        <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      </section>

      {done.length > 0 && (
        <section className="card" aria-labelledby="past">
          <h2 id="past">Recent</h2>
          <ul className="plain">
            {done.map((m) => (
              <li key={m.assessmentId}>
                {m.status === 'SUBMITTED' ? (
                  <Link href={`/tests/${m.assessmentId}`}>
                    {m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}: {m.correct} of {m.total}
                  </Link>
                ) : m.status === 'INVALIDATED' ? (
                  <span className="muted">{m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}: cancelled, its questions were removed (does not count)</span>
                ) : (
                  <span className="muted">{m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}: expired, nothing was answered</span>
                )}{' '}
                <span className="muted">· {new Date(m.startedAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
      <Link className="btn secondary" href="/profile">Back to profile</Link>
    </>
  );
}
