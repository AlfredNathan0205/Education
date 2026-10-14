import { cookies } from 'next/headers';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { SESSION_COOKIE } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

export default async function Welcome() {
  // A signed-in student goes straight Home.
  const jar = await cookies();
  if (jar.get(SESSION_COOKIE)) redirect('/home');
  return (
    <>
      <h1>Know exactly where you stand.</h1>
      <p className="muted">
        Curriculum-aligned tests that adapt to you, so you can see what you have mastered and what to work on next.
      </p>

      <section className="card" aria-labelledby="available">
        <h2 id="available">Available now</h2>
        <p style={{ marginBottom: 0 }}>ICSE · Grade 8</p>
        <ul className="chips" aria-label="Subjects">
          {['Physics', 'Chemistry', 'Biology', 'Mathematics'].map((s) => (
            <li key={s} className="chip">{s}</li>
          ))}
        </ul>
      </section>

      <section className="card" aria-labelledby="soon">
        <h2 id="soon">Coming soon</h2>
        <p className="muted" style={{ marginBottom: 0 }}>Other boards and grades are on the way.</p>
      </section>

      <Link className="btn" href="/sign-in">Get started</Link>
    </>
  );
}
