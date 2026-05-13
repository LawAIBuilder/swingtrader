import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each test reloads the module so env.cronSecret / env.allowUnauthenticatedCron
// are recomputed from the test's process.env state.
async function loadAuth() {
  vi.resetModules();
  return import('./_auth');
}

function reqWith(headers: Record<string, string>): import('next/server').NextRequest {
  return {
    headers: {
      get(name: string): string | null {
        return headers[name.toLowerCase()] ?? null;
      }
    }
  } as unknown as import('next/server').NextRequest;
}

describe('isAuthorizedCron', () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_UNAUTHENTICATED_CRON;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_UNAUTHENTICATED_CRON;
  });

  it('FAIL CLOSED by default when CRON_SECRET is unset', async () => {
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({}))).toBe(false);
  });

  it('opens up only when ALLOW_UNAUTHENTICATED_CRON=true and CRON_SECRET is unset', async () => {
    process.env.ALLOW_UNAUTHENTICATED_CRON = 'true';
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({}))).toBe(true);
  });

  it('rejects bad bearer when secret is set', async () => {
    process.env.CRON_SECRET = 'good-secret-123';
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({ authorization: 'Bearer wrong' }))).toBe(false);
  });

  it('accepts good Authorization: Bearer', async () => {
    process.env.CRON_SECRET = 'good-secret-123';
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({ authorization: 'Bearer good-secret-123' }))).toBe(true);
  });

  it('accepts the legacy x-cron-secret header', async () => {
    process.env.CRON_SECRET = 'good-secret-123';
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({ 'x-cron-secret': 'good-secret-123' }))).toBe(true);
  });

  it('ignores ALLOW_UNAUTHENTICATED_CRON when CRON_SECRET is set', async () => {
    // ALLOW_UNAUTHENTICATED_CRON is the unset-secret escape hatch only. When
    // a secret IS set, an unauthenticated request must still fail.
    process.env.CRON_SECRET = 'good-secret-123';
    process.env.ALLOW_UNAUTHENTICATED_CRON = 'true';
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({}))).toBe(false);
  });

  it('rejects same-length-but-wrong secret in constant time', async () => {
    process.env.CRON_SECRET = 'aaaaaaaaaaaaa';
    const { isAuthorizedCron } = await loadAuth();
    expect(isAuthorizedCron(reqWith({ authorization: 'Bearer bbbbbbbbbbbbb' }))).toBe(false);
  });
});

describe('unauthorizedResponse', () => {
  beforeEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_UNAUTHENTICATED_CRON;
  });
  afterEach(() => {
    delete process.env.CRON_SECRET;
    delete process.env.ALLOW_UNAUTHENTICATED_CRON;
  });

  it('says cron_secret_required when secret is unset', async () => {
    const { unauthorizedResponse } = await loadAuth();
    const r = unauthorizedResponse();
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('cron_secret_required');
  });

  it('says Unauthorized when secret is set but request was bad', async () => {
    process.env.CRON_SECRET = 'good';
    const { unauthorizedResponse } = await loadAuth();
    const r = unauthorizedResponse();
    expect(r.status).toBe(401);
    const body = await r.json();
    expect(body.error).toBe('Unauthorized');
  });
});
