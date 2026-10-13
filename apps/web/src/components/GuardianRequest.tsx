'use client';

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiError, bff, type GuardianStatus } from '@/lib/client-api';

const RELATIONSHIPS: Array<{ value: string; label: string }> = [
  { value: 'MOTHER', label: 'Mother' },
  { value: 'FATHER', label: 'Father' },
  { value: 'LEGAL_GUARDIAN', label: 'Legal guardian' },
];

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long' });
}

/** Shown while a student needs a parent or guardian to approve. `onApproved` re-reads the profile. */
export function GuardianRequest({ onApproved }: { onApproved: () => void }) {
  const [status, setStatus] = useState<GuardianStatus | null>(null);
  const [email, setEmail] = useState('');
  const [relationship, setRelationship] = useState('MOTHER');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await bff<GuardianStatus>('GET', 'guardian/status');
      setStatus(s);
      if (s.approved) onApproved();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not check the request.');
    }
  }, [onApproved]);

  useEffect(() => {
    void refresh();
    const onVisible = () => document.visibilityState === 'visible' && void refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bff('POST', 'guardian/invitations', { email, relationshipType: relationship });
      setEmail('');
      setReplacing(false);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await bff('POST', 'guardian/invitations/cancel');
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (!status) {
    return error ? (
      <div className="card"><p className="error" role="alert">{error}</p></div>
    ) : (
      <p className="muted" role="status">Loading…</p>
    );
  }

  const showForm = !status.pending || replacing;

  return (
    <section className="card" aria-labelledby="g">
      <h1 id="g">A parent or guardian needs to approve first</h1>
      <p className="muted">
        To protect students, a parent or guardian approves your account before we ask for anything else. Nothing more is collected until then.
      </p>

      {status.pending && !replacing && (
        <div role="status" aria-live="polite">
          <p>
            We emailed a request to <strong>{status.pending.maskedEmail}</strong>. The link works until {formatDate(status.pending.expiresAt)}.
          </p>
          <p className="muted">Once they approve, come back here. This page checks again when you return to it.</p>
          <div className="pair">
            <button className="btn" type="button" onClick={() => void refresh()} disabled={busy}>Check again</button>
            <button className="btn secondary" type="button" onClick={() => setReplacing(true)} disabled={busy}>Use a different email</button>
          </div>
          <div className="spacer" />
          <button className="btn secondary" type="button" onClick={() => void cancel()} disabled={busy}>Cancel the request</button>
        </div>
      )}

      {showForm && (
        <>
          <h2>What happens next</h2>
          <ol className="muted" style={{ paddingLeft: '1.2rem' }}>
            <li>Enter a parent or guardian's email address.</li>
            <li>They receive a message explaining what we collect and why.</li>
            <li>Once they approve, you carry on. You can sign back in at any time to check.</li>
          </ol>
          <form onSubmit={send} noValidate>
            <div className="field">
              <label htmlFor="gemail">Parent or guardian email</label>
              <input id="gemail" type="email" autoComplete="off" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="parent@example.com" />
            </div>
            <div className="field">
              <label htmlFor="grel">They are my</label>
              <select id="grel" value={relationship} onChange={(e) => setRelationship(e.target.value)}>
                {RELATIONSHIPS.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
            <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
            <button className="btn" type="submit" disabled={busy || email.trim() === ''}>{busy ? 'Sending…' : 'Send approval request'}</button>
            {replacing && (
              <>
                <div className="spacer" />
                <button className="btn secondary" type="button" onClick={() => setReplacing(false)} disabled={busy}>Keep the current request</button>
              </>
            )}
          </form>
        </>
      )}
      {!showForm && error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
