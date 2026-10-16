import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { YourData } from '@/components/YourData';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Your data · Exam App' };
export const dynamic = 'force-dynamic';

export default async function PrivacyPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <YourData />;
}
