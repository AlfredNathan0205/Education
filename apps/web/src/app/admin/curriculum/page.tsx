import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { AdminCurriculum } from '@/components/AdminCurriculum';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Curriculum content · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminCurriculumPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <AdminCurriculum />;
}
