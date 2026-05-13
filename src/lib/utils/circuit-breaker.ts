// In-memory circuit breaker. Intended for short-lived process scope (one
// cron tick / one Vercel function invocation). It will not survive across
// invocations, which is by design — most of our cron functions cold-start
// per tick, and a serverless-wide breaker would need durable state we don't
// have a natural home for. The per-tick breaker still pays for itself: when
// the screener fans out hundreds of per-ticker requests, one provider going
// dark should not consume all of them in retry loops.

export type BreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerOptions {
  // Open after this many consecutive failures.
  failureThreshold: number;
  // While open, reject requests for this many ms before allowing a probe.
  cooldownMs: number;
  // Optional clock for tests.
  now?: () => number;
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  readonly name = 'CircuitOpenError';
  constructor(public readonly breakerName: string) {
    super(`Circuit '${breakerName}' is open; refusing call until cooldown elapses`);
  }
}

export class CircuitBreaker {
  private state: BreakerState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private readonly now: () => number;

  constructor(
    public readonly name: string,
    private readonly opts: CircuitBreakerOptions
  ) {
    this.now = opts.now ?? (() => Date.now());
  }

  // Throws CircuitOpenError if calls are currently rejected. Transitions
  // open → half_open after cooldown so the next call probes the service.
  ensureCanPass(): void {
    if (this.state === 'open') {
      const elapsed = this.now() - this.openedAt;
      if (elapsed < this.opts.cooldownMs) {
        throw new CircuitOpenError(this.name);
      }
      this.state = 'half_open';
    }
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = 'closed';
  }

  recordFailure(): void {
    this.consecutiveFailures += 1;
    if (this.state === 'half_open') {
      // Probe failed: re-open and restart the cooldown clock.
      this.state = 'open';
      this.openedAt = this.now();
      return;
    }
    if (this.consecutiveFailures >= this.opts.failureThreshold) {
      this.state = 'open';
      this.openedAt = this.now();
    }
  }

  // For tests / health endpoints.
  snapshot(): { state: BreakerState; consecutiveFailures: number; openedAt: number } {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt
    };
  }

  // Test-only.
  reset(): void {
    this.state = 'closed';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
  }
}
