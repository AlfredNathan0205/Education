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
      <h1 className="hero-title">Know exactly where you stand.</h1>
      <p className="muted" style={{ fontSize: 17 }}>
        Curriculum-aligned tests that adapt to you, so you can see what you have mastered and what to work on next.
      </p>

      <section className="card" aria-labelledby="available">
        <h2 id="available" className="eyebrow" style={{ color: 'var(--muted)' }}>Available now</h2>
        <p style={{ marginBottom: 0, fontSize: 18, fontWeight: 700 }}>ICSE · Grade 8</p>
        <ul className="chips" aria-label="Subjects">
          {['Physics', 'Chemistry', 'Biology', 'Mathematics'].map((s) => (
            <li key={s} className="chip">{s}</li>
          ))}
        </ul>
      </section>

      <section className="card soon" aria-labelledby="soon">
        <p style={{ margin: 0 }}><strong id="soon">Coming soon</strong> · Other boards and grades are on the way.</p>
      </section>

      <Link className="btn" href="/sign-in">Get started</Link>
    </>
  );
}
