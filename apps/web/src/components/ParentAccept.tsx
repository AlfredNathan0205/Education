'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, bff, recalledShareToken, rememberShareToken } from '@/lib/client-api';

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; canSignOut?: boolean }
  | { kind: 'review'; expiresAt: string }
  | { kind: 'accepted'; studentId: string }
  | { kind: 'declined' };

/** Reads the one-time token from the link's #fragment (which never reaches a server log), then keeps it only in this tab. */
function readToken(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  if (m) {
    rememberShareToken(m[1]);
    window.history.replaceState(null, '', window.location.pathname);
    return m[1];
  }
  return recalledShareToken();
}

/** A parent answering an adult student's invitation to see their progress summary (Step 17). */
export function ParentAccept() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = readToken();
    if (!t) {
      setPhase({ kind: 'error', message: 'This link is incomplete. Open the link from the email again.' });
      return;
    }
    setToken(t);
    bff<{ expiresAt: string }>('POST', 'parent/invitations/preview', { token: t })
      .then((p) => setPhase({ kind: 'review', expiresAt: p.expiresAt }))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) {
          // Not signed in yet: sign in, and the token (kept in this tab) brings you straight back.
          window.location.assign('/sign-in');
          return;
        }
        setPhase({ kind: 'error', message: e instanceof ApiError ? e.message : 'Something went wrong.', canSignOut: e instanceof ApiError && e.status === 403 });
      });
  }, []);

  async function act(kind: 'accept' | 'decline') {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const r = await bff<{ studentId?: string }>('POST', `parent/invitations/${kind}`, { token });
      rememberShareToken(null);
      setPhase(kind === 'accept' ? { kind: 'accepted', studentId: r.studentId ?? '' } : { kind: 'declined' });
    } catch (e) {
      const message = e instanceof ApiError ? e.message : 'Something went wrong.';
      if (e instanceof ApiError && (e.status === 409 || e.status === 404)) setPhase({ kind: 'error', message });
      else setError(message);
    } finally {
      setBusy(false);
    }
  }

  if (phase.kind === 'loading') return <p className="muted" role="status">Loading…</p>;
  if (phase.kind === 'error') {
    return (
      <section className="card" aria-labelledby="e">
        <h1 id="e">We can't open this invitation</h1>
        <p role="alert">{phase.message}</p>
        {phase.canSignOut && (
          <form action="/sign-out" method="post">
            <button className="btn secondary" type="submit">Sign out and use another email</button>
          </form>
        )}
      </section>
    );
  }
  if (phase.kind === 'accepted') {
    return (
      <section className="card" aria-labelledby="a">
        <h1 id="a">Accepted</h1>
        <p>You can now see their progress summary. They can stop sharing at any time.</p>
        <Link className="btn" href={`/parent?child=${phase.studentId}`}>See the summary</Link>
      </section>
    );
  }
  if (phase.kind === 'declined') {
    return (
      <section className="card" aria-labelledby="d">
        <h1 id="d">Invitation declined</h1>
        <p>Nothing is shared with you. You can close this page.</p>
      </section>
    );
  }
  return (
    <>
      <h1>See a student's progress summary</h1>
      <section className="card">
        <p style={{ marginTop: 0 }}>A student has invited you to see a summary of their progress:</p>
        <ul>
          <li>how many tests and practice sets they did each week;</li>
          <li>their progress labels by subject and chapter;</li>
          <li>what they have shown they are strong in, what is worth more practice, and what has improved.</li>
        </ul>
        <p className="muted" style={{ marginBottom: 0 }}>
          You will not see their answers, scores, points or anything about other students. They can stop sharing at any time.
          This link works until {new Date(phase.expiresAt).toLocaleDateString()}.
        </p>
      </section>
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      <button className="btn" type="button" disabled={busy} onClick={() => void act('accept')}>{busy ? 'Saving…' : 'Accept'}</button>
      <div className="spacer" />
      <button className="btn secondary" type="button" disabled={busy} onClick={() => void act('decline')}>Decline</button>
    </>
  );
}
