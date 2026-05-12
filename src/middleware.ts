import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';

// Edge middleware. Two responsibilities:
//   1. Refresh the Supabase auth session cookie on every dashboard request so
//      magic-link sessions don't silently expire while the page is open.
//   2. Gate the dashboard pages (everything not in /api/* or /login*) behind
//      DASHBOARD_AUTH_REQUIRED + an ADMIN_EMAILS allowlist.
//
// We deliberately don't read process.env via the strict env.ts here because
// edge middleware runs on a different runtime and only needs string knobs.

const ADMIN_EMAILS_RAW = (process.env.ADMIN_EMAILS ?? '').toLowerCase();
const ADMIN_EMAILS = ADMIN_EMAILS_RAW.split(',').map((e) => e.trim()).filter(Boolean);
const AUTH_REQUIRED = (process.env.DASHBOARD_AUTH_REQUIRED ?? 'true').toLowerCase() !== 'false';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL ?? '';
const SUPABASE_ANON =
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ??
  process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
  '';

function isPublicPath(pathname: string): boolean {
  if (pathname.startsWith('/api/')) return true;
  if (pathname.startsWith('/login')) return true;
  if (pathname.startsWith('/auth/callback')) return true;
  if (pathname.startsWith('/_next/')) return true;
  if (pathname === '/favicon.ico') return true;
  return false;
}

// Path-only same-origin guard. We deliberately reject `//`, `/\`, and any
// `/scheme:` form because `new URL` resolves those to a different origin and
// would create an open redirect once the path is echoed back into a redirect
// URL (e.g. /login?next=...). This must mirror src/lib/utils/safe-next.ts —
// duplicated here because edge middleware and node share no module graph.
function safeMiddlewareNext(input: string): string {
  if (!input.startsWith('/')) return '/';
  if (input.startsWith('//')) return '/';
  if (input.startsWith('/\\')) return '/';
  if (input.startsWith('/%2F') || input.startsWith('/%2f')) return '/';
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(input)) return '/';
  return input;
}

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();
  if (!AUTH_REQUIRED) return NextResponse.next();

  // No Supabase configured → don't lock the user out, but the dashboard will
  // already render its "setup needed" card. This avoids breaking local dev.
  if (!SUPABASE_URL || !SUPABASE_ANON) return NextResponse.next();

  const response = NextResponse.next();
  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON, {
    cookies: {
      getAll() {
        return req.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      }
    }
  });

  const { data } = await supabase.auth.getUser();
  const email = data?.user?.email?.toLowerCase();
  const safePath = safeMiddlewareNext(pathname);

  if (!email) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('next', safePath);
    return NextResponse.redirect(url);
  }

  // ADMIN_EMAILS is the allowlist. If unset, anyone with a Supabase session
  // can access the dashboard, which is a footgun on a multi-tenant Supabase
  // project. We refuse rather than silently allow that case.
  //
  // We intentionally do NOT echo the email back to /login. Putting an
  // authenticated user's address in URL params leaks PII into browser
  // history, server access logs, and analytics. The login page shows a
  // generic "not authorized" message instead.
  if (ADMIN_EMAILS.length === 0 || !ADMIN_EMAILS.includes(email)) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('error', 'forbidden');
    url.searchParams.set('next', safePath);
    return NextResponse.redirect(url);
  }

  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)']
};
