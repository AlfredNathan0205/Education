import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Progress } from '@/components/Progress';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Progress · Exam App' };
export const dynamic = 'force-dynamic';

export default async function ProgressPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <Progress />;
}
