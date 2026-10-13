'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, bff } from '@/lib/client-api';

interface View {
  subjects: Array<{ subjectCode: string; subjectName: string; chapters: Array<{ code: string; title: string; selected: boolean; suggested: boolean }> }>;
  schoolPlan: null | {
    schoolName: string;
    academicYear: string;
    groups: Array<{ termLabel: string; assessmentLabel: string; chapters: Array<{ subjectCode: string; chapterCode: string }> }>;
  };
}

const key = (s: string, c: string) => `${s}|${c}`;

export function ChapterPicker() {
  const [view, setView] = useState<View | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  function adopt(v: View) {
    setView(v);
    setPicked(new Set(v.subjects.flatMap((s) => s.chapters.filter((c) => c.selected).map((c) => key(s.subjectCode, c.code)))));
  }

  useEffect(() => {
    bff<View>('GET', 'students/me/chapters')
      .then(adopt)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Could not load your chapters.');
      });
  }, []);

  function toggle(k: string) {
    setSaved(false);
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function useSuggestion(chapters: Array<{ subjectCode: string; chapterCode: string }>) {
    setSaved(false);
    setPicked((prev) => new Set([...prev, ...chapters.map((c) => key(c.subjectCode, c.chapterCode))]));
  }

  async function save() {
    if (!view) return;
    setBusy(true);
    setError(null);
    try {
      const chapters = [...picked].map((k) => {
        const [subjectCode, chapterCode] = k.split('|');
        return { subjectCode, chapterCode };
      });
      adopt(await bff<View>('PUT', 'students/me/chapters', { chapters }));
      setSaved(true);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  if (error && !view) return <div className="card"><p className="error" role="alert">{error}</p><Link href="/profile">Back to profile</Link></div>;
  if (!view) return <p className="muted" role="status">Loading…</p>;

  return (
    <>
      <h1>My chapters</h1>
      <p className="muted">Choose the chapters you want to focus on. This is your choice; nobody else decides it.</p>

      {view.schoolPlan ? (
        <section className="card" aria-label="Plan from your school">
          <h2>{view.schoolPlan.schoolName} · {view.schoolPlan.academicYear}</h2>
          <p className="muted">A suggestion from the plan we have for your school. It may not match what your teacher has told you.</p>
          {view.schoolPlan.groups.map((g) => (
            <p key={`${g.termLabel}|${g.assessmentLabel}`}>
              <strong>{g.termLabel}{g.assessmentLabel ? ` · ${g.assessmentLabel}` : ''}</strong>{' '}
              <button className="btn secondary" type="button" onClick={() => useSuggestion(g.chapters)}>Add these chapters</button>
            </p>
          ))}
        </section>
      ) : null}

      {view.subjects.length === 0 ? <p className="muted">No chapters are open yet.</p> : null}
      {view.subjects.map((s) => (
        <fieldset key={s.subjectCode} className="card">
          <legend>{s.subjectName}</legend>
          {s.chapters.map((c) => {
            const k = key(s.subjectCode, c.code);
            return (
              <label key={k} style={{ display: 'flex', gap: 8, minHeight: 44, alignItems: 'center' }}>
                <input type="checkbox" checked={picked.has(k)} onChange={() => toggle(k)} />
                <span>{c.title}{c.suggested ? ' (in your school plan)' : ''}</span>
              </label>
            );
          })}
        </fieldset>
      ))}

      {error ? <p className="error" role="alert">{error}</p> : null}
      {saved ? <p role="status">Saved.</p> : null}
      <button className="btn" disabled={busy} onClick={save}>Save my chapters</button>{' '}
      <Link className="btn secondary" href="/profile">Back</Link>
    </>
  );
}
