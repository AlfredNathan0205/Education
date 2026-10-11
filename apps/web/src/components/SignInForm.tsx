'use client';

import { useRef, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { ApiError, bff } from '@/lib/client-api';

type Kind = 'EMAIL' | 'PHONE';

export function SignInForm() {
  const router = useRouter();
  const [kind, setKind] = useState<Kind>('EMAIL');
  const [identifier, setIdentifier] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const codeRef = useRef<HTMLInputElement>(null);

  async function request(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bff('POST', 'identity/otp/request', { kind, identifier });
      setSent(true);
      setTimeout(() => codeRef.current?.focus(), 0);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong.');
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await bff('POST', 'identity/otp/verify', { kind, identifier, code });
      router.push('/profile');
      router.refresh();
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 401
          ? 'That code is not valid or has expired. Check it or request a new one.'
          : err instanceof ApiError
            ? err.message
            : 'Something went wrong.',
      );
      setBusy(false);
    }
  }

  if (!sent) {
    return (
      <form onSubmit={request} noValidate>
        <div className="seg" role="group" aria-label="Sign in with">
          <button type="button" aria-pressed={kind === 'EMAIL'} onClick={() => setKind('EMAIL')}>Email</button>
          <button type="button" aria-pressed={kind === 'PHONE'} onClick={() => setKind('PHONE')}>Phone</button>
        </div>
        <div className="field">
          <label htmlFor="identifier">{kind === 'EMAIL' ? 'Email address' : 'Mobile number'}</label>
          <input
            id="identifier"
            type={kind === 'EMAIL' ? 'email' : 'tel'}
            autoComplete={kind === 'EMAIL' ? 'email' : 'tel'}
            inputMode={kind === 'EMAIL' ? 'email' : 'tel'}
            required
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            aria-describedby="id-hint"
          />
          <p id="id-hint" className="hint">
            {kind === 'EMAIL' ? "We'll send you a 6-digit code. No password needed." : 'Include your country code, for example +971…'}
          </p>
        </div>
        <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
        <button className="btn" type="submit" disabled={busy || identifier.trim() === ''}>
          {busy ? 'Sending…' : 'Send code'}
        </button>
      </form>
    );
  }

  return (
    <form onSubmit={verify} noValidate>
      <p className="muted">If that {kind === 'EMAIL' ? 'address' : 'number'} can receive messages, a 6-digit code is on its way.</p>
      <div className="field">
        <label htmlFor="code">6-digit code</label>
        <input
          id="code"
          ref={codeRef}
          inputMode="numeric"
          autoComplete="one-time-code"
          pattern="[0-9]{6}"
          maxLength={6}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
        />
      </div>
      <div role="alert" aria-live="polite">{error && <p className="error">{error}</p>}</div>
      <button className="btn" type="submit" disabled={busy || code.length !== 6}>
        {busy ? 'Checking…' : 'Continue'}
      </button>
      <div className="spacer" />
      <button className="btn secondary" type="button" onClick={() => { setSent(false); setCode(''); setError(null); }}>
        Use a different {kind === 'EMAIL' ? 'email' : 'number'}
      </button>
    </form>
  );
}
