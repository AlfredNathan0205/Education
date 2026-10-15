import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminMetrics } from '@/components/AdminMetrics';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Metrics · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminMetricsPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <AdminMetrics />;
}
