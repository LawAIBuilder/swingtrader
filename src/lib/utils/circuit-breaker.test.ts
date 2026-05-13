import { describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitOpenError } from './circuit-breaker';

function makeBreaker(initial: number) {
  let now = initial;
  const breaker = new CircuitBreaker('test', {
    failureThreshold: 3,
    cooldownMs: 1_000,
    now: () => now
  });
  return { breaker, advance: (ms: number) => (now += ms), get now() { return now; } };
}

describe('CircuitBreaker', () => {
  it('starts closed and lets calls through', () => {
    const { breaker } = makeBreaker(0);
    expect(() => breaker.ensureCanPass()).not.toThrow();
    expect(breaker.snapshot().state).toBe('closed');
  });

  it('opens after consecutive failures and rejects calls during cooldown', () => {
    const { breaker } = makeBreaker(0);
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('closed');
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('open');
    expect(() => breaker.ensureCanPass()).toThrow(CircuitOpenError);
  });

  it('transitions to half_open after cooldown', () => {
    const { breaker, advance } = makeBreaker(0);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('open');
    advance(1500);
    expect(() => breaker.ensureCanPass()).not.toThrow();
    expect(breaker.snapshot().state).toBe('half_open');
  });

  it('half_open success closes the circuit', () => {
    const { breaker, advance } = makeBreaker(0);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1500);
    breaker.ensureCanPass();
    breaker.recordSuccess();
    expect(breaker.snapshot().state).toBe('closed');
    expect(breaker.snapshot().consecutiveFailures).toBe(0);
  });

  it('half_open failure re-opens with a fresh cooldown window', () => {
    const { breaker, advance } = makeBreaker(0);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordFailure();
    advance(1500);
    breaker.ensureCanPass();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('open');
    // Within new cooldown — should still reject.
    advance(500);
    expect(() => breaker.ensureCanPass()).toThrow(CircuitOpenError);
  });

  it('any success in closed state resets the failure counter', () => {
    const { breaker } = makeBreaker(0);
    breaker.recordFailure();
    breaker.recordFailure();
    breaker.recordSuccess();
    breaker.recordFailure();
    expect(breaker.snapshot().state).toBe('closed');
  });
});
