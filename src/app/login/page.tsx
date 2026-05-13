import { Card } from '@/components/Card';
import { Pill } from '@/components/Pill';
import { env, hasPublicSupabaseConfig } from '@/lib/env';
import { safeNextPath } from '@/lib/utils/safe-next';
import { LoginForm } from './LoginForm';

export const dynamic = 'force-dynamic';

interface SearchParams {
  searchParams: Promise<{ next?: string; error?: string; sent?: string }>;
}

export default async function LoginPage({ searchParams }: SearchParams) {
  const sp = await searchParams;
  // SECURITY: validate `next` here (not just at /auth/callback) because the
  // browser-side LoginForm builds the magic-link redirectTo from this value.
  // safeNextPath rejects //evil.com, /\evil.com, /scheme:* — see helper.
  const nextPath = safeNextPath(typeof sp.next === 'string' ? sp.next : null, '/');
  const error = typeof sp.error === 'string' ? sp.error : null;
  const sent = sp.sent === '1';

  if (!hasPublicSupabaseConfig()) {
    return (
      <main className="mx-auto max-w-lg p-8">
        <Card title="Auth not configured">
          <p className="text-sm text-slate-700">
            Set <code>NEXT_PUBLIC_SUPABASE_URL</code> and{' '}
            <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in env vars before signing in.
          </p>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg space-y-4 p-8">
      <Card title="Sign in">
        <p className="mb-3 text-sm text-slate-600">
          Enter your email to receive a magic-link sign-in. Only addresses listed in{' '}
          <code>ADMIN_EMAILS</code> will succeed.
        </p>
        <div className="mb-3 flex flex-wrap gap-1">
          <Pill tone="paper">PAPER ONLY</Pill>
          <Pill tone={env.adminEmails.length > 0 ? 'success' : 'danger'}>
            {env.adminEmails.length > 0 ? `${env.adminEmails.length} admin email(s) configured` : 'No ADMIN_EMAILS set'}
          </Pill>
        </div>
        {env.adminEmails.length === 0 ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <strong>Dashboard is currently disabled.</strong> No{' '}
            <code>ADMIN_EMAILS</code> are configured for this deployment, so
            every authenticated session is rejected by the middleware. Set the{' '}
            <code>ADMIN_EMAILS</code> env var (comma-separated) to a list of
            allowed addresses and redeploy. Until then, sign-in will succeed at
            the magic-link step but bounce back here on the next request.
          </div>
        ) : null}
        {error === 'forbidden' ? (
          <div className="mb-3 rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-900">
            <strong>Not authorized.</strong> The signed-in account is not in the
            <code> ADMIN_EMAILS</code> allowlist for this deployment. Sign out
            and request access from the operator, or sign in with an authorized
            address.
          </div>
        ) : null}
        {error === 'missing_code' || error === 'exchange_failed' ? (
          <div className="mb-3 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
            <strong>Magic-link sign-in failed.</strong> The link may be expired
            or already consumed. Request a fresh one below.
          </div>
        ) : null}
        {sent ? (
          <div className="mb-3 rounded-md border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900">
            Magic link sent. Check your inbox.
          </div>
        ) : null}
        <LoginForm nextPath={nextPath} />
      </Card>
    </main>
  );
}
