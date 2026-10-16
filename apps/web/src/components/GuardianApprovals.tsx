'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, type GuardianApproval } from '@/lib/client-api';
import { GuardianAnalytics } from './GuardianAnalytics';
import { GuardianFriendships } from './GuardianFriendships';

export function GuardianApprovals() {
  const [items, setItems] = useState<GuardianApproval[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    bff<GuardianApproval[]>('GET', 'guardian/approvals')
      .then(setItems)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Could not load your approvals.');
      });
  }, []);
  useEffect(load, [load]);

  async function withdraw(id: string) {
    if (!window.confirm('Withdraw this approval? The student will not be able to use the service until an adult approves again.')) return;
    setBusyId(id);
    setError(null);
    try {
      await bff('POST', `guardian/approvals/${id}/withdraw`);
      load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusyId(null);
    }
  }

  if (error && !items) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!items) return <p className="muted" role="status">Loading…</p>;

  return (
    <>
      <h1>Your approvals</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {items.length === 0 ? (
        <p className="muted">You have not approved any student accounts.</p>
      ) : (
        items.map((a) => (
          <section className="card" key={a.consentRecordId}>
            <h2>{a.label ?? a.displayName ?? 'Student'}</h2>
            <p><Link href={`/parent?child=${a.studentId}`}>See their progress summary</Link></p>
            <p className="muted">Approved on {new Date(a.grantedAt).toLocaleDateString()}</p>
            <button className="btn secondary" type="button" disabled={busyId === a.consentRecordId} onClick={() => void withdraw(a.consentRecordId)}>
              Withdraw approval
            </button>
          </section>
        ))
      )}
      <GuardianFriendships />
      {items.length > 0 && <GuardianAnalytics />}
      <p className="hint"><Link href="/privacy">Your data: download a copy or delete an account</Link></p>
      <form action="/sign-out" method="post"><button className="btn secondary" type="submit">Sign out</button></form>
    </>
  );
}
