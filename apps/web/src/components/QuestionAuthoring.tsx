'use client';

import { useEffect, useState, type FormEvent } from 'react';
import {
  ApiError,
  bff,
  type FactoryBatchRow,
  type FactoryBatchSummary,
  type FactoryStatus,
  type FactorySuggestion,
  type ObjectiveOption,
  type QuestionUploadResult,
} from '@/lib/client-api';

const msg = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong.');
const LETTERS = ['A', 'B', 'C', 'D'] as const;
const COGNITIVE: Array<[string, string]> = [['', 'Not set'], ['C1', 'C1 Remember'], ['C2', 'C2 Understand'], ['C3', 'C3 Apply'], ['C4', 'C4 Analyse']];
const PAGE_MAX = 10;

/**
 * Step 22: write one question in a form. It goes through exactly the same checks and save as a file upload (the
 * API builds a one-question upload), and is saved as a draft: an editor submits it, and a different person approves it.
 */
export function QuestionForm({ unitId, onSaved }: { unitId: string; onSaved: (revisionId: string | null) => void }) {
  const empty = { code: '', objectiveCode: '', stem: '', options: ['', '', '', ''], correct: 'A', difficulty: 'MEDIUM', cognitive: '', explanation: '' };
  const [objectives, setObjectives] = useState<ObjectiveOption[] | null>(null);
  const [f, setF] = useState(empty);
  const [result, setResult] = useState<QuestionUploadResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setObjectives(null);
    bff<ObjectiveOption[]>('GET', `admin/questions/units/${unitId}/objectives`).then(setObjectives).catch((e) => setError(msg(e)));
  }, [unitId]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await bff<QuestionUploadResult & { revisionId: string | null }>('POST', `admin/questions/units/${unitId}/question`, f);
      setResult(r);
      if (r.written) {
        setF(empty);
        onSaved(r.revisionId);
      }
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  const ambiguous = objectives?.find((o) => o.code === f.objectiveCode)?.ambiguous;
  return (
    <form onSubmit={save} aria-label="Write a question">
      <h2>Write a question</h2>
      <p className="muted">Saved as a draft. The same code again changes that question (or makes a new version of an approved one).</p>
      {objectives && objectives.length === 0 && <p className="error">This subject has no learning objectives yet. Upload its curriculum first.</p>}
      <div className="field">
        <label htmlFor="q-code">Question code</label>
        <input id="q-code" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="For example PHY8-Q101" required maxLength={64} />
      </div>
      <div className="field">
        <label htmlFor="q-obj">Learning objective</label>
        <select id="q-obj" value={f.objectiveCode} onChange={(e) => setF({ ...f, objectiveCode: e.target.value })} required>
          <option value="">Choose…</option>
          {(objectives ?? []).map((o) => (
            <option key={o.path} value={o.code}>{o.chapter} · {o.code}: {o.statement.slice(0, 90)}</option>
          ))}
        </select>
        {ambiguous && <p className="error">This objective code is used in more than one chapter, so a question cannot be tied to it until the curriculum gives each objective its own code.</p>}
      </div>
      <div className="field">
        <label htmlFor="q-stem">Question</label>
        <textarea id="q-stem" rows={3} value={f.stem} onChange={(e) => setF({ ...f, stem: e.target.value })} required maxLength={2000} />
      </div>
      {LETTERS.map((l, i) => (
        <div className="field" key={l}>
          <label htmlFor={`q-opt-${l}`}>Option {l}</label>
          <input id={`q-opt-${l}`} value={f.options[i]} onChange={(e) => setF({ ...f, options: f.options.map((o, j) => (j === i ? e.target.value : o)) })} required maxLength={500} />
        </div>
      ))}
      <div className="field">
        <label htmlFor="q-correct">Correct option</label>
        <select id="q-correct" value={f.correct} onChange={(e) => setF({ ...f, correct: e.target.value })}>
          {LETTERS.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="q-diff">Difficulty</label>
        <select id="q-diff" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}>
          <option value="EASY">Easy</option><option value="MEDIUM">Medium</option><option value="HARD">Hard</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="q-cog">Cognitive level</label>
        <select id="q-cog" value={f.cognitive} onChange={(e) => setF({ ...f, cognitive: e.target.value })}>
          {COGNITIVE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="q-expl">Explanation shown after the test (optional)</label>
        <textarea id="q-expl" rows={2} value={f.explanation} onChange={(e) => setF({ ...f, explanation: e.target.value })} maxLength={2000} />
      </div>
      <div role="alert" aria-live="polite">
        {error && <p className="error">{error}</p>}
        {result && !result.written && (
          <ul>{result.issues.map((i, n) => <li key={n} className="error"><strong>{i.where}:</strong> {i.message}</li>)}</ul>
        )}
      </div>
      {result?.written && <p role="status">Saved as a draft{result.counts.NEW_REVISION ? ' (a new version of an approved question)' : result.counts.UPDATE ? ' (changed)' : ''}. It is open below: submit it for review.</p>}
      <button className="btn" type="submit" disabled={busy || ambiguous === true}>{busy ? 'Saving…' : 'Save as draft'}</button>
    </form>
  );
}

/**
 * Step 22: AI drafting from the page. Each draft is an AI draft question in Draft, never approved by the AI: a person
 * submits it and a different person approves it. Small batches only; larger runs stay with the factory CLI.
 */
