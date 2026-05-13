import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET /api/ping', () => {
  it('returns 200 ok in plain text', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toBe('ok');
  });
});
