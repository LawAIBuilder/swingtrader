import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, requireEnv } from '@/lib/env';
import type { Database } from '@/types/database';

let cached: SupabaseClient<Database, 'bounce_trader'> | null = null;

// Public read-only client backed by the anon (publishable) key. The dashboard
// uses this so the Vercel deployment does not need a service role key. Anon
// can only SELECT from the explicitly-granted dashboard views, enforced by
// RLS + view-level grants in supabase/schema.sql.
export function getSupabasePublic(): SupabaseClient<Database, 'bounce_trader'> {
  if (cached) return cached;
  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL', env.nextPublicSupabaseUrl);
  const anon = requireEnv('NEXT_PUBLIC_SUPABASE_ANON_KEY', env.nextPublicSupabaseAnonKey);
  cached = createClient<Database, 'bounce_trader'>(url, anon, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'bounce_trader' }
  });
  return cached;
}
