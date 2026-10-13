import { GuardianApprove } from '@/components/GuardianApprove';

export const metadata = { title: 'Approve a student · Exam App', referrer: 'no-referrer' };
export const dynamic = 'force-dynamic';

export default function GuardianApprovePage() {
  return <GuardianApprove />;
}
