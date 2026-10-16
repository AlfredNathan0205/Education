'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, downloadJson, type PendingErasure, type RightsOverview } from '@/lib/client-api';

const when = (iso: string) => new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' });

/**
 * Step 20: a copy of your data, and deleting your account (after a 14-day wait you can cancel). A guardian does the
 * same for each child they approve.
 */
export function YourData() {
  const [v, setV] = useState<RightsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const load = useCallback(() => {
    bff<RightsOverview>('GET', 'privacy/rights')
      .then(setV)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      });
  }, []);
  useEffect(load, [load]);

  async function run(key: string, fn: () => Promise<unknown>, done?: string) {
    setBusy(key);
    setError(null);
    setNote(null);
    try {
      await fn();
      if (done) setNote(done);
      setConfirming(null);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  if (!v) return error ? <div className="card"><p className="error" role="alert">{error}</p></div> : <p className="muted" role="status">Loading…</p>;

  const alerts = (
    <div role="alert" aria-live="polite">
      {error && <p className="error">{error}</p>}
      {note && <p className="muted">{note}</p>}
    </div>
  );

  return (
    <>
      <h1>Your data</h1>
      {alerts}
      <section className="card" aria-labelledby="copy">
        <h2 id="copy">Download a copy</h2>
        <p className="muted">A file with everything Exam App holds about {v.me.subjectType === 'STUDENT' ? 'you: your account, tests, answers, progress and choices' : 'your account'}.</p>
        <button className="btn secondary" type="button" disabled={busy !== null} onClick={() => void run('copy', () => downloadJson('privacy/export', 'exam-app-data.json'), 'Your copy has been downloaded.')}>
          {busy === 'copy' ? 'Preparing…' : 'Download my data'}
        </button>
      </section>

      <section className="card" aria-labelledby="delete">
        <h2 id="delete">Delete your account</h2>
        <Deletion
          id="me"
          pending={v.me.erasure}
          blockMessage={v.me.blockMessage}
          waitDays={v.waitDays}
          who="your account"
          what={v.me.subjectType === 'STUDENT' ? 'Your sign-in, name, date of birth, school and public name are deleted. Your test results stay only as anonymous records that no longer lead to you.' : 'Your sign-in and your access to anyone\'s progress are deleted.'}
          busy={busy}
          confirming={confirming === 'me'}
          onConfirm={() => setConfirming('me')}
          onCancelConfirm={() => setConfirming(null)}
          onDelete={() => void run('me', () => bff('POST', 'privacy/erasure', {}), `Your account will be deleted in ${v.waitDays} days. You can cancel until then.`)}
          onUndo={(id) => void run(`undo-${id}`, () => bff('POST', `privacy/erasure/${id}/cancel`, {}), 'Deletion cancelled.')}
        />
      </section>

      {v.children.map((c) => (
        <section className="card" key={c.studentId} aria-labelledby={`child-${c.studentId}`}>
          <h2 id={`child-${c.studentId}`}>{c.label}</h2>
          <p className="muted">You approve this student, so you can download their data or delete their account.</p>
          <button className="btn secondary" type="button" disabled={busy !== null} onClick={() => void run(`copy-${c.studentId}`, () => downloadJson(`privacy/export/${c.studentId}`, 'exam-app-data.json'), `${c.label}'s copy has been downloaded.`)}>
            {busy === `copy-${c.studentId}` ? 'Preparing…' : `Download ${c.label}'s data`}
          </button>
          <div className="spacer" />
          <Deletion
            id={c.studentId}
            pending={c.erasure}
            blockMessage={null}
            waitDays={v.waitDays}
            who={`${c.label}'s account`}
            what="Their sign-in, name, date of birth, school and public name are deleted. Their test results stay only as anonymous records that no longer lead to them."
            busy={busy}
            confirming={confirming === c.studentId}
            onConfirm={() => setConfirming(c.studentId)}
            onCancelConfirm={() => setConfirming(null)}
            onDelete={() => void run(c.studentId, () => bff('POST', 'privacy/erasure', { studentId: c.studentId }), `${c.label}'s account will be deleted in ${v.waitDays} days. You can cancel until then.`)}
            onUndo={(id) => void run(`undo-${id}`, () => bff('POST', `privacy/erasure/${id}/cancel`, {}), 'Deletion cancelled.')}
          />
        </section>
      ))}
      <p className="hint"><Link href="/home">Back</Link></p>
    </>
  );
}

function Deletion(p: {
  id: string;
  pending: PendingErasure | null;
  blockMessage: string | null;
  waitDays: number;
  who: string;
  what: string;
  busy: string | null;
  confirming: boolean;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onDelete: () => void;
  onUndo: (requestId: string) => void;
}) {
  if (p.pending) {
    return (
      <>
        <p className="error" role="status">{p.who[0].toUpperCase() + p.who.slice(1)} will be deleted on {when(p.pending.dueAt)}.</p>
        {p.pending.canCancel ? (
          <button className="btn secondary" type="button" disabled={p.busy !== null} onClick={() => p.onUndo(p.pending!.requestId)}>Cancel deletion</button>
        ) : (
          <p className="hint">Deletion has started.</p>
        )}
      </>
    );
  }
  if (p.blockMessage) return <p className="muted" style={{ marginBottom: 0 }}>{p.blockMessage}</p>;
  if (!p.confirming) {
    return (
      <>
        <p className="muted">{p.what}</p>
        <button className="btn secondary" type="button" disabled={p.busy !== null} onClick={p.onConfirm}>Delete {p.who}</button>
      </>
    );
  }
  return (
    <>
      <p>Delete {p.who}? It happens in {p.waitDays} days, and you can cancel until then. After that it cannot be undone.</p>
      <button className="btn" type="button" disabled={p.busy !== null} onClick={p.onDelete}>{p.busy === p.id ? 'Asking…' : `Yes, delete in ${p.waitDays} days`}</button>
      <div className="spacer" />
      <button className="btn secondary" type="button" disabled={p.busy !== null} onClick={p.onCancelConfirm}>Keep it</button>
    </>
  );
}
