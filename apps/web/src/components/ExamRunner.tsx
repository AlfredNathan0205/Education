'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, bff, type ExamLockResult, type ExamResult, type ExamView } from '@/lib/client-api';
import { practiseMissed } from '@/lib/start-test';

function newKey(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

/**
 * One question at a time. The page never holds an answer key: in a Test nothing is revealed until the
 * result; in Practice the server reveals one question's answer after that question is locked.
 * No countdown and no running score are shown.
 */
export function ExamRunner({ assessmentId }: { assessmentId: string }) {
  const [view, setView] = useState<ExamView | null>(null);
  const [result, setResult] = useState<ExamResult | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<number | null>(null);
  const [reveal, setReveal] = useState<{ slot: number; data: NonNullable<ExamLockResult['reveal']> } | null>(null);
  const [busy, setBusy] = useState(false);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Active time: counts only while the tab is visible. Reported to the server as a hint, never trusted.
  const timer = useRef<{ since: number | null; total: number }>({ since: null, total: 0 });
  const lockKey = useRef<string | null>(null);
  const skipKey = useRef<string | null>(null);
  const resetTimer = () => {
    timer.current = { since: document.visibilityState === 'visible' ? Date.now() : null, total: 0 };
  };
  const readActive = () => timer.current.total + (timer.current.since ? Date.now() - timer.current.since : 0);
  useEffect(() => {
    const onVis = () => {
      const t = timer.current;
      if (document.visibilityState === 'hidden' && t.since) {
        t.total += Date.now() - t.since;
        t.since = null;
      } else if (document.visibilityState === 'visible' && !t.since) t.since = Date.now();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const fetchResult = useCallback(async () => {
    setResult(await bff<ExamResult>('GET', `exam/assessments/${assessmentId}/result`));
  }, [assessmentId]);

  const load = useCallback(async () => {
    try {
      const v = await bff<ExamView>('POST', `exam/assessments/${assessmentId}/present`);
      setView(v);
      setSelected(null);
      setReveal(null);
      lockKey.current = null;
      skipKey.current = null;
      resetTimer();
      if (v.phase === 'ENDED' && v.status === 'SUBMITTED') await fetchResult();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
      else setLoadError(e instanceof ApiError ? e.message : 'Could not load this test.');
    }
  }, [assessmentId, fetchResult]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    headingRef.current?.focus();
  }, [view?.question?.position, view?.question?.pass, view?.phase, result]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Something went wrong. Please try again.';
      setError(msg);
      // The server and the page disagree (for example after a retry): show what the server has.
      if (e instanceof ApiError && e.status === 409) await load();
    } finally {
      setBusy(false);
    }
  }

  const lock = () =>
    act(async () => {
      if (selected === null || !view?.question) return;
      lockKey.current ??= newKey();
      const r = await bff<ExamLockResult>('POST', `exam/assessments/${assessmentId}/questions/${view.question.position}/lock`, {
        slot: selected,
        activeMs: readActive(),
        idempotencyKey: lockKey.current,
      });
      lockKey.current = null;
      if (r.reveal) setReveal({ slot: selected, data: r.reveal });
      else await load();
    });

  const skip = () =>
    act(async () => {
      if (!view?.question) return;
      // The same key on a retry, so a skip that reached the server but whose reply was lost is not refused.
      skipKey.current ??= newKey();
      await bff('POST', `exam/assessments/${assessmentId}/questions/${view.question.position}/skip`, { activeMs: readActive(), idempotencyKey: skipKey.current });
      await load();
    });

  const reviewSkipped = () =>
    act(async () => {
      await bff('POST', `exam/assessments/${assessmentId}/review-skipped`);
      await load();
    });

  const submit = () =>
    act(async () => {
      await bff('POST', `exam/assessments/${assessmentId}/submit`);
      await load();
    });

  if (loadError) {
    return (
      <section className="card">
        <p className="error" role="alert">{loadError}</p>
        <Link className="btn secondary" href="/tests">Back to tests</Link>
      </section>
    );
  }
  if (!view) return <p className="muted" role="status">Loading…</p>;

  if (view.phase === 'ENDED') {
    if (view.status === 'VOID') {
      return (
        <section className="card">
          <h1 ref={headingRef} tabIndex={-1}>This test expired</h1>
          <p className="muted">No answer was locked within the time allowed, so there is no result. You can start a new one.</p>
          <Link className="btn" href="/home">Back to Home</Link>
        </section>
      );
    }
    if (view.status === 'INVALIDATED') {
      return (
        <section className="card">
          <h1 ref={headingRef} tabIndex={-1}>This test was cancelled</h1>
          <p className="muted">
            The questions in it had a problem and were removed, so it does not count. This is not because of anything you
            did. You can start a new one.
          </p>
          <Link className="btn" href="/home">Back to Home</Link>
        </section>
      );
    }
    if (!result) return <p className="muted" role="status">Loading your result…</p>;
    return <ResultView result={result} headingRef={headingRef} />;
  }

  if (view.phase === 'SUMMARY' && view.summary) {
    const s = view.summary;
    return (
      <section className="card" aria-labelledby="sum">
        <h1 id="sum" ref={headingRef} tabIndex={-1}>You have reached the end</h1>
        <p>
          You answered <strong>{s.answered}</strong> of {view.total - view.removed} questions.
          {s.unanswered > 0 && <> <strong>{s.unanswered}</strong> {s.unanswered === 1 ? 'is' : 'are'} unanswered and will score zero.</>}
        </p>
        <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
        {view.removed > 0 && (
          <p className="muted">
            {view.removed} question{view.removed === 1 ? ' was' : 's were'} removed because of a problem with {view.removed === 1 ? 'it' : 'them'}. {view.removed === 1 ? 'It does' : 'They do'} not count.
          </p>
        )}
        {s.canReviewSkipped && (
          <>
            <button className="btn" disabled={busy} onClick={reviewSkipped}>Review skipped questions</button>
            <div className="spacer" />
            <p className="hint">You can go back through skipped questions once. Answers you have locked cannot be changed.</p>
          </>
        )}
        <button className={s.canReviewSkipped ? 'btn secondary' : 'btn'} disabled={busy} onClick={submit}>
          {s.unanswered > 0 ? 'Submit anyway' : 'Submit'}
        </button>
      </section>
    );
  }

  const q = view.question;
  if (!q) return <p className="muted" role="status">Loading…</p>;
  const locked = reveal !== null;

  return (
    <section className="card" aria-labelledby="q">
      <p className="muted" style={{ marginBottom: 8 }}>
        {view.mode === 'TEST' ? 'Test' : 'Practice'} · Question {q.position} of {q.total}
        {q.pass === 'REVISIT' && ' · a question you skipped'}
      </p>
      <div className="bar" role="progressbar" aria-valuemin={0} aria-valuemax={q.total} aria-valuenow={q.position - 1} aria-label="Progress">
        <span style={{ width: `${((q.position - 1) / q.total) * 100}%` }} />
      </div>
      <fieldset className="choices" disabled={busy || locked}>
        <legend>
          <h1 id="q" ref={headingRef} tabIndex={-1} className="stem">{q.stem}</h1>
        </legend>
        {q.options.map((o) => {
          const isRight = reveal?.data.correctSlot === o.slot;
          const isChosen = reveal?.slot === o.slot;
          return (
            <label key={o.slot} className={`option${selected === o.slot ? ' picked' : ''}${isRight ? ' right' : ''}`}>
              <input type="radio" name="answer" value={o.slot} checked={selected === o.slot} onChange={() => setSelected(o.slot)} />
              <span>
                {o.text}
                {locked && isRight && <strong> (correct answer)</strong>}
                {locked && isChosen && !isRight && <strong> (your answer)</strong>}
              </span>
            </label>
          );
        })}
      </fieldset>

      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>

      {reveal ? (
        <>
          <p role="status">
            <strong>{reveal.data.correct ? 'Correct.' : 'Not quite.'}</strong> {reveal.data.explanation}
          </p>
          <button className="btn" disabled={busy} onClick={() => load()}>Next</button>
        </>
      ) : (
        <div className="pair">
          <button className="btn" disabled={busy || selected === null} onClick={lock}>{busy ? 'Saving…' : 'Lock answer'}</button>
          <button className="btn secondary" disabled={busy} onClick={skip}>Skip</button>
        </div>
      )}
      <p className="hint">Once locked, an answer cannot be changed. You can skip and come back once at the end.</p>
    </section>
  );
}

function ResultView({ result, headingRef }: { result: ExamResult; headingRef: React.RefObject<HTMLHeadingElement | null> }) {
  const label = { EASY: 'Easy', MEDIUM: 'Medium', HARD: 'Hard' } as const;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Step 14: after a test, practise what was missed (wrong or unanswered; removed questions never count).
  const missed = result.items.filter((i) => i.outcome === 'INCORRECT' || i.outcome === 'UNANSWERED').length;
  async function practise() {
    setBusy(true);
    setError(null);
    try {
      await practiseMissed(result.assessmentId);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }
  return (
    <>
      <section className="card" aria-labelledby="res">
        <h1 id="res" ref={headingRef} tabIndex={-1}>
          {result.correct} of {result.total}
        </h1>
        <p className="muted">
          {result.mode === 'TEST' ? 'Test' : 'Practice'} result.
          {result.unanswered > 0 && ` ${result.unanswered} unanswered.`}
          {result.removed > 0 && ` ${result.removed} question${result.removed === 1 ? ' was' : 's were'} removed and ${result.removed === 1 ? 'does' : 'do'} not count.`}
        </p>
        {result.corrected && (
          <p className="muted">This result was updated after a question in it was found to be wrong and removed.</p>
        )}
        <ul className="plain">
          {(Object.keys(label) as Array<keyof typeof label>).map((d) =>
            result.byDifficulty[d].total > 0 ? (
              <li key={d}>
                {label[d]}: {result.byDifficulty[d].correct} of {result.byDifficulty[d].total}
              </li>
            ) : null,
          )}
        </ul>
        {result.mode === 'TEST' && missed > 0 && (
          <p className="muted" style={{ marginBottom: 10 }}>
            Practise what you missed: 10 questions on the same topics, with the answer shown after each one.
          </p>
        )}
        {result.mode === 'PRACTICE' && (
          <p className="muted" style={{ marginBottom: 10 }}>Once this practice is counted, Home will offer a short retest on the same topics.</p>
        )}
        <div className="actions">
          {result.mode === 'TEST' && missed > 0 && (
            <button className="btn" disabled={busy} onClick={practise}>
              {busy ? 'Preparing…' : 'Practise what you missed'}
            </button>
          )}
          <Link className={result.mode === 'TEST' && missed > 0 ? 'btn secondary' : 'btn'} href="/home">Back to Home</Link>
        </div>
        <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      </section>

      <h2>Review</h2>
      {result.items.map((i) => (
        <section key={i.position} className="card" aria-label={`Question ${i.position}`}>
          <p className="muted" style={{ marginBottom: 6 }}>
            Question {i.position} · {label[i.difficulty]} ·{' '}
            <strong>
              {i.outcome === 'CORRECT' ? 'Correct' : i.outcome === 'INCORRECT' ? 'Incorrect' : i.outcome === 'EXCLUDED' ? 'Removed: does not count' : 'Not answered'}
            </strong>
          </p>
          {i.outcome === 'EXCLUDED' && (
            <p className="muted">
              {i.excludedReason === 'INVALIDATED'
                ? 'This question was found to be wrong after the test, so it was taken out of your score.'
                : 'This question could not be shown properly, so it was taken out of your score.'}
            </p>
          )}
          <p><strong>{i.stem}</strong></p>
          <ul className="plain">
            {i.options.map((o) => (
              <li key={o.slot} className={o.isCorrect ? 'right' : undefined}>
                {o.text}
                {o.isCorrect && <strong> (correct answer)</strong>}
                {o.chosen && <strong> (your answer)</strong>}
              </li>
            ))}
          </ul>
          {i.explanation && <p className="muted" style={{ marginBottom: 0 }}>{i.explanation}</p>}
        </section>
      ))}
    </>
  );
}
