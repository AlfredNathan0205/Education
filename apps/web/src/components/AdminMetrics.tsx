'use client';

import { useEffect, useState } from 'react';
import { ApiError, bff, type AdminMetrics as Metrics } from '@/lib/client-api';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const show = (v: number | '<5' | null) => (v === null ? '–' : String(v));
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v * 100)}%`);

/**
 * Step 19: product metrics for administrators (spec ANALYTICS_QA_RELEASE). Totals from consenting students only,
 * pseudonymous, counts under 5 hidden. The North Star is weekly active learners completing a qualified test.
 * There is no screen-time measure, by design.
 */
export function AdminMetrics() {
  const [m, setM] = useState<Metrics | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    bff<Metrics>('GET', 'admin/analytics/metrics')
      .then(setM)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Could not load the metrics.');
      });
  }, []);
  if (error) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!m) return <p className="muted" role="status">Loading…</p>;
  const rows: Array<[string, (w: Metrics['weeks'][number]) => string]> = [
    ['North Star: learners completing a qualified test', (w) => show(w.northStar)],
    ['Qualified tests per active learner', (w) => (w.intensity === null ? '–' : String(w.intensity))],
    ['Learners completing any test or practice', (w) => show(w.activeLearners)],
    ['Started', (w) => show(w.started)],
    ['Completed', (w) => show(w.completed)],
    ['Completion rate', (w) => pct(w.completionRate)],
    ['New learners', (w) => show(w.signups)],
    ['… of whom finished a test within 7 days', (w) => show(w.activated)],
    ['Results opened', (w) => show(w.loop.resultsOpened)],
    ['"Practise what you missed" clicked', (w) => show(w.loop.practiseMissed)],
    ['Recommended practice started', (w) => show(w.loop.practiceFromRecommendation)],
    ['Retests completed', (w) => show(w.loop.retestsCompleted)],
    ['Objectives improved (gated labels)', (w) => show(w.improvedObjectives)],
    ['Parent views', (w) => show(w.parentViews)],
    ['… students whose parent looked', (w) => show(w.studentsWithParentViews)],
  ];
  return (
    <>
      <h1>Metrics</h1>
      <p className="muted">
        Only students who allow anonymous statistics are counted: {show(m.coverage.consenting)} of {show(m.coverage.students)} students. Counts under 5 show as
        "&lt;5". Weeks start Monday, India time.
      </p>
      <section className="card" style={{ overflowX: 'auto' }} aria-labelledby="weekly">
        <h2 id="weekly">By week</h2>
        <table className="metrics">
          <thead>
            <tr>
              <th scope="col">Measure</th>
              {m.weeks.map((w) => <th key={w.weekStart} scope="col">{DAY.format(new Date(w.weekStart))}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, f]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {m.weeks.map((w) => <td key={w.weekStart}>{f(w)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="card" aria-labelledby="ret">
        <h2 id="ret">Coming back</h2>
        <ul className="plain" style={{ marginBottom: 0 }}>
          <li>Day 7: {pct(m.returns.d7.rate)} ({show(m.returns.d7.returned)} of {show(m.returns.d7.eligible)})</li>
          <li>Day 30: {pct(m.returns.d30.rate)} ({show(m.returns.d30.returned)} of {show(m.returns.d30.eligible)})</li>
        </ul>
      </section>
    </>
  );
}
