import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { SESSION_COOKIE, callApi, isAllowed } from '@/lib/server-api';

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
    upstream = await callApi(req.method, target, token, body);
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
  return new NextResponse(text.length ? text : null, {
    status: upstream.status,
    headers: { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json' },
  });
}

export { handle as GET, handle as POST, handle as PUT };
