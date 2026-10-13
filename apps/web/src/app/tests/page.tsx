import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { TestHome } from '@/components/TestHome';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Tests · Exam App' };
export const dynamic = 'force-dynamic';

export default async function TestsPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <TestHome />;
}
