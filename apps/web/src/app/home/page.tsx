import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Home } from '@/components/Home';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Home · Exam App' };
export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <Home />;
}
