'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { ApiError, bff } from '@/lib/client-api';

const ROLE_LABEL: Record<string, string> = { EDITOR: 'Editor', REVIEWER: 'Reviewer', APPROVER: 'Approver', SUPER_ADMIN: 'Super administrator' };

/** Who may use each page. The API enforces it; this only decides what is shown first. */
const CARDS: Array<{ href: string; title: string; text: string; roles: string[] }> = [
  { href: '/admin/curriculum', title: 'Curriculum', text: 'Create a subject, add its sources, upload chapters and objectives, and take it through review to activation. Suspend or correct a live one.', roles: ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'] },
  { href: '/admin/questions', title: 'Questions', text: 'Write a question in a form, upload many from a file, or ask the AI to draft some. Then submit, review, approve and publish.', roles: ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'] },
  { href: '/admin/readiness', title: 'Readiness and release', text: 'Check whether a subject has enough good questions, and release it to testers, the beta, or everyone.', roles: ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'] },
  { href: '/admin/blueprints', title: 'Test designs', text: 'The mix of chapters and difficulties in each kind of test. Approvers publish them.', roles: ['EDITOR', 'REVIEWER', 'APPROVER', 'SUPER_ADMIN'] },
  { href: '/admin/safety', title: 'Safety reports', text: 'Reports students made about other students, and the decisions taken.', roles: ['SUPER_ADMIN'] },
  { href: '/admin/plans', title: 'Plans', text: "Look up a student's plan, and give or end one.", roles: ['SUPER_ADMIN'] },
  { href: '/admin/metrics', title: 'Analytics', text: 'Totals from pseudonymous analytics.', roles: ['SUPER_ADMIN'] },
];

/** Step 22: one home for administrators, showing the pages their roles open first. */
export function AdminHome() {
  const [roles, setRoles] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    bff<{ roles: string[] }>('GET', 'admin/me')
      .then((r) => setRoles(r.roles))
      .catch((e) => {
        if (e instanceof ApiError && e.status === 401) window.location.assign('/sign-in');
        else setError(e instanceof ApiError ? e.message : 'Something went wrong.');
      });
  }, []);

  if (error) return <div className="card"><p className="error" role="alert">{error}</p></div>;
  if (!roles) return <p className="muted" role="status">Loading…</p>;
  if (roles.length === 0) {
    return (
      <div className="card">
        <h1>Administration</h1>
        <p role="alert">These pages are for staff. Your account has no staff role. Ask a super administrator if you need one.</p>
      </div>
    );
  }
  const yours = CARDS.filter((c) => c.roles.some((r) => roles.includes(r)));
  return (
    <>
      <h1>Administration</h1>
      <p className="muted">Your roles: {roles.map((r) => ROLE_LABEL[r] ?? r).join(', ')}.</p>
      <p className="muted">
        The order of work: a subject&apos;s curriculum is activated, then its questions are written, approved and published, then
        readiness is checked and the subject released. Activating a curriculum does not show it to students: release does.
      </p>
      <nav aria-label="Admin pages">
        {yours.map((c) => (
          <section className="card" key={c.href} aria-labelledby={`card-${c.href}`}>
            <h2 id={`card-${c.href}`}><Link href={c.href}>{c.title}</Link></h2>
            <p className="muted">{c.text}</p>
          </section>
        ))}
      </nav>
    </>
  );
}
