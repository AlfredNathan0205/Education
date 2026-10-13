import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { ExamRunner } from '@/components/ExamRunner';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Test · Exam App' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function TestPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <ExamRunner assessmentId={id} />;
}
