// Validates a "next" path passed via query string for post-auth redirects.
//
// Rules:
//  * Must start with a single forward slash, so it's a same-origin path.
//  * Must NOT start with "//" or "/\" (protocol-relative open redirect:
//    new URL('//evil.com', origin) resolves to https://evil.com/).
//  * Must NOT contain a colon-scheme prefix (javascript:, data:, etc.).
//  * Falls back to the provided default (default '/') when the input is
//    missing, empty, or fails any of the above.
//
// We deliberately don't try to canonicalize the path or normalize "..", because
// Next.js path-based routing does not interpret them — but we do reject
// suspicious inputs early so log lines stay clean.
export function safeNextPath(input: string | null | undefined, fallback: string = '/'): string {
  if (typeof input !== 'string' || input.length === 0) return fallback;
  if (!input.startsWith('/')) return fallback;
  if (input.startsWith('//')) return fallback;
  if (input.startsWith('/\\')) return fallback;
  if (input.startsWith('/%2F') || input.startsWith('/%2f')) return fallback;
  if (/^\/[a-z][a-z0-9+.-]*:/i.test(input)) return fallback;
  return input;
}
