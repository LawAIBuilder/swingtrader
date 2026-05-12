import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';
import { safeNextPath } from '@/lib/utils/safe-next';

// Magic-link callback. Supabase hashes the auth code into the URL; this route
// exchanges it for a session cookie and bounces the user back to ?next=.
//
// SECURITY: the `next` query param is user-controlled (it is propagated through
// the magic-link emailRedirectTo and back). We MUST validate it against open
// redirects: bare path-only strings allowed, anything that could resolve to
// another origin (//evil.com, /\evil.com, /javascript:, etc.) is rejected to
// the safe fallback '/'. See src/lib/utils/safe-next.ts for the rules.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const code = url.searchParams.get('code');
  const rawNext = url.searchParams.get('next');
  const safeNext = safeNextPath(rawNext, '/');

  if (!code) {
    const target = new URL('/login', url.origin);
    target.searchParams.set('error', 'missing_code');
    target.searchParams.set('next', safeNext);
    return NextResponse.redirect(target);
  }

  try {
    const supabase = await getSupabaseServer();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) {
      const target = new URL('/login', url.origin);
      target.searchParams.set('error', 'exchange_failed');
      target.searchParams.set('next', safeNext);
      return NextResponse.redirect(target);
    }
  } catch {
    const target = new URL('/login', url.origin);
    target.searchParams.set('error', 'exchange_failed');
    target.searchParams.set('next', safeNext);
    return NextResponse.redirect(target);
  }

  const dest = new URL(safeNext, url.origin);
  return NextResponse.redirect(dest);
}
