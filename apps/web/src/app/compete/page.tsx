import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AppNav } from '@/components/AppNav';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Compete · Exam App' };
export const dynamic = 'force-dynamic';

/** Weekly leaderboards arrive in Step 15 and friend challenges in Step 16. Until then, an honest placeholder. */
export default async function CompetePage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return (
    <div className="has-nav">
      <AppNav current="compete" />
      <h1>Compete</h1>
      <section className="card" aria-labelledby="soon">
        <h2 id="soon">Coming soon</h2>
        <p className="muted" style={{ marginBottom: 0 }}>
          Weekly leaderboards for your school and beyond are on the way. Points will come from tests, not practice, and they
          never change what your progress says about what you know.
        </p>
      </section>
    </div>
  );
}
