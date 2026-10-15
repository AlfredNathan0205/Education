import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminPlans } from '@/components/AdminPlans';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Plans · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminPlansPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <AdminPlans />;
}
