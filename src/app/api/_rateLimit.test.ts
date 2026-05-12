import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Reload the module per test so JOB_RATE_LIMIT_PER_MINUTE changes take effect
// and the in-memory bucket map starts empty.
async function loadModule() {
  vi.resetModules();
  const mod = await import('./_rateLimit');
  return mod;
}

function mockRequest(ip: string): { headers: { get: (name: string) => string | null } } {
  return {
    headers: {
      get(name: string) {
        if (name.toLowerCase() === 'x-forwarded-for') return ip;
        return null;
      }
    }
  };
}

describe('rateLimitOk', () => {
  beforeEach(() => {
    process.env.JOB_RATE_LIMIT_PER_MINUTE = '3';
  });
  afterEach(() => {
    delete process.env.JOB_RATE_LIMIT_PER_MINUTE;
    vi.useRealTimers();
  });

  it('allows requests up to the configured limit, then 429s', async () => {
    const { rateLimitOk, _resetRateLimitForTests } = await loadModule();
    _resetRateLimitForTests();
    const req = mockRequest('1.2.3.4') as unknown as import('next/server').NextRequest;
    expect(rateLimitOk(req)).toBe(true);
    expect(rateLimitOk(req)).toBe(true);
    expect(rateLimitOk(req)).toBe(true);
    expect(rateLimitOk(req)).toBe(false);
  });

  it('separates buckets per source IP', async () => {
    const { rateLimitOk, _resetRateLimitForTests } = await loadModule();
    _resetRateLimitForTests();
    const a = mockRequest('1.1.1.1') as unknown as import('next/server').NextRequest;
    const b = mockRequest('2.2.2.2') as unknown as import('next/server').NextRequest;
    expect(rateLimitOk(a)).toBe(true);
    expect(rateLimitOk(a)).toBe(true);
    expect(rateLimitOk(a)).toBe(true);
    expect(rateLimitOk(a)).toBe(false);
    expect(rateLimitOk(b)).toBe(true);
  });

  it('resets the window after WINDOW_MS', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const { rateLimitOk, _resetRateLimitForTests } = await loadModule();
    _resetRateLimitForTests();
    const req = mockRequest('3.3.3.3') as unknown as import('next/server').NextRequest;
    expect(rateLimitOk(req)).toBe(true);
    expect(rateLimitOk(req)).toBe(true);
    expect(rateLimitOk(req)).toBe(true);
    expect(rateLimitOk(req)).toBe(false);
    // Jump past the 60s window.
    vi.setSystemTime(new Date('2026-01-01T00:01:01Z'));
    expect(rateLimitOk(req)).toBe(true);
  });

  it('returns true when limit is 0 (rate limiting disabled)', async () => {
    process.env.JOB_RATE_LIMIT_PER_MINUTE = '0';
    const { rateLimitOk, _resetRateLimitForTests } = await loadModule();
    _resetRateLimitForTests();
    const req = mockRequest('4.4.4.4') as unknown as import('next/server').NextRequest;
    for (let i = 0; i < 100; i += 1) {
      expect(rateLimitOk(req)).toBe(true);
    }
  });

  it('uses the first hop in x-forwarded-for', async () => {
    const { rateLimitOk, _resetRateLimitForTests } = await loadModule();
    _resetRateLimitForTests();
    const reqA = {
      headers: {
        get: (n: string) => (n.toLowerCase() === 'x-forwarded-for' ? '5.5.5.5, 6.6.6.6' : null)
      }
    } as unknown as import('next/server').NextRequest;
    const reqB = {
      headers: {
        get: (n: string) => (n.toLowerCase() === 'x-forwarded-for' ? '5.5.5.5, 7.7.7.7' : null)
      }
    } as unknown as import('next/server').NextRequest;
    expect(rateLimitOk(reqA)).toBe(true);
    expect(rateLimitOk(reqA)).toBe(true);
    expect(rateLimitOk(reqB)).toBe(true);
    // Both share bucket 5.5.5.5; this is the 4th hit, so it 429s.
    expect(rateLimitOk(reqA)).toBe(false);
  });
});
