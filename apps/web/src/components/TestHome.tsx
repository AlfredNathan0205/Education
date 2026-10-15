'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppNav } from './AppNav';
import { ApiError, LONG_TEST_QUESTIONS, bff, gradeLabel, type HomeView, type MyAssessment, type MyPlan } from '@/lib/client-api';
import { startTest } from '@/lib/start-test';

const DESCRIPTION: Record<string, string> = {
  QUICK10: 'Ten questions from the whole subject.',
  FOCUS10: 'Ten questions from the chapters you chose.',
};

/**
 * Choose a test (spec STUDENT_WEB: Choose/Recommended Test). Only the student's own curriculum and grade are offered;
 * anything else is Coming soon, never silently substituted. Focus 10 is offered once the student has chosen chapters.
 */
export function TestHome() {
  const [home, setHome] = useState<HomeView | null>(null);
  const [mine, setMine] = useState<MyAssessment[]>([]);
  const [mode, setMode] = useState<'TEST' | 'PRACTICE'>('TEST');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [plan, setPlan] = useState<MyPlan | null>(null);

  useEffect(() => {
    Promise.all([bff<HomeView>('GET', 'home'), bff<MyAssessment[]>('GET', 'exam/assessments')])
      .then(([h, m]) => {
        setHome(h);
        setMine(m);
      })
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load your tests.');
      });
    // Step 18: the plan only shapes what is offered here; the API enforces it either way.
    bff<MyPlan>('GET', 'entitlements').then(setPlan).catch(() => setPlan(null));
  }, []);

  async function start(subjectVersionId: string, blueprint: string) {
    setBusy(`${subjectVersionId}:${blueprint}`);
    setError(null);
    try {
      await startTest(subjectVersionId, mode, blueprint);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      setBusy(null);
    }
  }

  if (loadError) {
    return (
      <section className="card">
        <h1>Tests</h1>
        <p className="error" role="alert">{loadError}</p>
        <Link className="btn secondary" href="/profile">Go to your profile</Link>
      </section>
    );
  }
  if (!home) return <p className="muted" role="status">Loading…</p>;

  const open = mine.filter((m) => m.status === 'IN_PROGRESS');
  const done = mine.filter((m) => m.status !== 'IN_PROGRESS');

  return (
    <div className="has-nav">
      <AppNav current="tests" />
      <h1>Tests</h1>
      <p className="muted">
        In a Test, answers are shown only after you submit. In Practice, you see the answer after each question. There is no
        timer.
      </p>

      {open.length > 0 && (
        <section className="card" aria-labelledby="open">
          <h2 id="open">Pick up where you left off</h2>
          {open.map((m) => (
            <p key={m.assessmentId}>
              <Link className="btn" href={`/tests/${m.assessmentId}`}>
                Continue {m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}
              </Link>
            </p>
          ))}
        </section>
      )}

      {!home.cohort ? (
        <section className="card" aria-labelledby="start">
          <h2 id="start">Choose your curriculum and grade</h2>
          <p className="muted">Tests are matched to what you study.</p>
          <Link className="btn" href="/profile">Go to your profile</Link>
        </section>
      ) : !home.supported ? (
        <section className="card" aria-labelledby="start">
          <h2 id="start">Coming soon</h2>
          <p className="muted" style={{ marginBottom: 0 }}>
            Tests for {home.cohort.curriculumCode} {gradeLabel(home.cohort.gradeCode)} are not available yet. We will not give you
            questions from a different curriculum or grade.
          </p>
        </section>
      ) : (
        <section className="card" aria-labelledby="start">
          <h2 id="start">Start a new one</h2>
          {plan && <PlanLine plan={plan} />}
          <div className="seg" role="group" aria-label="Kind">
            <button type="button" aria-pressed={mode === 'TEST'} onClick={() => setMode('TEST')}>Test</button>
            <button type="button" aria-pressed={mode === 'PRACTICE'} onClick={() => setMode('PRACTICE')}>Practice</button>
          </div>
          {home.subjects.map((s) => {
            const offered = s.tests.filter((t) => t.code !== 'FOCUS10' || s.chosenChapters > 0);
            return (
              <div key={s.subjectVersionId} id={s.subjectCode} className="field">
                <h3 style={{ margin: '0 0 6px' }}>{s.subjectName}</h3>
                {offered.every((t) => !t.ready) && <p className="muted">Questions are still being prepared. Check back soon.</p>}
                {offered
                  .filter((t) => t.ready)
                  .map((t) => {
                    const notInPlan = !!plan && t.total >= LONG_TEST_QUESTIONS && !plan.values.LONG_TESTS;
                    const noneLeft = !!plan && plan.leftToday === 0;
                    return (
                      <div key={t.code} style={{ marginBottom: 10 }}>
                        <button className="btn" disabled={busy !== null || notInPlan || noneLeft} onClick={() => start(s.subjectVersionId, t.code)} aria-describedby={`d-${s.subjectCode}-${t.code}`}>
                          {busy === `${s.subjectVersionId}:${t.code}` ? 'Preparing…' : `${t.name} ${mode === 'TEST' ? 'test' : 'practice'}`}
                        </button>
                        <p className="hint" id={`d-${s.subjectCode}-${t.code}`}>
                          {DESCRIPTION[t.code] ?? `${t.total} questions.`}
                          {notInPlan && ' Longer tests are not included in your plan.'}
                        </p>
                      </div>
                    );
                  })}
                {s.chosenChapters === 0 && s.tests.some((t) => t.code === 'FOCUS10') && (
                  <p className="hint">
                    <Link href="/profile/chapters">Choose your chapters</Link> to get a Focus 10 on what you are studying.
                  </p>
                )}
              </div>
            );
          })}
          <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
        </section>
      )}

      {done.length > 0 && (
        <section className="card" aria-labelledby="past">
          <h2 id="past">Recent</h2>
          <ul className="plain">
            {done.map((m) => (
              <li key={m.assessmentId}>
                {m.status === 'SUBMITTED' ? (
                  <Link href={`/tests/${m.assessmentId}`}>
                    {m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}: {m.correct} of {m.total}
                  </Link>
                ) : m.status === 'INVALIDATED' ? (
                  <span className="muted">{m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}: cancelled, its questions were removed (does not count)</span>
                ) : (
                  <span className="muted">{m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}: expired, nothing was answered</span>
                )}{' '}
                <span className="muted">· {new Date(m.startedAt).toLocaleDateString()}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/** Step 18: the student's plan, and today's tests left when their plan has a daily limit. */
function PlanLine({ plan }: { plan: MyPlan }) {
  const until = plan.sources.find((x) => x.endsAt)?.endsAt;
  return (
    <p className="hint" role="status" style={{ marginBottom: 10 }}>
      Your plan: {plan.planName}
      {until ? ` (until ${new Date(until).toLocaleDateString()})` : ''}
      {plan.leftToday !== null &&
        (plan.leftToday > 0
          ? ` · ${plan.leftToday} test${plan.leftToday === 1 ? '' : 's'} or practice set${plan.leftToday === 1 ? '' : 's'} left to start today`
          : " · You've started all the tests your plan includes today. Your recommended practice and retests on Home are still open.")}
    </p>
  );
}
