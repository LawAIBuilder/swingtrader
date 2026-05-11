import { afterEach, describe, expect, it, vi } from 'vitest';
import { timedFetch } from './timed-fetch';

afterEach(() => {
  vi.restoreAllMocks();
});

// We can't reliably trip AbortSignal.timeout against a mocked fetch without
// tying ourselves to a specific runtime. Instead, simulate the abort path
// directly: when fetch sees a signal that has already aborted, it must reject
// with an AbortError. timedFetch must normalize that into a descriptive
// timeout error so callers don't get cryptic DOMException strings in logs.
describe('timedFetch', () => {
  it('normalizes AbortError into a descriptive timeout message', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    });

    await expect(timedFetch('https://example.com/x', { timeoutMs: 50 })).rejects.toThrow(/aborted after 50ms/);
  });

  it('normalizes TimeoutError the same way', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      const err = new Error('timeout');
      err.name = 'TimeoutError';
      throw err;
    });

    await expect(timedFetch('https://example.com/x', { timeoutMs: 75 })).rejects.toThrow(/aborted after 75ms/);
  });

  it('passes through unrelated errors unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('connection refused');
    });

    await expect(timedFetch('https://example.com/x', { timeoutMs: 50 })).rejects.toThrow('connection refused');
  });

  it('attaches an AbortSignal to the underlying fetch call', async () => {
    let observedSignal: AbortSignal | undefined;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      observedSignal = init?.signal as AbortSignal | undefined;
      return new Response('ok');
    });

    const res = await timedFetch('https://example.com/x', { timeoutMs: 1_000 });
    expect(res.status).toBe(200);
    expect(observedSignal).toBeDefined();
    expect(observedSignal?.aborted).toBe(false);
  });

  it('honors a caller-supplied AbortSignal in addition to the timeout', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      if (init?.signal?.aborted) {
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }
      return new Response('ok');
    });

    await expect(
      timedFetch('https://example.com/x', { timeoutMs: 5_000, signal: controller.signal })
    ).rejects.toThrow(/aborted after 5000ms/);
  });
});
