import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ParentPreview } from '@/components/ParentPreview';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'What your parent sees · Exam App' };
export const dynamic = 'force-dynamic';

export default async function ParentViewPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <ParentPreview />;
}
