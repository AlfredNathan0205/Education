import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminMfa } from '@/components/AdminMfa';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Authenticator · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminMfaPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  const { next } = await searchParams;
  return <AdminMfa next={next ?? null} />;
}
