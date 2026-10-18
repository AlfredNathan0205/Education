'use client';

import { useEffect, useState } from 'react';
import { AppNav } from './AppNav';
import { needsText } from '@/lib/ranking';
import { Social } from './Social';
import { ApiError, bff, type CompeteBoard, type CompeteView, track } from '@/lib/client-api';

const DAY = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Asia/Kolkata' });

/**
 * Compete (Step 15; spec COMPETITION_CHALLENGES): this week's leaderboards. Competitive points (CP) come from tests,
 * never practice, and never change what Progress says about what you know. Boards show public handles and CP only:
 * no names, schools, places or accuracy. Minors are not shown to other students in Release 1.
 */
export function Compete() {
  const [view, setView] = useState<CompeteView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      setView(await bff<CompeteView>('GET', 'compete'));
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
      else setError(e instanceof ApiError ? e.message : 'Could not load the leaderboards.');
    }
  }
  useEffect(() => {
    track('COMPETE_OPENED');
    void load();
  }, []);

  async function setShown(shown: boolean) {
    setBusy(true);
    setError(null);
    try {
      await bff('PUT', 'compete/visibility', { shown });
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="has-nav">
      <AppNav current="compete" />
      <h1>Compete</h1>
      {error && <p className="error" role="alert">{error}</p>}
      {!view && !error && <p className="muted" role="status">Loading…</p>}
      {view && (
        <>
          <section className="card" aria-labelledby="week">
            <p className="eyebrow">This week · {DAY.format(new Date(view.week.start))} to {DAY.format(new Date(new Date(view.week.end).getTime() - 1))}</p>
            <h2 id="week" style={{ marginBottom: 6 }}>You are {view.handle}</h2>
            <p className="muted">
              Competitive points (CP) come from tests: more for harder questions, nothing for questions you have seen before. Practice
              earns XP. Neither changes your progress.
            </p>
            <p style={{ marginBottom: 6 }}>
              <span className="score">{view.xp.week}</span> <span className="muted">XP this week · {view.xp.total} in total</span>
            </p>
            {view.pending > 0 && <p className="hint">A test you just finished is still being counted. Check back in a minute.</p>}
            <p className="hint" style={{ marginBottom: 0 }}>
              {view.shownToOthers
                ? 'Other students see your handle and CP on this week’s boards. Never your name, school or answers.'
                : view.canChangeVisibility
                  ? 'You are hidden: other students do not see you on the boards. You still see your own rank.'
                  : 'Other students do not see you on the boards. You still see the boards and your own rank.'}
            </p>
            {view.canChangeVisibility && (
              <button className="btn secondary" style={{ marginTop: 10 }} disabled={busy} onClick={() => setShown(!view.shownToOthers)}>
                {view.shownToOthers ? 'Hide me from other students' : 'Show me on the boards'}
              </button>
            )}
          </section>

          {view.boards.length === 0 ? (
            <p className="muted">Leaderboards appear once your curriculum and grade are open for tests.</p>
          ) : (
            view.boards.map((b) => <Board key={`${b.scope}-${b.subjectCode ?? ''}`} board={b} />)
          )}
        </>
      )}
      <Social />
    </div>
  );
}

function Board({ board }: { board: CompeteBoard }) {
  const id = `board-${board.scope}-${board.subjectCode ?? 'all'}`;
  const y = board.you;
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{board.title}</h2>
      <p className="muted">
        {y.rank !== null
          ? `You are ranked ${y.rank} of ${board.rankedCount} with ${y.cp} CP.`
          : y.needs.tests > 0 || y.needs.questions > 0
            ? `${y.cp} CP so far. To be ranked this week, take ${needsText(y.needs)}.`
            : `${y.cp} CP this week.`}
      </p>
      {board.entries.length === 0 ? (
        <p className="hint" style={{ marginBottom: 0 }}>Nobody is ranked here yet this week.</p>
      ) : (
        <ol className="board" aria-label={`${board.title} leaderboard`}>
          {board.entries.map((e) => (
            <li key={`${e.rank}-${e.handle}`} className={e.you ? 'you' : undefined}>
              <span className="rank">{e.rank}</span>
              <span className="who">{e.you ? `${e.handle} (you)` : e.handle}</span>
              <span className="cp">{e.cp} CP</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
