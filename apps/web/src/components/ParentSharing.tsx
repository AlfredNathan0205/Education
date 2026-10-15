'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, type SharingStatus } from '@/lib/client-api';

/**
 * On Progress (Step 17): who can see this student's progress summary, and "See what they see".
 * - A minor's approving guardian sees it through their approval (the student is told; they cannot switch it off).
 * - An adult student may invite a parent, after reading what is shared and agreeing; they can stop at any time.
 */
export function ParentSharing() {
  const [s, setS] = useState<SharingStatus | null>(null);
  const [email, setEmail] = useState('');
  const [agreed, setAgreed] = useState(false);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(() => {
    bff<SharingStatus>('GET', 'parent-sharing')
      .then(setS)
      .catch(() => setS(null));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  if (!s) return null;
  const preview = (
    <Link href="/progress/parent-view">See what they see</Link>
  );

  if (s.isMinor) {
    return (
      <section className="card" aria-labelledby="share">
        <h2 id="share">Your parent or guardian</h2>
        <p style={{ marginBottom: 0 }}>
          {s.guardianViewers > 0
            ? 'The parent or guardian who approved your account can see a summary of your progress: what you practised each week and your progress labels. They do not see your answers or scores. '
            : 'Once a parent or guardian approves your account, they will be able to see a summary of your progress. '}
          {preview}
        </p>
      </section>
    );
  }

  return (
    <section className="card" aria-labelledby="share">
      <h2 id="share">Share with a parent</h2>
      <p className="muted">
        You can let a parent see a summary of your progress. They never see your answers or scores, and you can stop at any time.{' '}
        {preview}
      </p>
      <div role="alert" aria-live="polite">
        {error && <p className="error">{error}</p>}
        {notice && <p className="hint">{notice}</p>}
      </div>
      {s.viewers.length > 0 && (
        <ul className="plain">
          {s.viewers.map((v) => (
            <li key={v.grantId} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap' }}>
              <span>
                {v.maskedEmail} <span className="hint">· since {new Date(v.since).toLocaleDateString()}</span>
              </span>
              <button
                className="btn secondary small"
                type="button"
                disabled={busy}
                onClick={() => {
                  if (window.confirm(`Stop sharing with ${v.maskedEmail}? They will lose access straight away.`)) void act(() => bff('POST', `parent-sharing/viewers/${v.grantId}/stop`), 'Stopped. They can no longer see your summary.');
                }}
              >
                Stop sharing
              </button>
            </li>
          ))}
        </ul>
      )}
      {s.pending && (
        <p>
          Invitation sent to {s.pending.maskedEmail}, waiting for them to accept.{' '}
          <button className="linklike" type="button" disabled={busy} onClick={() => void act(() => bff('POST', 'parent-sharing/invitations/cancel'), 'Invitation cancelled.')}>
            Cancel
          </button>
        </p>
      )}
      {!s.canShare && s.refusal && <p className="hint" style={{ marginBottom: 0 }}>{s.refusal}</p>}
      {s.canShare && !s.consent && <p className="hint" style={{ marginBottom: 0 }}>Sharing is not available yet.</p>}
      {s.canShare && s.consent && !open && (
        <button className="btn secondary" type="button" onClick={() => setOpen(true)}>Invite a parent</button>
      )}
      {s.canShare && s.consent && open && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void act(async () => {
              await bff('POST', 'parent-sharing/invitations', { email, consentVersion: s.consent!.version, agreed });
              setEmail('');
              setAgreed(false);
              setOpen(false);
            }, 'Invitation sent. They need to accept it from the email.');
          }}
        >
          <h3 style={{ fontSize: '1rem' }}>{s.consent.title}</h3>
          {s.consent.draft && <p className="error" role="note">Draft wording for testing. It has not been reviewed by a lawyer.</p>}
          {s.consent.paragraphs.map((p, i) => (
            <p key={i} className="muted">{p}</p>
          ))}
          <div className="field">
            <label htmlFor="share-email">Their email address</label>
            <input id="share-email" type="email" autoComplete="off" value={email} onChange={(e) => setEmail(e.target.value)} required />
          </div>
          <div className="field">
            <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', fontWeight: 400 }}>
              <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} style={{ width: 22, height: 22, marginTop: 2, accentColor: 'var(--accent)', flex: 'none' }} />
              <span>I have read this and I agree to share my progress summary with this person.</span>
            </label>
          </div>
          <button className="btn" type="submit" disabled={busy || !agreed || !email}>{busy ? 'Sending…' : 'Send invitation'}</button>
          <div className="spacer" />
          <button className="btn secondary" type="button" disabled={busy} onClick={() => { setOpen(false); setAgreed(false); }}>Not now</button>
        </form>
      )}
    </section>
  );
}
