'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  RELEASE_TIERS,
  TIER_LABEL,
  bff,
  type ReadinessPolicyView,
  type ReadinessReport,
  type ReadinessUnitRow,
  type ReleaseAccessRow,
  type ReleaseHistoryRow,
  type ReleaseTier,
} from '@/lib/client-api';

const WHEN = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const STATE_LABEL: Record<string, string> = { NOT_READY: 'Not ready', LIMITED: 'Limited', ASSESSMENT_READY: 'Assessment-ready', ROBUST: 'Robust' };
const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');

/**
 * Step 21: content readiness. For each subject: check it against the readiness policy (using exactly what students
 * would be served), see what is missing, and release it one tier at a time with a sign-off note. Students only see a
 * subject released to them; everything else is "Coming soon".
 */
export function AdminReadiness() {
  const [policy, setPolicy] = useState<ReadinessPolicyView | null>(null);
  const [units, setUnits] = useState<ReadinessUnitRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    Promise.all([bff<ReadinessPolicyView>('GET', 'admin/readiness/policy'), bff<ReadinessUnitRow[]>('GET', 'admin/readiness/units')])
      .then(([p, u]) => {
        setPolicy(p);
        setUnits(u);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(msg(e));
      });
  }, []);
  useEffect(load, [load]);

  if (error && !units) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!units || !policy) return <p className="muted" role="status">Loading…</p>;

  return (
    <>
      <h1>Content readiness</h1>
      <p className="muted" role="note">
        Policy {policy.code}:{' '}
        {policy.signedOff
          ? `signed off by ${policy.signedOff.by} (${policy.signedOff.reference}) on ${new Date(policy.signedOff.at).toLocaleDateString()}.`
          : 'PROVISIONAL, not yet signed off by an academic lead. Subjects can be released for internal testing only.'}
      </p>
      {units.length === 0 && <p className="muted">There are no subjects yet.</p>}
      {units.map((u) => (
        <section className="card" key={u.subjectVersionId} aria-labelledby={`u-${u.subjectVersionId}`}>
          <h2 id={`u-${u.subjectVersionId}`}>
            {u.subjectName} · {u.curriculumCode} {u.gradeCode.replace('_', ' ')}
          </h2>
          <p className="muted">
            Curriculum {u.versionLabel}, revision {u.revision}, {u.curriculumState}. Students: <strong>{TIER_LABEL[u.tier]}</strong>.
          </p>
          {u.latestReport ? (
            <p className="muted">
              Last check {WHEN.format(new Date(u.latestReport.generatedAt))} ({u.latestReport.policy}):{' '}
              {u.latestReport.highest === 'FOUNDATION_ONLY' ? <strong>not ready for any release</strong> : <>ready for <strong>{TIER_LABEL[u.latestReport.highest]}</strong></>}
              {u.latestReport.current ? '' : ' (out of date: check again)'}.
            </p>
          ) : (
            <p className="muted">Not checked yet.</p>
          )}
          {u.belowTier && <p className="error" role="status">Released further than its latest check supports. Check again, or take it back.</p>}
          {open === u.subjectVersionId ? (
            <Unit unit={u} policySignedOff={!!policy.signedOff} onChanged={load} onClose={() => setOpen(null)} />
          ) : (
            <button className="btn secondary" type="button" onClick={() => setOpen(u.subjectVersionId)}>Open {u.subjectName}</button>
          )}
        </section>
      ))}
      <Access />
    </>
  );
}

