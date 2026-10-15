'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, REPORT_REASON_TEXT, bff, type ReportReason, type SocialChallenge, type SocialFriend, type SocialView } from '@/lib/client-api';

const TIME = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });
const REASONS = Object.keys(REPORT_REASON_TEXT) as ReportReason[];

/**
 * Friends and ranked challenges (Step 16), shown on Compete only when switched on. A friend is added only with a
 * one-time code shown in person; with a minor, a parent or guardian approves first. No free text anywhere: handles are
 * generated and reports are a choice from a list. The other player's progress is hidden until both have finished.
 */
export function Social() {
  const [view, setView] = useState<SocialView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [entered, setEntered] = useState('');

  const load = useCallback(async () => {
    try {
      setView(await bff<SocialView>('GET', 'social'));
    } catch {
      setView({ enabled: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  async function act(fn: () => Promise<unknown>, then?: (r: any) => void) {
    setBusy(true);
    setError(null);
    try {
      const r = await fn();
      if (then) then(r);
      else await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }
  const goTo = (r: { assessmentId?: string | null }) => (r?.assessmentId ? window.location.assign(`/tests/${r.assessmentId}`) : void load());

  if (!view || !view.enabled) return null;
  if (view.restricted) {
    return (
      <section className="card" aria-labelledby="friends">
        <h2 id="friends">Friends and challenges</h2>
        <p className="muted" style={{ marginBottom: 0 }}>Friends and challenges are not available on your account.</p>
      </section>
    );
  }
  const subjects = view.subjects ?? [];
  return (
    <>
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      <section className="card" aria-labelledby="friends">
        <h2 id="friends">Friends</h2>
        <p className="muted">
          Add a friend you know in person: one of you shows a code, the other types it in. Friends see only each other’s handle.
          For younger students, a parent or guardian approves each new friend first.
        </p>
        {view.code ? (
          <p>
            Your code: <strong className="code" aria-label={`Your code ${view.code.code.split('').join(' ')}`}>{view.code.code}</strong>{' '}
            <span className="muted">· works once, until {TIME.format(new Date(view.code.expiresAt))}</span>
          </p>
        ) : (
          <button className="btn secondary" disabled={busy} onClick={() => act(() => bff('POST', 'social/code'))}>Show my code</button>
        )}
        <form
          className="actions"
          style={{ marginTop: 12 }}
          onSubmit={(e) => {
            e.preventDefault();
            void act(() => bff('POST', 'social/friends', { code: entered }), () => {
              setEntered('');
              void load();
            });
          }}
        >
          <label htmlFor="friend-code" className="sr-only">Friend’s code</label>
          <input id="friend-code" type="text" value={entered} onChange={(e) => setEntered(e.target.value)} placeholder="Friend’s code" autoComplete="off" maxLength={9} />
          <button className="btn" disabled={busy || entered.trim().length < 6}>Add friend</button>
        </form>
        {(view.friends ?? []).length > 0 && (
          <ul className="plain" style={{ marginTop: 14 }}>
            {view.friends!.map((f) => (
              <Friend key={f.friendshipId} f={f} subjects={subjects} busy={busy} act={act} />
            ))}
          </ul>
        )}
      </section>

      {(view.challenges ?? []).length > 0 && (
        <section className="card" aria-labelledby="challenges">
          <h2 id="challenges">Challenges</h2>
          <p className="muted">You both get the same 10 questions, new to both of you. You see how they did only when you have both finished.</p>
          <ul className="plain">
            {view.challenges!.map((c) => (
              <Challenge key={c.id} c={c} busy={busy} act={act} goTo={goTo} />
            ))}
          </ul>
        </section>
      )}
    </>
  );
}

function Friend({ f, subjects, busy, act }: { f: SocialFriend; subjects: Array<{ subjectVersionId: string; subjectName: string }>; busy: boolean; act: (fn: () => Promise<unknown>) => void }) {
  const [subject, setSubject] = useState(subjects[0]?.subjectVersionId ?? '');
  const [reason, setReason] = useState<ReportReason | ''>('');
  return (
    <li className="friend" aria-label={`Friend ${f.handle}`}>
      <p style={{ margin: '0 0 6px' }}>
        <strong>{f.handle}</strong>{' '}
        <span className="muted">
          {f.status === 'ACTIVE'
            ? '· friends'
            : f.waitingFor.includes('YOUR_GUARDIAN')
              ? '· waiting for your parent or guardian to approve'
              : '· waiting for their parent or guardian to approve'}
        </span>
      </p>
      <div className="actions">
        {f.status === 'ACTIVE' && subjects.length > 0 && (
          <>
            {subjects.length > 1 && (
              <select aria-label="Subject" value={subject} onChange={(e) => setSubject(e.target.value)}>
                {subjects.map((s) => (
                  <option key={s.subjectVersionId} value={s.subjectVersionId}>{s.subjectName}</option>
                ))}
              </select>
            )}
            <button className="btn" disabled={busy} onClick={() => act(() => bff('POST', 'social/challenges', { friendshipId: f.friendshipId, subjectVersionId: subject }))}>
              Challenge{subjects.length === 1 ? ` in ${subjects[0].subjectName}` : ''}
            </button>
          </>
        )}
      </div>
      <div className="actions quiet" style={{ marginTop: 6 }}>
        <button className="btn secondary small" disabled={busy} onClick={() => act(() => bff('POST', `social/friends/${f.friendshipId}/unfriend`))}>Remove</button>
        <button className="btn secondary small" disabled={busy} onClick={() => act(() => bff('POST', `social/friends/${f.friendshipId}/block`))}>Block</button>
        <select aria-label={`Report ${f.handle}`} value={reason} onChange={(e) => setReason(e.target.value as ReportReason)}>
          <option value="">Report…</option>
          {REASONS.map((r) => (
            <option key={r} value={r}>{REPORT_REASON_TEXT[r]}</option>
          ))}
        </select>
        {reason && (
          <button className="btn secondary small" disabled={busy} onClick={() => act(() => bff('POST', `social/friends/${f.friendshipId}/report`, { reason }))}>
            Send report
          </button>
        )}
      </div>
    </li>
  );
}

function Challenge({ c, busy, act, goTo }: { c: SocialChallenge; busy: boolean; act: (fn: () => Promise<unknown>, then?: (r: any) => void) => void; goTo: (r: any) => void }) {
  const open = c.status === 'PENDING' || c.status === 'ACTIVE';
  const line = (() => {
    if (c.status === 'COMPLETED' && c.result) {
      const o = c.result.outcome === 'WIN' ? 'You won' : c.result.outcome === 'LOSS' ? 'They won' : 'A draw';
      return `You ${c.result.mine.correct}/${c.result.mine.total} · ${c.opponentHandle} ${c.result.theirs.correct}/${c.result.theirs.total} · ${o}`;
    }
    if (c.status === 'PENDING' && c.role === 'OPPONENT') return `${c.opponentHandle} challenged you`;
    if (c.status === 'PENDING') return `Waiting for ${c.opponentHandle} to accept`;
    if (c.status === 'ACTIVE' && c.myState === 'FINISHED') return `You have finished. Waiting for ${c.opponentHandle}.`;
    if (c.status === 'ACTIVE') return `Against ${c.opponentHandle}`;
    return { DECLINED: 'Declined', EXPIRED: 'Expired', CANCELLED: 'Cancelled', COMPLETED: 'Finished' }[c.status as 'DECLINED'] ?? '';
  })();
  return (
    <li className="friend" aria-label={`Challenge in ${c.subjectName} with ${c.opponentHandle}`}>
      <p style={{ margin: '0 0 6px' }}>
        <strong>{c.subjectName}</strong> <span className="muted">· {line}</span>
      </p>
      {open && (
        <div className="actions">
          {c.status === 'PENDING' && c.role === 'OPPONENT' ? (
            <>
              <button className="btn" disabled={busy} onClick={() => act(() => bff('POST', `social/challenges/${c.id}/accept`), goTo)}>Accept and start</button>
              <button className="btn secondary" disabled={busy} onClick={() => act(() => bff('POST', `social/challenges/${c.id}/decline`))}>Decline</button>
            </>
          ) : c.myState !== 'FINISHED' ? (
            <button className="btn" disabled={busy} onClick={() => act(() => bff('POST', `social/challenges/${c.id}/start`), goTo)}>
              {c.myState === 'IN_PROGRESS' ? 'Continue' : 'Start'}
            </button>
          ) : null}
        </div>
      )}
    </li>
  );
}
