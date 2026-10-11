import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ProfileFlow } from '@/components/ProfileFlow';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Your profile · Exam App' };
export const dynamic = 'force-dynamic';

export default async function ProfilePage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <ProfileFlow />;
}
