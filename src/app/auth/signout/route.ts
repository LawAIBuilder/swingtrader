import { NextResponse, type NextRequest } from 'next/server';
import { getSupabaseServer } from '@/lib/supabase/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handle(req: NextRequest) {
  try {
    const supabase = await getSupabaseServer();
    await supabase.auth.signOut();
  } catch {
    // already signed out, nothing to do.
  }
  const url = new URL('/login', req.url);
  return NextResponse.redirect(url);
}

export const GET = handle;
export const POST = handle;