function Unit({ unit, policySignedOff, onChanged, onClose }: { unit: ReadinessUnitRow; policySignedOff: boolean; onChanged: () => void; onClose: () => void }) {
  const [report, setReport] = useState<ReadinessReport | null>(null);
  const [history, setHistory] = useState<ReleaseHistoryRow[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const id = unit.subjectVersionId;

  useEffect(() => {
    bff<ReleaseHistoryRow[]>('GET', `admin/readiness/units/${id}/history`).then(setHistory).catch(() => setHistory([]));
    if (unit.latestReport?.current) bff<ReadinessReport>('GET', `admin/readiness/reports/${unit.latestReport.id}`).then(setReport).catch(() => undefined);
  }, [id, unit.latestReport]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await fn();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  const next = RELEASE_TIERS[RELEASE_TIERS.indexOf(unit.tier) + 1] as ReleaseTier | undefined;
  const lower = RELEASE_TIERS.slice(0, RELEASE_TIERS.indexOf(unit.tier));
  const nextPasses = !!next && !!report && next !== 'FOUNDATION_ONLY' && report.result.tiers[next as 'INTERNAL' | 'CONTROLLED' | 'GENERAL'].pass;
  const needsSignOff = next === 'CONTROLLED' || next === 'GENERAL';

  return (
    <div>
      <button className="btn" type="button" disabled={busy} onClick={() => void act(async () => setReport(await bff<ReadinessReport>('POST', `admin/readiness/units/${id}/report`, {})))}>
        {busy && !report ? 'Checking…' : 'Check readiness now'}
      </button>
      <div role="alert" aria-live="polite">
        {error && <p className="error">{error}</p>}
        {done && <p className="muted">{done}</p>}
      </div>
      {report && <ReportView report={report} />}

      <h3 style={{ fontSize: '1rem' }}>Release</h3>
      <div className="field">
        <label htmlFor={`note-${id}`}>Sign-off note (who checked what; at least 10 characters)</label>
        <textarea id={`note-${id}`} rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      {next && (
        <>
          <button
            className="btn"
            type="button"
            disabled={busy || !nextPasses || note.trim().length < 10 || (needsSignOff && !policySignedOff)}
            onClick={() =>
              void act(async () => {
                await bff('POST', `admin/readiness/units/${id}/release`, { to: next, reportId: report!.id, note });
                setDone(`Released to ${TIER_LABEL[next]}.`);
                setNote('');
                onChanged();
              })
            }
          >
            Release to {TIER_LABEL[next]}
          </button>
          <p className="hint">
            {!report
              ? 'Check readiness first.'
              : !nextPasses
                ? `Not ready for ${TIER_LABEL[next]} yet: see the failing checks above.`
                : needsSignOff && !policySignedOff
                  ? `${TIER_LABEL[next]} needs the readiness policy signed off by an academic lead.`
                  : 'Only approvers can release. Releases go one step at a time.'}
          </p>
        </>
      )}
      {lower.length > 0 && (
        <p>
          {lower.map((t) => (
            <button
              key={t}
              className="btn secondary"
              type="button"
              disabled={busy || note.trim().length < 10}
              style={{ marginRight: 8, marginBottom: 8 }}
              onClick={() =>
                void act(async () => {
                  await bff('POST', `admin/readiness/units/${id}/release`, { to: t, note });
                  setDone(`Moved back to ${TIER_LABEL[t]}.`);
                  setNote('');
                  onChanged();
                })
              }
            >
              Move back to {TIER_LABEL[t]}
            </button>
          ))}
        </p>
      )}
      {history.length > 0 && (
        <>
          <h3 style={{ fontSize: '1rem' }}>History</h3>
          <ul className="plain" aria-label="Release history">
            {history.map((h, i) => (
              <li key={i}>
                {WHEN.format(new Date(h.at))}: {TIER_LABEL[h.from]} → {TIER_LABEL[h.to]} by {h.approver ?? 'an approver'}: “{h.note}”
              </li>
            ))}
          </ul>
        </>
      )}
      <button className="btn secondary" type="button" onClick={onClose}>Close</button>
    </div>
  );
}

function ReportView({ report }: { report: ReadinessReport }) {
  const r = report.result;
  return (
    <div aria-label="Readiness report">
      <p>
        {r.highest === 'FOUNDATION_ONLY' ? <strong>Not ready for any release yet.</strong> : <>Ready for <strong>{TIER_LABEL[r.highest]}</strong>.</>} {r.totals.distinct} distinct questions students can be given ({r.totals.servable} served
        {r.totals.awaitingPublication ? `, ${r.totals.awaitingPublication} approved but not published` : ''}), {r.totals.objectives} objectives in {r.totals.chapters} chapters.
        Objectives: {Object.entries(r.objectiveStates).map(([k, v]) => `${v} ${STATE_LABEL[k].toLowerCase()}`).join(', ')}.
      </p>
      <p className="hint">{r.eqcNote}</p>
      {(['INTERNAL', 'CONTROLLED', 'GENERAL'] as const).map((t) => (
        <details key={t} open={!r.tiers[t].pass && (t === 'INTERNAL' || r.tiers.INTERNAL.pass)}>
          <summary>
            {TIER_LABEL[t]}: {r.tiers[t].pass ? 'passes' : `${r.tiers[t].checks.filter((c) => !c.ok).length} checks fail`}
          </summary>
          <ul className="plain">
            {r.tiers[t].checks.map((c) => (
              <li key={c.code}>
                {c.ok ? '✓' : '✗'} {c.message}
              </li>
            ))}
          </ul>
        </details>
      ))}
      <details>
        <summary>Chapters</summary>
        <div style={{ overflowX: 'auto' }}>
          <table className="metrics">
            <thead>
              <tr>
                <th scope="col">Chapter</th>
                <th scope="col">Questions</th>
                <th scope="col">Easy</th>
                <th scope="col">Medium</th>
                <th scope="col">Hard</th>
                <th scope="col">Levels</th>
                <th scope="col">Objectives not ready</th>
              </tr>
            </thead>
            <tbody>
              {r.chapters.map((c) => (
                <tr key={c.code}>
                  <th scope="row">{c.code} {c.title}</th>
                  <td>{c.servable}</td>
                  <td>{c.difficulty.EASY}</td>
                  <td>{c.difficulty.MEDIUM}</td>
                  <td>{c.difficulty.HARD}</td>
                  <td>{c.cognitive}</td>
                  <td>{c.notReady} of {c.objectives}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
      <details>
        <summary>Objectives with the fewest questions</summary>
        <ul className="plain">
          {r.objectives.slice(0, 25).map((o) => (
            <li key={o.path}>
              {o.path}: {o.eqc} ({STATE_LABEL[o.state]})
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

function Access() {
  const [rows, setRows] = useState<ReleaseAccessRow[] | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [email, setEmail] = useState('');
  const [tier, setTier] = useState<'INTERNAL' | 'CONTROLLED'>('INTERNAL');
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    bff<ReleaseAccessRow[]>('GET', 'admin/readiness/access')
      .then(setRows)
      .catch((e) => (e instanceof ApiError && e.status === 403 ? setForbidden(true) : setError(msg(e))));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      load();
    } catch (e) {
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  }

  if (forbidden) return null;
  return (
    <section className="card" aria-labelledby="access">
      <h2 id="access">Early access</h2>
      <p className="muted">Internal access sees subjects released for internal testing and the beta; controlled access sees the beta. The person must have signed in once.</p>
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            await bff('POST', 'admin/readiness/access', { email, tier, reason });
            setEmail('');
            setReason('');
          });
        }}
      >
        <div className="field">
          <label htmlFor="acc-email">Email they sign in with</label>
          <input id="acc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="acc-tier">Access</label>
          <select id="acc-tier" value={tier} onChange={(e) => setTier(e.target.value as 'INTERNAL' | 'CONTROLLED')}>
            <option value="INTERNAL">Internal (alpha)</option>
            <option value="CONTROLLED">Controlled (beta)</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="acc-reason">Reason</label>
          <input id="acc-reason" type="text" maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
        </div>
        <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
        <button className="btn" type="submit" disabled={busy || !email.includes('@') || reason.trim().length < 5}>Give access</button>
      </form>
      {rows && rows.length > 0 && (
        <ul className="plain" aria-label="People with early access" style={{ marginTop: 12 }}>
          {rows.map((r) => (
            <li key={r.id}>
              {r.email ?? r.accountId}: {TIER_LABEL[r.tier]} ({r.reason}){' '}
              <button className="btn secondary" type="button" disabled={busy} onClick={() => void act(async () => void (await bff('POST', `admin/readiness/access/${r.id}/revoke`, {})))}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
