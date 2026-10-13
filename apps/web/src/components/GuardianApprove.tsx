'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, bff, recalledGuardianToken, rememberGuardianToken, type GuardianPreview } from '@/lib/client-api';

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; message: string; canSignOut?: boolean }
  | { kind: 'review'; preview: GuardianPreview }
  | { kind: 'approved' }
  | { kind: 'declined' };

const REL_LABEL: Record<string, string> = { MOTHER: 'mother', FATHER: 'father', LEGAL_GUARDIAN: 'legal guardian' };

/** Reads the one-time token from the link's #fragment (which never reaches a server log), then keeps it only in this tab. */
function readToken(): string | null {
  const m = /(?:^#|&)t=([A-Za-z0-9_-]{43})(?:&|$)/.exec(window.location.hash);
  if (m) {
    rememberGuardianToken(m[1]);
    window.history.replaceState(null, '', window.location.pathname);
    return m[1];
  }
  return recalledGuardianToken();
}

export function GuardianApprove() {
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [token, setToken] = useState<string | null>(null);
  const [attested, setAttested] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const t = readToken();
    if (!t) {
      setPhase({ kind: 'error', message: 'This link is incomplete. Open the link from the email again.' });
      return;
    }
    setToken(t);
    bff<GuardianPreview>('POST', 'guardian/invitations/preview', { token: t })
      .then((preview) => setPhase({ kind: 'review', preview }))
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
    if (!token || phase.kind !== 'review') return;
    setBusy(true);
    setError(null);
    try {
      await bff('POST', `guardian/invitations/${kind}`, kind === 'accept' ? { token, consentVersion: phase.preview.consent.version, attested: true } : { token });
      rememberGuardianToken(null);
      setPhase({ kind: kind === 'accept' ? 'approved' : 'declined' });
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
        <h1 id="e">We can't open this request</h1>
        <p role="alert">{phase.message}</p>
        {phase.canSignOut && (
          <form action="/sign-out" method="post">
            <button className="btn secondary" type="submit">Sign out and use another email</button>
          </form>
        )}
      </section>
    );
  }

  if (phase.kind === 'approved') {
    return (
      <section className="card" aria-labelledby="a">
        <h1 id="a">Approved</h1>
        <p>Thank you. The student can now continue. You can withdraw this approval at any time.</p>
        <Link className="btn" href="/guardian">See your approvals</Link>
      </section>
    );
  }

  if (phase.kind === 'declined') {
    return (
      <section className="card" aria-labelledby="d">
        <h1 id="d">Request declined</h1>
        <p>Nothing was approved and the student cannot use the service. You can close this page.</p>
      </section>
    );
  }

  const { preview } = phase;
  const relationship = REL_LABEL[preview.relationshipType] ?? 'parent or guardian';
  return (
    <>
      <h1>Approve a student's account</h1>
      <p className="muted">
        Someone has named you as their {relationship}. Please read this, then approve or decline.
      </p>
      <section className="card" aria-labelledby="c">
        <h2 id="c">{preview.consent.title}</h2>
        {preview.consent.draft && (
          <p className="error" role="note">Draft wording for testing. It has not been reviewed by a lawyer.</p>
        )}
        {preview.consent.paragraphs.map((p, i) => <p key={i}>{p}</p>)}
      </section>
      <div className="field">
        <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontWeight: 400 }}>
          <input type="checkbox" checked={attested} onChange={(e) => setAttested(e.target.checked)} style={{ width: 22, height: 22, marginTop: 2, accentColor: 'var(--accent)', flex: 'none' }} />
          <span>I am this student's {relationship}, I have read the above, and I approve.</span>
        </label>
      </div>
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      <button className="btn" type="button" disabled={busy || !attested} onClick={() => void act('accept')}>{busy ? 'Saving…' : 'Approve'}</button>
      <div className="spacer" />
      <button className="btn secondary" type="button" disabled={busy} onClick={() => void act('decline')}>Decline</button>
    </>
  );
}
