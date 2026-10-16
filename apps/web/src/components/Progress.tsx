'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppNav } from './AppNav';
import { AnalyticsConsent } from './AnalyticsConsent';
import { ParentSharing } from './ParentSharing';
import { ApiError, MASTERY_LABEL, bff, type MasteryLabel, type MasteryView, type MyAssessment, track } from '@/lib/client-api';

/**
 * Progress (spec STUDENT_WEB; MASTERY_DIAGNOSTICS; CLAIM_GATING): what the student has shown, objective by objective
 * and chapter by chapter, as gated labels. A label appears only once there is enough independent evidence; before that
 * it says "Building evidence", never a low score. No percentage is shown anywhere (Score != Mastery).
 */
export function Progress() {
  const [mastery, setMastery] = useState<MasteryView | null>(null);
  const [mine, setMine] = useState<MyAssessment[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    track('PROGRESS_OPENED');
    Promise.all([bff<MasteryView>('GET', 'mastery'), bff<MyAssessment[]>('GET', 'exam/assessments')])
      .then(([m, a]) => {
        setMastery(m);
        setMine(a);
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
      <p className="muted">
        What you know is worked out from many answers across tests, objective by objective. A label appears once there is
        enough evidence; until then it says Building evidence.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {!mastery && !error && <p className="muted" role="status">Loading…</p>}
      {mastery && mastery.pending > 0 && (
        <p className="hint" role="status">Your latest test is still being counted. Check back in a minute.</p>
      )}
      {mastery?.subjects.map((s) => {
        const done = mine.filter((m) => m.subjectCode === s.subjectCode && m.status === 'SUBMITTED');
        return (
          <section key={s.subjectVersionId} className="card" aria-labelledby={`p-${s.subjectCode}`}>
            <h2 id={`p-${s.subjectCode}`}>{s.subjectName}</h2>
            <p className="muted">
              {s.reportable} of {s.objectives} objective{s.objectives === 1 ? '' : 's'} with enough evidence · {s.started} started
            </p>
            <ul className="plain chapters">
              {s.chapters.map((c) => (
                <li key={c.code}>
                  <details>
                    <summary>
                      <span className="chapter-title">{c.title}</span> <Badge label={c.label} />
                    </summary>
                    <ul className="plain objectives">
                      {c.items.map((o) => (
                        <li key={o.path}>
                          <span>{o.statement}</span> <Badge label={o.label} />
                          {o.answers > 0 && <span className="hint"> · {o.answers} answer{o.answers === 1 ? '' : 's'}</span>}
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              ))}
            </ul>
            {done.length > 0 && (
              <>
                <h3 style={{ margin: '12px 0 6px', fontSize: '1rem' }}>Results</h3>
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
              </>
            )}
          </section>
        );
      })}
      {mastery && <ParentSharing />}
      {mastery && <AnalyticsConsent />}
      <p className="hint"><Link href="/privacy">Your data: download a copy or delete your account</Link></p>
    </div>
  );
}

function Badge({ label }: { label: MasteryLabel }) {
  return <span className={`badge badge-${label.toLowerCase().replace('_', '-')}`}>{MASTERY_LABEL[label]}</span>;
}
