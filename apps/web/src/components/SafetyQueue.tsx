'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, REPORT_REASON_TEXT, bff, type ReportReason } from '@/lib/client-api';

interface Report {
  id: string;
  reason: ReportReason;
  createdAt: string;
  reporter: { studentId: string; handle: string };
  reported: { studentId: string; handle: string; openReports: number; restricted: boolean };
}

/** Step 16: open reports about students (SUPER_ADMIN only for now). Every view is audited. */
export function SafetyQueue() {
  const [items, setItems] = useState<Report[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    bff<Report[]>('GET', 'admin/safety/reports')
      .then(setItems)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? (e.status === 404 ? 'Friends and challenges are switched off.' : e.message) : 'Could not load the reports.');
      });
  }, []);
  useEffect(load, [load]);

  async function resolve(id: string, resolution: 'NO_ACTION' | 'RESTRICTED') {
    setBusy(id);
    try {
      await bff('POST', `admin/safety/reports/${id}/resolve`, { resolution });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <h1>Safety reports</h1>
      <p className="muted">Reports students sent about other students. Reporting already ended their friendship. Every view of this page is recorded.</p>
      {error && <p className="error" role="alert">{error}</p>}
      {items && items.length === 0 && <p className="muted">No open reports.</p>}
      {items?.map((r) => (
        <section className="card" key={r.id}>
          <h2>{REPORT_REASON_TEXT[r.reason] ?? r.reason}</h2>
          <p className="muted">
            {new Date(r.createdAt).toLocaleString()} · from {r.reporter.handle} about <strong>{r.reported.handle}</strong> ({r.reported.openReports} open
            report{r.reported.openReports === 1 ? '' : 's'}{r.reported.restricted ? ', already restricted' : ''})
          </p>
          <p className="hint">Student ids: {r.reporter.studentId} → {r.reported.studentId}</p>
          <div className="actions">
            <button className="btn secondary" disabled={busy === r.id} onClick={() => void resolve(r.id, 'NO_ACTION')}>Close, no action</button>
            <button className="btn" disabled={busy === r.id} onClick={() => void resolve(r.id, 'RESTRICTED')}>Restrict from friends and challenges</button>
          </div>
        </section>
      ))}
    </>
  );
}
