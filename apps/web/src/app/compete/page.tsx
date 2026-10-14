import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Compete } from '@/components/Compete';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Compete · Exam App' };
export const dynamic = 'force-dynamic';

/** Weekly leaderboards (Step 15). Friend challenges arrive in Step 16. */
export default async function CompetePage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <Compete />;
}
