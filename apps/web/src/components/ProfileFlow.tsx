'use client';

import { useEffect, useState, type FormEvent } from 'react';
import { ApiError, bff, type StudentProfile } from '@/lib/client-api';
import { profileStep, type ProfileStep } from '@/lib/profile-step';

const ORDER: ProfileStep[] = ['DOB', 'NAME', 'READY'];

export function ProfileFlow() {
  const [profile, setProfile] = useState<StudentProfile | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [value, setValue] = useState('');
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

  async function submit(e: FormEvent, path: string, body: unknown) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      setProfile(await bff<StudentProfile>('PUT', path, body));
      setValue('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
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

  const step = profileStep(profile);
  const idx = Math.max(0, ORDER.indexOf(step === 'GUARDIAN_NEEDED' ? 'NAME' : step));

  return (
    <>
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
          <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
          <button className="btn" type="submit" disabled={busy || value === ''}>{busy ? 'Saving…' : 'Continue'}</button>
        </form>
      )}

      {step === 'GUARDIAN_NEEDED' && (
        <section className="card" aria-labelledby="g">
          <h1 id="g">A parent or guardian needs to approve first</h1>
          <p>To protect students, we need a parent or guardian to approve your account before we ask for anything else.</p>
          <p className="muted" style={{ marginBottom: 0 }}>
            Guardian approval is being set up and is not available yet. Your account is saved, so you can come back and sign in with the same {''}
            email or number later.
          </p>
        </section>
      )}

      {step === 'NAME' && (
        <form className="card" onSubmit={(e) => submit(e, 'students/me/display-name', { displayName: value })} noValidate>
          <h1>What should we call you?</h1>
          <div className="field">
            <label htmlFor="name">Your name</label>
            <input id="name" type="text" autoComplete="given-name" maxLength={60} required value={value} onChange={(e) => setValue(e.target.value)} />
          </div>
          <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
          <button className="btn" type="submit" disabled={busy || value.trim() === ''}>{busy ? 'Saving…' : 'Continue'}</button>
        </form>
      )}

      {step === 'READY' && (
        <section className="card" aria-labelledby="r">
          <h1 id="r">Welcome, {profile.displayName}.</h1>
          <p className="muted" style={{ marginBottom: 0 }}>
            Your profile is set. Choosing your grade and school comes next and is not built yet.
          </p>
        </section>
      )}

      <form action="/sign-out" method="post">
        <button className="btn secondary" type="submit">Sign out</button>
      </form>
    </>
  );
}
