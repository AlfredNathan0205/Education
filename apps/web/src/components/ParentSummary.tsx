import { MASTERY_LABEL, type MasteryLabel, type ParentClaim, type ParentSummaryContent } from '@/lib/client-api';

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** "12 Oct – 18 Oct": the period is [start, end), so the last day shown is the day before `end`. */
export function periodText(p: { start: string; end: string }): string {
  const end = new Date(new Date(p.end).getTime() - 1);
  return `${DAY.format(new Date(p.start))} – ${DAY.format(end)}`;
}

/**
 * What a parent sees (Step 17; spec CLAIM_GATING_PARENT, Parent Release 1): activity, the subject picture, demonstrated
 * strengths, Focus Next and improvement. Everything here passed the claim gate: labels and fixed sentences only, never a
 * score, a percentage or a model number. Sparse evidence reads "Building evidence", never a low label.
 */
export function ParentSummary({ content, live }: { content: ParentSummaryContent; live: boolean }) {
  const { activity: a } = content;
  const quiet = a.tests + a.practice === 0;
  return (
    <>
      <section className="card" aria-labelledby="ps-activity">
        <p className="eyebrow">{live ? 'This week so far' : 'That week'} · {periodText(content.period)}</p>
        <h2 id="ps-activity">Activity</h2>
        {quiet ? (
          <p className="muted" style={{ marginBottom: 0 }}>No tests or practice {live ? 'yet this week' : 'that week'}.</p>
        ) : (
          <ul className="plain" style={{ marginBottom: 0 }}>
            <li>{a.tests} test{a.tests === 1 ? '' : 's'} and {a.practice} practice set{a.practice === 1 ? '' : 's'}</li>
            <li>{a.questionsAnswered} question{a.questionsAnswered === 1 ? '' : 's'} answered</li>
            <li>Active on {a.activeDays} day{a.activeDays === 1 ? '' : 's'}</li>
          </ul>
        )}
      </section>

      <Claims id="ps-strengths" title="Strengths shown" claims={content.strengths} empty="Nothing to report yet. A strength is shown only once there is strong evidence from several tests." />
      <Claims id="ps-focus" title="Focus next" claims={content.focus} empty="No area needs attention on current evidence." />
      <Claims id="ps-improved" title="Improved" claims={content.improvements} empty={live ? 'No change to report yet this week.' : 'No change to report that week.'} />

      {content.subjects.map((s) => (
        <section key={s.subjectName} className="card" aria-labelledby={`ps-${s.subjectName}`}>
          <h2 id={`ps-${s.subjectName}`}>{s.subjectName}</h2>
          <p className="muted">
            {s.reportable} of {s.objectives} objective{s.objectives === 1 ? '' : 's'} with enough evidence to describe
          </p>
          <ul className="chips" aria-label={`${s.subjectName} objectives by label`}>
            {(['STRONG', 'SECURE', 'DEVELOPING', 'NEEDS_ATTENTION', 'BUILDING_EVIDENCE'] as MasteryLabel[])
              .filter((l) => s.counts[l] > 0)
              .map((l) => (
                <li key={l} className="chip">
                  {MASTERY_LABEL[l]}: {s.counts[l]}
                </li>
              ))}
          </ul>
          <ul className="plain chapters" style={{ marginTop: 12, marginBottom: 0 }}>
            {s.chapters.map((c) => (
              <li key={c.title}>
                <span className="chapter-title">{c.title}</span> <Badge label={c.label} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}

function Claims({ id, title, claims, empty }: { id: string; title: string; claims: ParentClaim[]; empty: string }) {
  return (
    <section className="card" aria-labelledby={id}>
      <h2 id={id}>{title}</h2>
      {claims.length === 0 ? (
        <p className="muted" style={{ marginBottom: 0 }}>{empty}</p>
      ) : (
        <ul className="plain" style={{ marginBottom: 0 }}>
          {claims.map((c) => (
            <li key={`${c.kind}-${c.subjectName}-${c.statement}`}>
              <span>{c.text}</span>
              <span className="hint"> · {c.subjectName}, {c.chapterTitle}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function Badge({ label }: { label: MasteryLabel }) {
  return <span className={`badge badge-${label.toLowerCase().replace('_', '-')}`}>{MASTERY_LABEL[label]}</span>;
}
