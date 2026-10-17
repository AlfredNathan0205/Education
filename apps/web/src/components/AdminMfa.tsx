'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ApiError, bff, type MfaStatus } from '@/lib/client-api';

/** Only a page under /admin is a safe place to go back to. */
export function safeNext(raw: string | null): string {
  return raw && /^\/admin(\/[A-Za-z0-9/_-]*)?$/.test(raw) && raw !== '/admin/mfa' ? raw : '/admin';
}

/**
 * Step 20: the authenticator app for administrators. Set it up once (scan or type the key, confirm a code, keep the
 * recovery codes); then pass the check once per session before any admin page opens.
 */
export function AdminMfa({ next }: { next: string | null }) {
  const [s, setS] = useState<MfaStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [codes, setCodes] = useState<string[] | null>(null);
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const back = safeNext(next);

  const load = useCallback(() => {
    bff<MfaStatus>('GET', 'mfa/status').then(setS).catch((e) => setError(e instanceof ApiError ? e.message : 'Something went wrong.'));
  }, []);
  useEffect(load, [load]);

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  const errorBox = <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>;
  if (!s) return error ? <div className="card">{errorBox}</div> : <p className="muted" role="status">Loading…</p>;

  if (!s.required) {
    return (
      <div className="card">
        <h1>Authenticator</h1>
        <p className="muted">Only administrator accounts use an authenticator app here.</p>
      </div>
    );
  }

  if (codes) {
    return (
      <div className="card">
        <h1>Save your recovery codes</h1>
        <p className="muted">If you lose your phone, each of these lets you in once. Keep them somewhere safe. They are not shown again.</p>
        <ul className="plain" aria-label="Recovery codes" style={{ fontFamily: 'monospace' }}>
          {codes.map((c) => <li key={c}>{c}</li>)}
        </ul>
        <Link className="btn" href={back}>I have saved them, continue</Link>
      </div>
    );
  }

  if (s.verified) {
    return (
      <div className="card">
        <h1>Authenticator</h1>
        <p className="muted">You have confirmed it is you for this session. Recovery codes left: {s.recoveryCodesLeft}.</p>
        <Link className="btn" href={back}>Continue</Link>
      </div>
    );
  }

  if (!s.enrolled) {
    return (
      <form
        className="card"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void act(async () => {
            const r = await bff<{ recoveryCodes: string[] }>('POST', 'mfa/enrol/confirm', { code: code.trim() });
            setCodes(r.recoveryCodes);
          });
        }}
      >
        <h1>Set up an authenticator app</h1>
        <p className="muted">Administrator pages need a code from an authenticator app on your phone (for example Google Authenticator, Microsoft Authenticator or 1Password), as well as your sign-in.</p>
        {!setup ? (
          <>
            {errorBox}
            <button className="btn" type="button" disabled={busy} onClick={() => void act(async () => setSetup(await bff('POST', 'mfa/enrol/start', {})))}>Start set-up</button>
          </>
        ) : (
          <>
            <p>In your app, add an account and type this key (or <a href={setup.otpauthUri}>open it in your app</a> on this device):</p>
            <p aria-label="Set-up key" style={{ fontFamily: 'monospace', fontSize: '1.1rem', wordBreak: 'break-all' }}>{setup.secret.match(/.{1,4}/g)?.join(' ')}</p>
            <div className="field">
              <label htmlFor="code">The 6-digit code your app shows</label>
              <input id="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
            </div>
            {errorBox}
            <button className="btn" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Confirm'}</button>
          </>
        )}
      </form>
    );
  }

  return (
    <form
      className="card"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void act(async () => {
          await bff('POST', 'mfa/verify', useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() });
          window.location.assign(back);
        });
      }}
    >
      <h1>Confirm it is you</h1>
      <div className="field">
        <label htmlFor="code">{useRecovery ? 'A recovery code' : 'The 6-digit code from your authenticator app'}</label>
        <input
          id="code"
          inputMode={useRecovery ? 'text' : 'numeric'}
          autoComplete="one-time-code"
          maxLength={useRecovery ? 16 : 6}
          value={code}
          onChange={(e) => setCode(useRecovery ? e.target.value : e.target.value.replace(/\D/g, ''))}
        />
      </div>
      {errorBox}
      <button className="btn" type="submit" disabled={busy || (useRecovery ? code.trim().length < 12 : code.length !== 6)}>{busy ? 'Checking…' : 'Continue'}</button>
      <div className="spacer" />
      <button className="btn secondary" type="button" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
        {useRecovery ? 'Use the app instead' : 'Use a recovery code'}
      </button>
    </form>
  );
}
