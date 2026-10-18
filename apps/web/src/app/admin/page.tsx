import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminHome } from '@/components/AdminHome';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Administration · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminHomePage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <AdminHome />;
}
