import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminReadiness } from '@/components/AdminReadiness';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Content readiness · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminReadinessPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <AdminReadiness />;
}
