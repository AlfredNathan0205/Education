import { ParentAccept } from '@/components/ParentAccept';

export const metadata = { title: 'Progress-sharing invitation · Exam App' };
export const dynamic = 'force-dynamic';

/** Not signed in is handled in the page: the token is kept in this tab, sign-in brings the parent straight back. */
export default function ParentAcceptPage() {
  return <ParentAccept />;
}
