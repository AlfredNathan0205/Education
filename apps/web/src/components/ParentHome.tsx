'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, type ParentChild, type ParentDashboard, type ParentReport } from '@/lib/client-api';
import { ParentSummary, periodText } from './ParentSummary';

/**
 * The parent page (Step 17): the students this account may see (a guardian's approved child, or an adult student who
 * shared with them), this week's summary, and past weekly reports. Choosing a child is by ?child=<id>.
 */
export function ParentHome() {
  const [children, setChildren] = useState<ParentChild[] | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  const [view, setView] = useState<ParentDashboard | null>(null);
  const [report, setReport] = useState<ParentReport | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const fail = (e: unknown, fallback: string) => {
    if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
    else setError(e instanceof ApiError ? e.message : fallback);
  };

  useEffect(() => {
    bff<ParentChild[]>('GET', 'parent/children')
      .then((list) => {
        setChildren(list);
        const wanted = new URLSearchParams(window.location.search).get('child');
        setChosen(list.find((c) => c.studentId === wanted)?.studentId ?? list[0]?.studentId ?? null);
      })
      .catch((e) => fail(e, 'Could not load this page.'));
  }, []);

  const load = useCallback((id: string) => {
    setView(null);
    setReport(null);
    setError(null);
    bff<ParentDashboard>('GET', `parent/children/${id}`)
      .then(setView)
      .catch((e) => fail(e, 'Could not load the summary.'));
  }, []);
  useEffect(() => {
    if (chosen) load(chosen);
  }, [chosen, load]);

  async function openReport(id: string) {
    if (!chosen) return;
    setError(null);
    try {
      setReport(await bff<ParentReport>('GET', `parent/children/${chosen}/reports/${id}`));
      window.scrollTo({ top: 0 });
    } catch (e) {
      fail(e, 'Could not load that report.');
    }
  }

  async function leave() {
    if (!chosen || !window.confirm('Stop seeing this summary? The student would need to invite you again.')) return;
    setBusy(true);
    try {
      await bff('POST', `parent/children/${chosen}/leave`);
      window.location.assign('/parent');
    } catch (e) {
      fail(e, 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !children) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!children) return <p className="muted" role="status">Loading…</p>;

  if (children.length === 0) {
    return (
      <>
        <h1>Progress summaries</h1>
        <section className="card">
          <p style={{ marginTop: 0 }}>You cannot see any student's progress yet.</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            A parent or guardian who approved a student's account sees it here. An adult student can also invite you from their
            Progress page.
          </p>
        </section>
        <form action="/sign-out" method="post"><button className="btn secondary" type="submit">Sign out</button></form>
      </>
    );
  }

  const current = children.find((c) => c.studentId === chosen);
  return (
    <>
      <h1>{report ? 'Weekly report' : 'Progress summary'}</h1>
      {children.length > 1 && (
        <nav aria-label="Choose a student">
          <ul className="chips" style={{ marginBottom: 12 }}>
            {children.map((c) => (
              <li key={c.studentId}>
                <button className="chip" type="button" aria-pressed={c.studentId === chosen} onClick={() => setChosen(c.studentId)}>
                  {c.label}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      )}
      {current && <p className="muted">{current.label}</p>}
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>

      {report ? (
        <>
          <p className="hint" role="note">
            Frozen at the end of that week{report.version > 1 ? ` and corrected since (version ${report.version}), because a question was found to be wrong` : ''}.
          </p>
          <ParentSummary content={report} live={false} />
          <button className="btn secondary" type="button" onClick={() => setReport(null)}>Back to this week</button>
        </>
      ) : !view ? (
        <p className="muted" role="status">Loading…</p>
      ) : (
        <>
          {view.pending && <p className="hint" role="status">A test was just finished and is still being counted.</p>}
          <p className="hint">
            Labels appear only when there is enough evidence from several tests. Until then they say Building evidence. Scores
            and answers are not shown.
          </p>
          <ParentSummary content={view} live />
          <section className="card" aria-labelledby="weeks">
            <h2 id="weeks">Weekly reports</h2>
            {view.reports.length === 0 ? (
              <p className="muted" style={{ marginBottom: 0 }}>The first weekly report appears after a week with tests in it.</p>
            ) : (
              <ul className="plain" style={{ marginBottom: 0 }}>
                {view.reports.map((r) => (
                  <li key={r.id}>
                    <button className="linklike" type="button" onClick={() => void openReport(r.id)}>
                      {periodText({ start: r.weekStart, end: r.weekEnd })}
                    </button>
                    {r.version > 1 && <span className="hint"> · corrected</span>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {view.basis === 'STUDENT_SHARE' ? (
            <button className="btn secondary" type="button" disabled={busy} onClick={() => void leave()}>Stop seeing this summary</button>
          ) : (
            <p className="hint">
              You see this because you approved this student's account. <Link href="/guardian">Your approvals</Link>
            </p>
          )}
        </>
      )}
      <div className="spacer" />
      <form action="/sign-out" method="post"><button className="btn secondary" type="submit">Sign out</button></form>
    </>
  );
}
