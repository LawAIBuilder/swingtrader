import { cookies } from 'next/headers';
import { createServerClient } from '@supabase/ssr';
import { env, requireEnv } from '@/lib/env';
import type { Database } from '@/types/database';

// Server-side Supabase client backed by the anon key + Next.js cookies.
// Used by the dashboard pages to read the authenticated user and by the
// /login and /auth/callback routes to set/clear session cookies.
//
// IMPORTANT: this client targets the default (public/auth) schema. Auth
// (auth.users, auth.sessions) lives there, and the dashboard code only needs
// auth.getUser() out of it. For data reads of bounce_trader tables, use
// getSupabaseAuthBT() (cookie-aware, RLS-respecting against bounce_trader)
// or getSupabasePublic() (fully anonymous, dashboard views only).
export async function getSupabaseServer() {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL', env.nextPublicSupabaseUrl);
  const anon = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', env.nextPublicSupabaseAnonKey);
  const cookieStore = await cookies();
  return createServerClient<Database>(url, anon, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Setting cookies in a Server Component throws; the middleware
          // already refreshes the session so this branch is safe to ignore.
        }
      }
    }
  });
}

// Authenticated server client targeting the bounce_trader schema. Use this
// instead of getSupabasePublic() when you need to read RLS-authenticated-only
// tables like broker_orders, broker_positions, or daily_summaries from a
// dashboard page. The Supabase session cookie is forwarded so RLS evaluates
// the request as the signed-in user. If no session exists, this falls back to
// anon and the authenticated-only views simply return empty.
export async function getSupabaseAuthBT() {
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL', env.nextPublicSupabaseUrl);
  const anon = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', env.nextPublicSupabaseAnonKey);
  const cookieStore = await cookies();
  return createServerClient<Database, 'bounce_trader'>(url, anon, {
    db: { schema: 'bounce_trader' },
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Components reject cookie writes — middleware refreshes
          // the session, so it's safe to swallow.
        }
      }
    }
  });
}

export async function getCurrentUser(): Promise<{
  email: string;
  id: string;
} | null> {
  try {
    const supabase = await getSupabaseServer();
    const { data, error } = await supabase.auth.getUser();
    if (error || !data?.user?.email) return null;
    return { email: data.user.email.toLowerCase(), id: data.user.id };
  } catch {
    return null;
  }
}

export function isAdminEmail(email: string | null | undefined): boolean {
  if (!email) return false;
  return env.adminEmails.includes(email.toLowerCase());
}
