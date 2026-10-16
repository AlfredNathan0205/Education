'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, type GuardianAnalyticsConsents } from '@/lib/client-api';

/** Step 19, on the guardian page: whether anonymous usage statistics include each child you approved. Off unless you agree. */
export function GuardianAnalytics() {
  const [v, setV] = useState<GuardianAnalyticsConsents | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    bff<GuardianAnalyticsConsents>('GET', 'guardian/analytics-consent').then(setV).catch(() => setV(null));
  }, []);
  useEffect(load, [load]);

  async function set(studentId: string, granted: boolean) {
    setBusy(studentId);
    setError(null);
    try {
      await bff('PUT', `guardian/analytics-consent/${studentId}`, { granted, consentVersion: v?.consent?.version });
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  if (!v || v.children.length === 0) return null;
  return (
    <section className="card" aria-labelledby="g-stats">
      <h2 id="g-stats">Anonymous usage statistics</h2>
      <p className="muted">Off unless you agree. Turning it off deletes what was collected. It changes nothing about how the app works.</p>
      {v.consent && (
        open ? (
          <>
            <h3 style={{ fontSize: '1rem' }}>{v.consent.title}</h3>
            {v.consent.draft && <p className="error" role="note">Draft wording for testing. It has not been reviewed by a lawyer.</p>}
            {v.consent.paragraphs.map((p, i) => <p key={i} className="muted">{p}</p>)}
          </>
        ) : (
          <p><button className="linklike" type="button" onClick={() => setOpen(true)}>What is collected</button></p>
        )
      )}
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      <ul className="plain" style={{ marginBottom: 0 }}>
        {v.children.map((c) => (
          <li key={c.studentId} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
            <span>{c.label}: <strong>{c.granted ? 'allowed' : 'off'}</strong></span>
            {c.granted ? (
              <button className="btn secondary small" type="button" disabled={busy !== null} onClick={() => void set(c.studentId, false)}>Turn off and delete</button>
            ) : v.consent ? (
              <button className="btn secondary small" type="button" disabled={busy !== null || !open} title={open ? undefined : 'Read what is collected first'} onClick={() => void set(c.studentId, true)}>Allow</button>
            ) : (
              <span className="hint">Not available yet</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
