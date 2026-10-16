'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, type MyAnalyticsConsent } from '@/lib/client-api';

/**
 * Step 19, on Progress: the student's analytics choice. Off unless agreed. An adult decides; for a minor, the parent or
 * guardian who approved them decides (on their guardian page), and the student is told which way it is set.
 */
export function AnalyticsConsent() {
  const [c, setC] = useState<MyAnalyticsConsent | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    bff<MyAnalyticsConsent>('GET', 'analytics/consent').then(setC).catch(() => setC(null));
  }, []);
  useEffect(load, [load]);

  async function set(granted: boolean) {
    if (!c) return;
    setBusy(true);
    setError(null);
    try {
      await bff('PUT', 'analytics/consent', { granted, consentVersion: c.consent?.version });
      setOpen(false);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!c) return null;
  if (c.decidedBy === 'GUARDIAN') {
    return (
      <section className="card" aria-labelledby="stats">
        <h2 id="stats">Help improve Exam App</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Your parent or guardian decides whether anonymous usage statistics include you. Right now they {c.granted ? 'do' : 'do not'}.
        </p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="stats">
      <h2 id="stats">Help improve Exam App</h2>
      <p className="muted">
        {c.granted
          ? 'You allow anonymous usage statistics. You can turn this off at any time; what was collected is then deleted.'
          : 'Anonymous usage statistics are off. Nothing about how you use the app is counted.'}
      </p>
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      {c.granted ? (
        <button className="btn secondary" type="button" disabled={busy} onClick={() => void set(false)}>Turn off and delete</button>
      ) : !c.consent ? (
        <p className="hint" style={{ marginBottom: 0 }}>This choice is not available yet.</p>
      ) : !open ? (
        <button className="btn secondary" type="button" onClick={() => setOpen(true)}>Read more</button>
      ) : (
        <>
          <h3 style={{ fontSize: '1rem' }}>{c.consent.title}</h3>
          {c.consent.draft && <p className="error" role="note">Draft wording for testing. It has not been reviewed by a lawyer.</p>}
          {c.consent.paragraphs.map((p, i) => <p key={i} className="muted">{p}</p>)}
          <button className="btn" type="button" disabled={busy} onClick={() => void set(true)}>Allow anonymous statistics</button>
          <div className="spacer" />
          <button className="btn secondary" type="button" disabled={busy} onClick={() => setOpen(false)}>Not now</button>
        </>
      )}
    </section>
  );
}
