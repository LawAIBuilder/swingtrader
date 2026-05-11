// Wraps fetch with an AbortSignal-driven timeout. One hung vendor call must not
// stall the whole job: every external HTTP call in the codebase routes through
// timedFetch (Polygon, Alpaca; Anthropic uses its SDK's timeout option).
//
// If the caller already supplied an AbortSignal we honor it via AbortSignal.any,
// so caller-driven cancellation continues to work. The returned Response is the
// raw fetch response; the caller is responsible for reading the body.
export async function timedFetch(
  input: RequestInfo | URL,
  init: RequestInit & { timeoutMs: number }
): Promise<Response> {
  const { timeoutMs, signal: callerSignal, ...rest } = init;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await fetch(input, { ...rest, signal });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // Normalize so callers see a single, descriptive message regardless of
      // whether the abort came from the timeout or from the caller.
      throw new Error(`fetch aborted after ${timeoutMs}ms: ${input.toString()}`);
    }
    throw err;
  }
}
