import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { AdminCurriculumUnit } from '@/components/AdminCurriculumUnit';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Subject curriculum · Exam App' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function AdminCurriculumUnitPage({ params }: { params: Promise<{ id: string }> }) {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  return <AdminCurriculumUnit id={id} />;
}
