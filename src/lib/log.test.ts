import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _redactForTests, errorFields, logError, logInfo, logWarn } from './log';

describe('redact', () => {
  it('passes primitives through', () => {
    expect(_redactForTests('hi')).toBe('hi');
    expect(_redactForTests(42)).toBe(42);
    expect(_redactForTests(false)).toBe(false);
    expect(_redactForTests(null)).toBe(null);
  });

  it('redacts top-level secret-like keys', () => {
    const out = _redactForTests({ ok: 1, token: 'xyz', api_key: 'abc', secret: 's' }) as Record<string, unknown>;
    expect(out.ok).toBe(1);
    expect(out.token).toBe('<redacted>');
    expect(out.api_key).toBe('<redacted>');
    expect(out.secret).toBe('<redacted>');
  });

  it('redacts nested secret-like keys', () => {
    const out = _redactForTests({ a: { b: { authorization: 'Bearer xyz' } } }) as Record<string, Record<string, Record<string, unknown>>>;
    expect(out.a.b.authorization).toBe('<redacted>');
  });

  it('does not redact non-secret keys with similar text', () => {
    const out = _redactForTests({ message: 'token expired', count: 3 }) as Record<string, unknown>;
    expect(out.message).toBe('token expired');
    expect(out.count).toBe(3);
  });

  it('truncates arrays to 100 entries', () => {
    const big = Array.from({ length: 150 }, (_, i) => i);
    const out = _redactForTests(big) as number[];
    expect(out.length).toBe(100);
  });

  it('caps nesting depth', () => {
    let nested: unknown = 'leaf';
    for (let i = 0; i < 10; i += 1) nested = { inner: nested };
    const out = JSON.stringify(_redactForTests(nested));
    expect(out).toContain('<truncated>');
  });
});

describe('logger emit', () => {
  let infoSpy: ReturnType<typeof vi.spyOn>;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    infoSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits info as a single JSON line on console.log', () => {
    logInfo('demo_event', { foo: 'bar' });
    expect(infoSpy).toHaveBeenCalledTimes(1);
    const call = infoSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.level).toBe('info');
    expect(parsed.event).toBe('demo_event');
    expect(parsed.foo).toBe('bar');
    expect(typeof parsed.time).toBe('string');
  });

  it('warn -> console.warn', () => {
    logWarn('uhoh', {});
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('error -> console.error and redacts secret-like fields', () => {
    logError('boom', { token: 'abc', message: 'msg' });
    const call = errSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(call);
    expect(parsed.level).toBe('error');
    expect(parsed.token).toBe('<redacted>');
    expect(parsed.message).toBe('msg');
  });
});

describe('errorFields', () => {
  it('extracts name + message', () => {
    const e = new Error('whoops');
    const f = errorFields(e);
    expect(f.errorName).toBe('Error');
    expect(f.errorMessage).toBe('whoops');
  });

  it('handles non-error values', () => {
    expect(errorFields('plain')).toEqual({ errorMessage: 'plain' });
    expect(errorFields(42)).toEqual({ errorMessage: '42' });
  });
});
