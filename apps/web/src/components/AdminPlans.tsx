'use client';

import { useState } from 'react';
import { ApiError, bff, type EntitlementValues, type StaffPlanView } from '@/lib/client-api';

const KEY_TEXT: Record<keyof EntitlementValues, string> = {
  SELF_TESTS_PER_DAY: 'Self-chosen tests a day',
  LONG_TESTS: 'Long tests (20+ questions)',
  PARENT_REPORT_WEEKS: 'Weeks of parent reports',
};
const show = (v: unknown) => (v === null ? 'Unlimited' : v === true ? 'Yes' : v === false ? 'No' : String(v));

/**
 * Step 18: plans for administrators (SUPER_ADMIN; the API refuses anyone else and audits every action). Find a student
 * by their sign-in email, see what they have, grant or end a plan. There are no prices and no payments yet.
 */
export function AdminPlans() {
  const [email, setEmail] = useState('');
  const [view, setView] = useState<StaffPlanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [planCode, setPlanCode] = useState('PLUS');
  const [holder, setHolder] = useState('');
  const [endsAt, setEndsAt] = useState('');
  const [reason, setReason] = useState('');

  async function run(fn: () => Promise<unknown>, done?: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await fn();
      if (done) setNotice(done);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }
  const reload = async (id: string) => setView(await bff<StaffPlanView>('GET', `admin/entitlements/students/${id}`));

  return (
    <>
      <h1>Plans</h1>
      <p className="muted">Grant or end a plan for one student. No prices and no payments yet. Every action is recorded.</p>
      <form
        className="card"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            const { studentId } = await bff<{ studentId: string }>('POST', 'admin/entitlements/lookup', { email });
            await reload(studentId);
          });
        }}
      >
        <div className="field">
          <label htmlFor="lookup">Student's sign-in email</label>
          <input id="lookup" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <button className="btn" type="submit" disabled={busy}>Find</button>
      </form>
      <div role="alert" aria-live="polite">
        {error && <p className="error">{error}</p>}
        {notice && <p className="hint">{notice}</p>}
      </div>
      {view && (
        <>
          <section className="card" aria-labelledby="eff">
            <h2 id="eff">{view.label}</h2>
            <ul className="plain">
              {(Object.keys(KEY_TEXT) as Array<keyof EntitlementValues>).map((k) => (
                <li key={k}>{KEY_TEXT[k]}: <strong>{show(view.effective[k])}</strong></li>
              ))}
            </ul>
          </section>
          <section className="card" aria-labelledby="subs">
            <h2 id="subs">Plans</h2>
            {view.subscriptions.length === 0 && <p className="muted">Only the free plan.</p>}
            <ul className="plain">
              {view.subscriptions.map((s) => (
                <li key={s.id}>
                  <strong>{s.planCode}</strong> · {s.source} · {s.status}
                  {s.endsAt ? ` · until ${new Date(s.endsAt).toLocaleDateString()}` : ''}
                  {s.holder ? ` · held by ${s.holder}` : ''}
                  {s.status === 'ACTIVE' && s.source !== 'BETA' && (
                    <>
                      {' '}
                      <button
                        className="linklike"
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          const r = window.prompt('Why is this plan ending? (5 to 300 characters)');
                          if (r) void run(async () => { await bff('POST', `admin/entitlements/subscriptions/${s.id}/end`, { reason: r }); await reload(view.studentId); }, 'Plan ended.');
                        }}
                      >
                        End
                      </button>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </section>
          <form
            className="card"
            aria-labelledby="grant"
            onSubmit={(e) => {
              e.preventDefault();
              void run(async () => {
                await bff('POST', `admin/entitlements/students/${view.studentId}/subscriptions`, { planCode, holderEmail: holder || undefined, endsAt: endsAt ? new Date(`${endsAt}T23:59:59`).toISOString() : undefined, reason });
                setReason('');
                await reload(view.studentId);
              }, 'Plan granted.');
            }}
          >
            <h2 id="grant">Grant a plan</h2>
            <div className="field">
              <label htmlFor="plan">Plan</label>
              <select id="plan" value={planCode} onChange={(e) => setPlanCode(e.target.value)}>
                {view.plans.filter((p) => !p.isDefault && p.code !== 'BETA').map((p) => (
                  <option key={p.code} value={p.code}>{p.name}</option>
                ))}
              </select>
            </div>
            <div className="field">
              <label htmlFor="holder">Held by (optional email: the adult student, their approving guardian, or a parent they share with)</label>
              <input id="holder" type="email" value={holder} onChange={(e) => setHolder(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="ends">Ends (optional)</label>
              <input id="ends" type="date" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="reason">Reason</label>
              <input id="reason" value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} />
            </div>
            <button className="btn" type="submit" disabled={busy}>Grant</button>
          </form>
        </>
      )}
    </>
  );
}
