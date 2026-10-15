'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { AppNav } from './AppNav';
import { ApiError, bff, type ParentDashboard } from '@/lib/client-api';
import { ParentSummary } from './ParentSummary';

/** "See what they see" (Step 17): the student's own summary, exactly as a parent sees it. */
export function ParentPreview() {
  const [view, setView] = useState<ParentDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    bff<ParentDashboard>('GET', 'parent-sharing/preview')
      .then(setView)
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Could not load this page.');
      });
  }, []);
  return (
    <div className="has-nav">
      <AppNav current="progress" />
      <h1>What your parent sees</h1>
      <div className="preview-banner" role="note">
        This is exactly the summary a parent or guardian who can see your progress is shown. <Link href="/progress">Back to Progress</Link>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!view && !error && <p className="muted" role="status">Loading…</p>}
      {view && <ParentSummary content={view} live />}
    </div>
  );
}
