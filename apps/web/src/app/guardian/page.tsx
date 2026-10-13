import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { GuardianApprovals } from '@/components/GuardianApprovals';
import { SESSION_COOKIE } from '@/lib/server-api';

export const metadata = { title: 'Your approvals · Exam App' };
export const dynamic = 'force-dynamic';

export default async function GuardianPage() {
  const jar = await cookies();
  if (!jar.get(SESSION_COOKIE)) redirect('/sign-in');
  return <GuardianApprovals />;
}
