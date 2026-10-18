import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/**
 * Which environment this is, for the banner (ENV_LABEL, read at request time so one image serves every environment).
 * Unset (production, local): no banner.
 */
export async function GET() {
  const label = (process.env.ENV_LABEL ?? '').trim().slice(0, 40);
  return NextResponse.json({ label: label || null }, { headers: { 'Cache-Control': 'no-store' } });
}