export function AiDrafting({ unitId, onDrafted }: { unitId: string; onDrafted: () => void }) {
  const [status, setStatus] = useState<FactoryStatus | null>(null);
  const [cells, setCells] = useState<FactorySuggestion[] | null>(null);
  const [batches, setBatches] = useState<FactoryBatchRow[]>([]);
  const [f, setF] = useState({ objectiveCode: '', difficulty: 'HARD', cognitive: 'C3', count: 5 });
  const [result, setResult] = useState<FactoryBatchSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setError(null);
    bff<FactoryStatus>('GET', 'admin/factory/status').then(setStatus).catch((e) => setError(msg(e)));
    bff<{ target: number; cells: FactorySuggestion[] }>('GET', `admin/factory/units/${unitId}/suggestions`).then((r) => setCells(r.cells)).catch(() => setCells([]));
    bff<FactoryBatchRow[]>('GET', 'admin/factory/batches').then(setBatches).catch(() => setBatches([]));
  }, [unitId]);

  async function run(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await bff<FactoryBatchSummary>('POST', 'admin/factory/batches', { unitId, ...f });
      setResult(r);
      setBatches(await bff<FactoryBatchRow[]>('GET', 'admin/factory/batches'));
      setStatus(await bff<FactoryStatus>('GET', 'admin/factory/status'));
      onDrafted();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }

  async function stop(id: string) {
    try {
      await bff('POST', `admin/factory/batches/${id}/stop`, {});
      setBatches(await bff<FactoryBatchRow[]>('GET', 'admin/factory/batches'));
    } catch (err) {
      setError(msg(err));
    }
  }

  if (!status) return <section aria-label="AI drafting"><h2>AI drafting</h2>{error ? <p className="error">{error}</p> : <p className="muted">Loading…</p>}</section>;
  return (
    <section aria-label="AI drafting">
      <h2>AI drafting</h2>
      <p className="muted">
        The AI writes drafts for one objective and difficulty. Every draft needs a person to submit it and a different person to
        approve it, exactly like one written by hand. Up to {PAGE_MAX} at a time from here.
      </p>
      {status.available ? (
        <p className="muted">
          Provider {status.provider ?? 'unknown'}. Used today: {status.tokensUsedToday.toLocaleString()} of {status.dailyTokenBudget?.toLocaleString() ?? '?'} tokens.
        </p>
      ) : (
        <p role="note">Not available here: {status.reason}</p>
      )}
      {cells && cells.length > 0 && (
        <>
          <h3>Where questions are short</h3>
          <p className="muted">Objectives and difficulties furthest below 8 approved questions. Choose one to fill the form.</p>
          <ul aria-label="Short cells">
            {cells.slice(0, 12).map((c) => (
              <li key={`${c.objectivePath}-${c.difficulty}`}>
                <button className="btn secondary" type="button" onClick={() => setF({ ...f, objectiveCode: c.objectiveCode, difficulty: c.difficulty, count: Math.min(PAGE_MAX, c.requestable) })}>
                  {c.objectivePath} · {c.difficulty}
                </button>{' '}
                <span className="muted">{c.approved} approved, {c.inPipeline} in progress</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {status.available && (
        <form onSubmit={run} aria-label="Ask for drafts">
          <div className="field"><label htmlFor="ai-obj">Objective code</label><input id="ai-obj" value={f.objectiveCode} onChange={(e) => setF({ ...f, objectiveCode: e.target.value })} required /></div>
          <div className="field">
            <label htmlFor="ai-diff">Difficulty</label>
            <select id="ai-diff" value={f.difficulty} onChange={(e) => setF({ ...f, difficulty: e.target.value })}><option value="EASY">Easy</option><option value="MEDIUM">Medium</option><option value="HARD">Hard</option></select>
          </div>
          <div className="field">
            <label htmlFor="ai-cog">Cognitive level</label>
            <select id="ai-cog" value={f.cognitive} onChange={(e) => setF({ ...f, cognitive: e.target.value })}>{COGNITIVE.slice(1).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
          </div>
          <div className="field"><label htmlFor="ai-count">How many drafts</label><input id="ai-count" type="number" min={1} max={PAGE_MAX} value={f.count} onChange={(e) => setF({ ...f, count: Number(e.target.value) })} /></div>
          <button className="btn" type="submit" disabled={busy}>{busy ? 'Drafting… this can take a minute' : 'Draft questions'}</button>
        </form>
      )}
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      {result && (
        <p role="status">
          {result.status === 'STOPPED' ? `Stopped (${result.stopReason ?? 'stopped'}). ` : ''}
          {result.draftsStored} draft{result.draftsStored === 1 ? '' : 's'} saved; {result.rejected} rejected by the checks, {result.duplicates} duplicates, {result.failed} failed. The drafts are in the list below.
        </p>
      )}
      {batches.length > 0 && (
        <>
          <h3>Recent batches</h3>
          <ul aria-label="Recent batches">
            {batches.slice(0, 10).map((b) => (
              <li key={b.id}>
                {new Date(b.startedAt).toLocaleString()}: {b.objectivePath} {b.difficulty} {b.cognitive}, {b.stored} of {b.requested} saved ({b.status})
                {b.status === 'RUNNING' && <> <button className="btn secondary" type="button" onClick={() => stop(b.id)}>Stop</button></>}
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
