import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/server-api';

/** Clears the browser session. (Server-side revocation endpoint is a follow-up.) */
export async function POST(req: Request) {
  const res = NextResponse.redirect(new URL('/', req.url), 303);
  res.cookies.delete(SESSION_COOKIE);
  return res;
}
