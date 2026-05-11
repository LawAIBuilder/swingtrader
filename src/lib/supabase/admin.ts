import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { env, requireEnv } from '@/lib/env';
import type { Database } from '@/types/database';

let cached: SupabaseClient<Database, 'bounce_trader'> | null = null;

// Server-side client backed by the service role key. Used by jobs that write to
// the bounce_trader schema. Bypasses RLS by Supabase convention. Do not call
// from any code path that reaches a browser.
export function getSupabaseAdmin(): SupabaseClient<Database, 'bounce_trader'> {
  if (cached) return cached;
  const url = requireEnv('SUPABASE_URL', env.supabaseUrl);
  const serviceRoleKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY', env.supabaseServiceRoleKey);
  cached = createClient<Database, 'bounce_trader'>(url, serviceRoleKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false
    },
    db: { schema: 'bounce_trader' }
  });
  return cached;
}
