'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppNav } from './AppNav';
import { ApiError, bff, type HomeView, type MyAssessment } from '@/lib/client-api';

/**
 * Progress before the mastery engine exists (Step 13). It shows results as results, and says plainly that a picture of
 * what the student knows is still being built. It never turns a score into a mastery percentage (spec: Score != Mastery).
 */
export function Progress() {
  const [home, setHome] = useState<HomeView | null>(null);
  const [mine, setMine] = useState<MyAssessment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([bff<HomeView>('GET', 'home'), bff<MyAssessment[]>('GET', 'exam/assessments')])
      .then(([h, m]) => {
        setHome(h);
        setMine(m);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Could not load your progress.');
      });
  }, []);

  return (
    <div className="has-nav">
      <AppNav current="progress" />
      <h1>Progress</h1>
      <section className="card" aria-labelledby="building">
        <h2 id="building">Building your mastery profile</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          What you have mastered is worked out from several tests across your chapters, not from one score. Until there is
          enough evidence, we show your results only.
        </p>
      </section>
      {error && <p className="error" role="alert">{error}</p>}
      {!home && !error && <p className="muted" role="status">Loading…</p>}
      {home &&
        home.subjects.map((s) => {
          const done = mine.filter((m) => m.subjectCode === s.subjectCode && m.status === 'SUBMITTED');
          return (
            <section key={s.subjectVersionId} className="card" aria-labelledby={`p-${s.subjectCode}`}>
              <h2 id={`p-${s.subjectCode}`}>{s.subjectName}</h2>
              {done.length === 0 ? (
                <p className="muted" style={{ marginBottom: 0 }}>No finished tests yet.</p>
              ) : (
                <ul className="plain" style={{ marginBottom: 0 }}>
                  {done.map((m) => (
                    <li key={m.assessmentId}>
                      <Link href={`/tests/${m.assessmentId}`}>
                        {m.correct} of {m.total} · {m.mode === 'TEST' ? 'test' : 'practice'}
                      </Link>{' '}
                      <span className="muted">· {new Date(m.submittedAt ?? m.startedAt).toLocaleDateString()}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          );
        })}
    </div>
  );
}
