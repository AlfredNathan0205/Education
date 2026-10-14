'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, bff, type AcademicView, type SchoolHit, type StudentProfile } from '@/lib/client-api';
import { profileStep, type ProfileStep } from '@/lib/profile-step';
import { AppNav } from './AppNav';
import { GuardianRequest } from '@/components/GuardianRequest';

const ORDER: ProfileStep[] = ['DOB', 'NAME', 'GRADE', 'SCHOOL', 'READY'];

export function ProfileFlow() {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [academic, setAcademic] = useState<AcademicView | null>(null);
  const [skipped, setSkipped] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState('');
  const [hits, setHits] = useState<SchoolHit[] | null>(null);
  const [typed, setTyped] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bff<StudentProfile>('POST', 'students/me')
      .then(setProfile)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setLoadError(e instanceof ApiError ? e.message : 'Could not load your profile.');
      });
  }, []);

  // Academic details are only read once the profile is complete enough to collect them.
  const profileReady = !!profile && profile.ageClassified && !profile.requiresGuardianConsent && !!profile.displayName;
  useEffect(() => {
    if (!profileReady || academic) return;
    bff<AcademicView>('GET', 'students/me/academic')
      .then(setAcademic)
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : 'Could not load your details.'));
  }, [profileReady, academic]);

  async function run<T>(action: () => Promise<T>, onDone: (r: T) => void) {
    setBusy(true);
    setError(null);
    try {
      onDone(await action());
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  function submit(e: FormEvent, path: string, body: unknown) {
    e.preventDefault();
    return run(() => bff<StudentProfile>('PUT', path, body), (p) => {
      setProfile(p);
      setValue('');
    });
  }

  function saveAcademic(method: string, path: string, body?: unknown) {
    return run(() => bff<AcademicView>(method, path, body), (a) => {
      setAcademic(a);
      setValue('');
      setHits(null);
      setTyped(false);
      setSkipped(false);
    });
  }

  function search(e: FormEvent) {
    e.preventDefault();
    return run(() => bff<SchoolHit[]>('POST', 'students/me/schools/search', { query: value }), setHits);
  }

  if (loadError) {
    return (
      <div className="card">
        <p className="error" role="alert">{loadError}</p>
        <button className="btn" onClick={() => window.location.reload()}>Try again</button>
      </div>
    );
  }
  if (!profile) return <p className="muted" role="status">Loading…</p>;
  if (profileReady && !academic) return <p className="muted" role="status">Loading…</p>;

  const step = profileStep(profile, academic, skipped);
  const idx = Math.max(0, ORDER.indexOf(step === 'GUARDIAN_NEEDED' ? 'NAME' : step));
  const errorBox = <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>;

  return (
    <div className={step === 'READY' ? 'has-nav' : undefined}>
      <ol className="steps" aria-label="Progress">
        {ORDER.map((s, i) => (
          <li key={s} className={i < idx ? 'done' : i === idx ? 'current' : ''} />
        ))}
      </ol>

      {step === 'DOB' && (
        <form className="card" onSubmit={(e) => submit(e, 'students/me/date-of-birth', { dateOfBirth: value })} noValidate>
          <h1>When were you born?</h1>
          <p className="muted">We use this to keep your account safe and follow the rules that apply to you. Only this service can see it.</p>
          <div className="field">
            <label htmlFor="dob">Date of birth</label>
            <input id="dob" type="date" required value={value} onChange={(e) => setValue(e.target.value)} max={new Date().toISOString().slice(0, 10)} />
          </div>
          {errorBox}
          <button className="btn" type="submit" disabled={busy || value === ''}>{busy ? 'Saving…' : 'Continue'}</button>
        </form>
      )}

      {step === 'GUARDIAN_NEEDED' && (
        <GuardianRequest onApproved={() => void bff<StudentProfile>('GET', 'students/me').then(setProfile).catch(() => undefined)} />
      )}

      {step === 'NAME' && (
        <form className="card" onSubmit={(e) => submit(e, 'students/me/display-name', { displayName: value })} noValidate>
          <h1>What should we call you?</h1>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" type="text" autoComplete="given-name" maxLength={60} required value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          {errorBox}
          <button className="btn" type="submit" disabled={busy || value.trim() === ''}>{busy ? 'Saving…' : 'Continue'}</button>
        </form>
      )}

      {step === 'GRADE' && academic && (
        <section className="card" aria-labelledby="gr">
          <h1 id="gr">What are you studying?</h1>
          <p className="muted">We are starting with these. Choose the one that matches your class.</p>
          {academic.cohortOptions.map((o) => (
            <button
              key={`${o.curriculumCode}-${o.gradeCode}`}
              className="btn"
              style={{ marginBottom: 8 }}
              disabled={busy}
              onClick={() => saveAcademic('PUT', 'students/me/grade', { curriculumCode: o.curriculumCode, gradeCode: o.gradeCode })}
            >
              {o.label}
            </button>
          ))}
          {errorBox}
        </section>
      )}

      {step === 'SCHOOL' && (
        <section className="card" aria-labelledby="sc">
          <h1 id="sc">Which school are you at?</h1>
          <p className="muted">Optional. This is just so we can tailor things for you. It does not give your school access to anything.</p>

          {!typed ? (
            <>
              <form onSubmit={search} noValidate>
                <div className="field">
                  <label htmlFor="q">Search for your school</label>
                  <input id="q" type="text" maxLength={100} value={value} onChange={(e) => setValue(e.target.value)} />
                </div>
                <button className="btn" type="submit" disabled={busy || value.trim().length < 2}>{busy ? 'Searching…' : 'Search'}</button>
              </form>
              {hits && hits.length === 0 && <p className="muted">No match yet.</p>}
              {hits && hits.map((h) => (
                <div key={h.id} style={{ marginTop: 8 }}>
                  <button className="btn secondary" disabled={busy} onClick={() => saveAcademic('PUT', 'students/me/school', { schoolId: h.id })}>
                    {h.name}{h.city ? `, ${h.city}` : ''}
                  </button>
                </div>
              ))}
              <p style={{ marginTop: 16 }}>
                <button className="btn secondary" onClick={() => { setTyped(true); setHits(null); setValue(''); }}>My school is not listed</button>
              </p>
            </>
          ) : (
            <form onSubmit={(e) => { e.preventDefault(); void saveAcademic('PUT', 'students/me/school', { schoolName: value }); }} noValidate>
              <div className="field">
                <label htmlFor="sn">Your school's name</label>
                <input id="sn" type="text" maxLength={200} value={value} onChange={(e) => setValue(e.target.value)} />
              </div>
              <p className="muted">We will check it before it is shown as confirmed.</p>
              <button className="btn" type="submit" disabled={busy || value.trim().length < 2}>{busy ? 'Saving…' : 'Save'}</button>
              <button className="btn secondary" type="button" onClick={() => { setTyped(false); setValue(''); }}>Back to search</button>
            </form>
          )}
          {errorBox}
          <p style={{ marginTop: 16, marginBottom: 0 }}>
            <button className="btn secondary" onClick={() => setSkipped(true)}>Skip for now</button>
          </p>
        </section>
      )}

      {step === 'READY' && <AppNav current="profile" />}
      {step === 'READY' && (
        <section className="card" aria-labelledby="r">
          <h1 id="r">Welcome, {profile.displayName}.</h1>
          <p className="muted">
            {academic?.grade?.label ?? ''}
            {academic?.school
              ? ` · ${academic.school.name}${academic.school.awaitingReview ? ' (we will check this)' : ''}`
              : ''}
          </p>
          <p className="muted">Your profile is set.</p>
          <Link className="btn" href="/home">Go to Home</Link>{' '}
          <Link className="btn secondary" href="/profile/chapters">Choose the chapters I am studying</Link>
          {errorBox}
          {academic?.school ? (
            <p>
              <button className="btn secondary" disabled={busy} onClick={() => saveAcademic('POST', 'students/me/school/leave')}>
                I have left this school
              </button>
            </p>
          ) : (
            <p>
              <button className="btn secondary" onClick={() => setSkipped(false)}>Add my school</button>
            </p>
          )}
        </section>
      )}

      <form action="/sign-out" method="post">
        <button className="btn secondary" type="submit">Sign out</button>
      </form>
    </div>
  );
}
