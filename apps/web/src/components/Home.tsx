'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppNav } from './AppNav';
import { ApiError, REASON_TEXT, bff, gradeLabel, type HomeView, type NextAction, type RecommendationView } from '@/lib/client-api';
import { startRecommendation, startTest } from '@/lib/start-test';

const TEST_NAME: Record<string, string> = { QUICK10: 'Quick 10', FOCUS10: 'Focus 10' };

/**
 * Home (spec STUDENT_WEB): the next best action first, then subjects. Leaderboards and challenges join when they exist
 * (Steps 15 and 16). No percentage is presented as mastery. Step 14 adds the loop's practice and retest: they can be the
 * next best action, and every open one is listed under "Focus next" with Start and Not now.
 */
export function Home() {
  const [home, setHome] = useState<HomeView | null>(null);
  const [blocked, setBlocked] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    bff<HomeView>('GET', 'home')
      .then(setHome)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else if (e instanceof ApiError && e.status === 403) setBlocked(e.message);
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load your home page.');
      });
  }, []);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  async function putOff(id: string) {
    await act(async () => {
      await bff('POST', `recommendations/${id}/dismiss`);
      setHome(await bff<HomeView>('GET', 'home'));
      setBusy(false);
    });
  }

  async function go(subjectVersionId: string, mode: 'TEST' | 'PRACTICE', blueprint?: string) {
    setBusy(true);
    setError(null);
    try {
      await startTest(subjectVersionId, mode, blueprint);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
      setBusy(false);
    }
  }

  if (blocked) {
    return (
      <section className="card">
        <h1>Almost there</h1>
        <p>{blocked}</p>
        <Link className="btn" href="/profile">Go to your profile</Link>
      </section>
    );
  }
  if (loadError) {
    return (
      <div className="has-nav">
        <AppNav current="home" />
        <p className="error" role="alert">{loadError}</p>
      </div>
    );
  }
  if (!home) return <p className="muted" role="status">Loading…</p>;
  // The recommendation already shown as the next best action is not listed again.
  const shown = home.nextAction.kind === 'RETEST' || home.nextAction.kind === 'PRACTICE' ? home.nextAction.recommendationId : null;
  const focus = home.focus.filter((r) => r.id !== shown);

  return (
    <div className="has-nav">
      <AppNav current="home" />
      <h1>{home.displayName ? `Hi, ${home.displayName}` : 'Home'}</h1>
      {home.cohort && (
        <p className="muted">
          {home.cohort.curriculumCode} · {gradeLabel(home.cohort.gradeCode)}
        </p>
      )}

      <NextBest
        action={home.nextAction}
        busy={busy}
        onStart={go}
        onRecommendation={(id) => act(() => startRecommendation(id))}
        onPutOff={putOff}
      />
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>

      {focus.length > 0 && (
        <section aria-labelledby="focus">
          <h2 id="focus">{home.nextAction.kind === 'RETEST' || home.nextAction.kind === 'PRACTICE' ? 'Also to focus on' : 'Focus next'}</h2>
          <ul className="subjects">
            {focus.map((r) => (
              <FocusItem key={r.id} rec={r} busy={busy} onStart={() => act(() => startRecommendation(r.id))} onPutOff={() => putOff(r.id)} />
            ))}
          </ul>
        </section>
      )}

      {home.inProgress.length > 1 && (
        <section className="card" aria-labelledby="open">
          <h2 id="open">Also in progress</h2>
          <ul className="plain">
            {home.inProgress.slice(1).map((m) => (
              <li key={m.assessmentId}>
                <Link href={`/tests/${m.assessmentId}`}>
                  Continue {m.subjectName} {m.mode === 'TEST' ? 'test' : 'practice'}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}

      {home.subjects.length > 0 && (
        <section aria-labelledby="subjects">
          <h2 id="subjects">Your subjects</h2>
          {home.firstExperience && <p className="muted">{home.firstExperienceMessage}: take a test in each subject to see where you stand.</p>}
          <ul className="subjects">
            {home.subjects.map((s) => (
              <li key={s.subjectVersionId} className="subject">
                <h3>{s.subjectName}</h3>
                {s.lastResult ? (
                  <p style={{ marginBottom: 8 }}>
                    <span className="score">
                      {s.lastResult.correct}/{s.lastResult.total}
                    </span>{' '}
                    <span className="muted">
                      last {s.lastResult.mode === 'TEST' ? 'test' : 'practice'} · {s.completed} finished
                    </span>
                  </p>
                ) : (
                  <p className="muted" style={{ marginBottom: 8 }}>No tests yet</p>
                )}
                <p className="hint" style={{ margin: '0 0 10px' }}>
                  {s.chosenChapters > 0 ? (
                    <>
                      {s.chosenChapters} chapter{s.chosenChapters === 1 ? '' : 's'} chosen · <Link href="/profile/chapters">change</Link>
                    </>
                  ) : (
                    <Link href="/profile/chapters">Choose the chapters you are studying</Link>
                  )}
                </p>
                {s.tests.some((t) => t.ready) ? (
                  <Link className="btn secondary" href={`/tests#${s.subjectCode}`}>Tests in {s.subjectName}</Link>
                ) : (
                  <p className="muted" style={{ marginBottom: 0 }}>Questions are still being prepared.</p>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function FocusItem({ rec, busy, onStart, onPutOff }: { rec: RecommendationView; busy: boolean; onStart: () => void; onPutOff: () => void }) {
  const codes = [...new Set(rec.reasons.map((x) => x.code))];
  return (
    <li className="subject" aria-label={`${rec.kind === 'RETEST' ? 'Retest' : 'Practice'} in ${rec.subjectName}`}>
      <p className="eyebrow">{rec.kind === 'RETEST' ? 'Retest' : 'Practice'} · {rec.subjectName}</p>
      <ul className="plain">
        {rec.objectives.map((o) => (
          <li key={o.path}>
            {o.statement}
            {o.chapterTitle && <span className="muted"> · {o.chapterTitle}</span>}
          </li>
        ))}
      </ul>
      <p className="hint" style={{ margin: '6px 0 10px' }}>{codes.map((c) => REASON_TEXT[c]).join('. ')}.</p>
      <div className="actions">
        <button className="btn" disabled={busy} onClick={onStart}>
          {rec.inProgressAssessmentId ? 'Continue' : rec.kind === 'RETEST' ? 'Start retest' : 'Start practice'}
        </button>
        {!rec.inProgressAssessmentId && (
          <button className="btn secondary" disabled={busy} onClick={onPutOff}>
            Not now
          </button>
        )}
      </div>
    </li>
  );
}

function NextBest({
  action,
  busy,
  onStart,
  onRecommendation,
  onPutOff,
}: {
  action: NextAction;
  busy: boolean;
  onStart: (sv: string, mode: 'TEST' | 'PRACTICE', blueprint?: string) => void;
  onRecommendation: (id: string) => void;
  onPutOff: (id: string) => void;
}) {
  const card = (title: string, body: React.ReactNode, cta: React.ReactNode, soon = false) => (
    <section className={soon ? 'card soon' : 'card nba'} aria-labelledby="nba">
      <p className="eyebrow">Next for you</p>
      <h2 id="nba">{title}</h2>
      <p className="muted">{body}</p>
      {cta}
    </section>
  );
  switch (action.kind) {
    case 'RESUME':
      return card(
        `Continue your ${action.subjectName} ${action.mode === 'TEST' ? 'test' : 'practice'}`,
        action.reason,
        <Link className="btn" href={`/tests/${action.assessmentId}`}>Continue</Link>,
      );
    case 'FINISH_PROFILE':
      return card('Finish your profile', action.reason, <Link className="btn" href="/profile">Choose curriculum and grade</Link>);
    case 'COMING_SOON':
      return card('Coming soon', `${action.reason} We will let you know when it opens.`, <Link className="btn secondary" href="/profile">Check your profile</Link>, true);
    case 'NOT_READY':
      return card('Almost ready', action.reason, null);
    case 'FIRST_TEST':
    case 'TAKE_TEST':
      return card(
        action.kind === 'FIRST_TEST' ? `${action.reason}` : `Take a ${action.subjectName} test`,
        action.kind === 'FIRST_TEST'
          ? `Start with ${TEST_NAME[action.blueprint] ?? action.blueprint} in ${action.subjectName}: 10 questions, no timer, answers shown at the end.`
          : action.reason,
        <button className="btn" disabled={busy} onClick={() => onStart(action.subjectVersionId, 'TEST', action.blueprint)}>
          {busy ? 'Preparing…' : `Start ${TEST_NAME[action.blueprint] ?? action.blueprint}`}
        </button>,
      );
    case 'RETEST':
      return card(
        `Retest in ${action.subjectName}`,
        `${action.reason} 10 questions, answers shown at the end.`,
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => onRecommendation(action.recommendationId)}>
            {busy ? 'Preparing…' : 'Start retest'}
          </button>
          <button className="btn secondary" disabled={busy} onClick={() => onPutOff(action.recommendationId)}>
            Not now
          </button>
        </div>,
      );
    case 'PRACTICE':
      return card(
        `Practise in ${action.subjectName}`,
        `${action.reason} 10 questions, with the answer shown after each one.`,
        <div className="actions">
          <button className="btn" disabled={busy} onClick={() => onRecommendation(action.recommendationId)}>
            {busy ? 'Preparing…' : 'Start practice'}
          </button>
          <button className="btn secondary" disabled={busy} onClick={() => onPutOff(action.recommendationId)}>
            Not now
          </button>
        </div>,
      );
  }
}
