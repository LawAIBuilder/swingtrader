import { describe, expect, it } from 'vitest';
import { InvalidJobInvocationError, isValidRunDate, jobErrorResponse, readJobInvocation } from './_jobRequest';
import { JobLockedError } from '@/lib/run-log';

function getReq(url: string): import('next/server').NextRequest {
  return {
    url,
    method: 'GET',
    json: async () => ({})
  } as unknown as import('next/server').NextRequest;
}

function postReq(url: string, body: unknown): import('next/server').NextRequest {
  return {
    url,
    method: 'POST',
    json: async () => body
  } as unknown as import('next/server').NextRequest;
}

describe('readJobInvocation', () => {
  it('returns no overrides for a plain GET', async () => {
    const inv = await readJobInvocation(getReq('https://x/api/jobs/screener'));
    expect(inv).toEqual({ runDate: undefined, force: false });
  });

  it('reads force=1 from the query string', async () => {
    const inv = await readJobInvocation(getReq('https://x/api/jobs/screener?force=1'));
    expect(inv.force).toBe(true);
  });

  it('reads force=true from the query string', async () => {
    const inv = await readJobInvocation(getReq('https://x/api/jobs/screener?force=true'));
    expect(inv.force).toBe(true);
  });

  it('reads runDate from the query string', async () => {
    const inv = await readJobInvocation(getReq('https://x/api/jobs/screener?runDate=2026-05-11'));
    expect(inv.runDate).toBe('2026-05-11');
  });

  it('prefers POST body runDate over the query string', async () => {
    const inv = await readJobInvocation(
      postReq('https://x/api/jobs/screener?runDate=2026-01-01', { runDate: '2026-05-11' })
    );
    expect(inv.runDate).toBe('2026-05-11');
  });

  it('reads force=true from the POST body', async () => {
    const inv = await readJobInvocation(postReq('https://x/api/jobs/screener', { force: true }));
    expect(inv.force).toBe(true);
  });

  it('does not throw on a non-JSON POST body', async () => {
    const req = {
      url: 'https://x/api/jobs/screener',
      method: 'POST',
      json: async () => {
        throw new Error('not json');
      }
    } as unknown as import('next/server').NextRequest;
    const inv = await readJobInvocation(req);
    expect(inv).toEqual({ runDate: undefined, force: false });
  });

  it('throws InvalidJobInvocationError on a malformed runDate', async () => {
    await expect(
      readJobInvocation(getReq('https://x/api/jobs/screener?runDate=2026-13-99'))
    ).rejects.toBeInstanceOf(InvalidJobInvocationError);
  });

  it('throws InvalidJobInvocationError on a non-ISO runDate format', async () => {
    await expect(
      readJobInvocation(getReq('https://x/api/jobs/screener?runDate=05/11/2026'))
    ).rejects.toBeInstanceOf(InvalidJobInvocationError);
  });
});

describe('isValidRunDate', () => {
  it('accepts canonical YYYY-MM-DD', () => {
    expect(isValidRunDate('2026-05-11')).toBe(true);
  });
  it('rejects non-canonical separators', () => {
    expect(isValidRunDate('2026/05/11')).toBe(false);
  });
  it('rejects months > 12', () => {
    expect(isValidRunDate('2026-13-01')).toBe(false);
  });
  it('rejects invalid days that JavaScript silently rolls forward', () => {
    expect(isValidRunDate('2026-02-30')).toBe(false);
  });
  it('rejects empty strings', () => {
    expect(isValidRunDate('')).toBe(false);
  });
});

describe('jobErrorResponse', () => {
  it('translates JobLockedError to a 409 with the lock metadata', async () => {
    const err = new JobLockedError('screener', '2026-05-11', 'concurrent_run_in_progress');
    const res = jobErrorResponse('screener', '2026-05-11', err);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({
      skipped: true,
      reason: 'concurrent_run_in_progress',
      jobName: 'screener',
      runDate: '2026-05-11'
    });
  });

  it('uses 500 for any other error', async () => {
    const res = jobErrorResponse('screener', '2026-05-11', new Error('boom'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('boom');
  });

  it('handles non-Error throws', async () => {
    const res = jobErrorResponse('screener', undefined, 'just a string');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('just a string');
  });

  it('translates InvalidJobInvocationError to a 400 with code+detail', async () => {
    const err = new InvalidJobInvocationError('invalid_run_date', 'runDate must be YYYY-MM-DD, got nope');
    const res = jobErrorResponse('screener', undefined, err);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_run_date');
    expect(body.detail).toContain('YYYY-MM-DD');
  });
});
