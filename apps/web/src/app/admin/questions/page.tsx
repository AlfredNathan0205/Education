import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { QuestionBank } from '@/components/QuestionBank';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Question bank · Exam App' };
export const dynamic = 'force-dynamic';

export default async function AdminQuestionsPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <QuestionBank />;
}
