'use client';

import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff } from '@/lib/client-api';

interface Pending {
  approvalId: string;
  studentName: string | null;
  otherHandle: string;
  requestedAt: string;
}

/**
 * Step 16: friendships of your child waiting for your approval. Shown only when friends are switched on (the API
 * answers 404 otherwise). You see the other student's handle only, never their name.
 */
export function GuardianFriendships() {
  const [items, setItems] = useState<Pending[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(() => {
    bff<Pending[]>('GET', 'guardian/friendships')
      .then(setItems)
      .catch(() => setItems(null));
  }, []);
  useEffect(load, [load]);

  async function decide(id: string, approve: boolean) {
    setBusy(id);
    setError(null);
    try {
      await bff('POST', `guardian/friendships/${id}/${approve ? 'approve' : 'decline'}`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(null);
    }
  }

  if (!items) return null;
  return (
    <section className="card" aria-labelledby="gf">
      <h2 id="gf">Friend requests to approve</h2>
      <p className="muted">
        Your child added a friend with a code shown in person. Friends see only each other’s handle and can challenge each other to
        the same 10 questions. There is no chat.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {items.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>Nothing is waiting for you.</p>
      ) : (
        <ul className="plain">
          {items.map((p) => (
            <li key={p.approvalId} className="friend">
              <p style={{ margin: '0 0 6px' }}>
                <strong>{p.studentName ?? 'Your child'}</strong> wants to be friends with <strong>{p.otherHandle}</strong>
              </p>
              <div className="actions">
                <button className="btn" disabled={busy === p.approvalId} onClick={() => void decide(p.approvalId, true)}>Approve</button>
                <button className="btn secondary" disabled={busy === p.approvalId} onClick={() => void decide(p.approvalId, false)}>Decline</button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
