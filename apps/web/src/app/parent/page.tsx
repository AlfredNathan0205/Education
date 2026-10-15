import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ParentHome } from '@/components/ParentHome';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Progress summary · Exam App' };
export const dynamic = 'force-dynamic';

export default async function ParentPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <ParentHome />;
}
