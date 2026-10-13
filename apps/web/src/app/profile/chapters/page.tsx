import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { ChapterPicker } from '@/components/ChapterPicker';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'My chapters · Exam App' };
export const dynamic = 'force-dynamic';

export default async function Page() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return (
    <main className="container">
      <ChapterPicker />
    </main>
  );
}
