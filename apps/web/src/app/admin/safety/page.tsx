import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { SafetyQueue } from '@/components/SafetyQueue';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Safety reports · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminSafetyPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <SafetyQueue />;
}
