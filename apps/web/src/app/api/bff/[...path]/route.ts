import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, callApi, clientIp, isAllowed } from '@/lib/server-api';

/**
 * Browser-facing proxy. The session token lives only in an httpOnly cookie, so page
 * scripts can never read it. Only a fixed allow-list of API routes is reachable.
 */
async function handle(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  const target = path.join('/');
  if (!isAllowed(req.method, target)) {
    return NextResponse.json({ message: 'Not found' }, { status: 404 });
  }

  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value ?? null;

  let body: unknown;
  if (req.method !== 'GET') {
    try {
      body = await req.json();
    } catch {
      body = undefined;
    }
  }

  let upstream: Response;
  try {
    upstream = await callApi(req.method, target, token, body, clientIp(req.headers));
  } catch {
    return NextResponse.json(
      { message: 'We could not reach the service. Check your connection and try again.' },
      { status: 503 },
    );
  }

  if (target === 'identity/otp/verify' && upstream.ok) {
    const data = (await upstream.json()) as {
      sessionToken: string;
      expiresAt: string;
      isNewAccount: boolean;
    };
    const res = NextResponse.json({ isNewAccount: data.isNewAccount });
    res.cookies.set(SESSION_COOKIE, data.sessionToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      expires: new Date(data.expiresAt),
    });
    return res;
  }

  const text = await upstream.text();
  const headers: Record<string, string> = { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', 'Cache-Control': 'no-store' };
  // Step 20: a data copy downloads as a file; a rate-limited request says when to retry.
  for (const h of ['content-disposition', 'retry-after']) {
    const v = upstream.headers.get(h);
    if (v) headers[h] = v;
  }
  return new NextResponse(text.length ? text : null, { status: upstream.status, headers });
}

export { handle as GET, handle as POST, handle as PUT };
