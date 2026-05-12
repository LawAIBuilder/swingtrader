import { describe, expect, it } from 'vitest';
import { safeNextPath } from './safe-next';

describe('safeNextPath', () => {
  it('returns fallback for missing/empty input', () => {
    expect(safeNextPath(undefined)).toBe('/');
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
  });

  it('returns fallback for absolute URLs', () => {
    expect(safeNextPath('https://evil.com')).toBe('/');
    expect(safeNextPath('http://evil.com/path')).toBe('/');
  });

  it('returns fallback for protocol-relative URLs (// open redirect)', () => {
    expect(safeNextPath('//evil.com')).toBe('/');
    expect(safeNextPath('//evil.com/path')).toBe('/');
  });

  it('returns fallback for backslash-prefixed paths some browsers treat as scheme-relative', () => {
    expect(safeNextPath('/\\evil.com')).toBe('/');
  });

  it('returns fallback for percent-encoded slash that decodes to // after URL parsing', () => {
    expect(safeNextPath('/%2Fevil.com')).toBe('/');
    expect(safeNextPath('/%2fevil.com')).toBe('/');
  });

  it('returns fallback for paths that hide a scheme (javascript:, data:)', () => {
    expect(safeNextPath('/javascript:alert(1)')).toBe('/');
    expect(safeNextPath('/data:text/html,<script>')).toBe('/');
  });

  it('returns fallback for paths missing leading slash', () => {
    expect(safeNextPath('evil.com')).toBe('/');
    expect(safeNextPath('relative/path')).toBe('/');
  });

  it('preserves legitimate absolute paths', () => {
    expect(safeNextPath('/')).toBe('/');
    expect(safeNextPath('/dashboard')).toBe('/dashboard');
    expect(safeNextPath('/trades/123')).toBe('/trades/123');
    expect(safeNextPath('/trades?id=1&q=foo')).toBe('/trades?id=1&q=foo');
  });

  it('respects a non-default fallback', () => {
    expect(safeNextPath(undefined, '/login')).toBe('/login');
    expect(safeNextPath('//evil.com', '/login')).toBe('/login');
  });
});
