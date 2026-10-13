import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { Blueprints } from '@/components/Blueprints';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Test designs · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminBlueprintsPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <Blueprints />;
}
