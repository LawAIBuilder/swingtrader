// Negation-aware keyword matcher. Used to detect things like "offering",
// "dilution", "suspended dividend" in vendor news while *not* tripping on the
// negated forms ("no offering planned", "no plans to suspend dividend"). Spec
// is deliberately small: regex per term plus a local-window scan for negation
// tokens. No NLP, no parsers.
//
// The window is character-based and intentionally narrow (default 36 chars
// preceding the match). That matches the typical clause length in headline
// English and keeps the false-positive rate low without sentence segmentation.

export interface KeywordMatch {
  term: string;
  index: number;
  snippet: string;
  negated: boolean;
}

export interface KeywordMatchResult {
  matched: boolean;
  matches: KeywordMatch[];
}

// Negation tokens checked in the window preceding each term match. Conservative
// list: only forms that would clearly invert the meaning of the matched phrase
// in financial-headline English.
const NEGATION_TOKENS: string[] = [
  'no',
  'not',
  'never',
  'without',
  'denies',
  'denied',
  'deny',
  'denying',
  'rules out',
  'ruled out',
  'ruling out',
  'rule out',
  'no plans to',
  'no plans for',
  'no intention',
  'no intent',
  "doesn't",
  'does not',
  'do not',
  "don't",
  'will not',
  "won't",
  'has not',
  'have not',
  "hasn't",
  "haven't"
];

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Single compiled negation regex, anchored to word boundaries so "no" inside
// "north" is not a negation. Multi-word phrases are intentionally checked
// without a word boundary on the right side because phrases like "no plans to"
// must still match when followed immediately by " suspend".
const NEGATION_REGEX = new RegExp(
  '(?:^|\\W)(?:' + NEGATION_TOKENS.map(escapeRegex).join('|') + ')(?:\\W|$)',
  'i'
);

export interface MatchOptions {
  windowChars?: number;
}

export function matchKeywords(haystack: string, terms: readonly string[], options: MatchOptions = {}): KeywordMatchResult {
  const windowChars = options.windowChars ?? 36;
  const lower = haystack.toLowerCase();
  const matches: KeywordMatch[] = [];

  for (const term of terms) {
    const escaped = escapeRegex(term.toLowerCase());
    // \b doesn't behave well next to non-word chars (e.g. hyphenated terms), so
    // we anchor to either string start or a non-word neighbor manually. The
    // forward anchor allows the term to be followed by a word char in
    // multi-word terms ("convertible note(s)") so we keep loose right-side
    // matching.
    const re = new RegExp('(?:^|\\W)(' + escaped + ')(?=\\W|$)', 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(lower)) !== null) {
      const matchStart = m.index + (m[0].length - m[1].length);
      const windowStart = Math.max(0, matchStart - windowChars);
      const window = lower.slice(windowStart, matchStart);
      const negated = NEGATION_REGEX.test(window);
      const snippetStart = Math.max(0, matchStart - 24);
      const snippetEnd = Math.min(haystack.length, matchStart + term.length + 24);
      matches.push({
        term,
        index: matchStart,
        snippet: haystack.slice(snippetStart, snippetEnd),
        negated
      });
    }
  }

  return {
    matched: matches.some((m) => !m.negated),
    matches
  };
}

// Convenience for the common preflag case: did the news mention any
// non-negated form of any of these terms? Returns the first non-negated
// match's term so callers can store provenance.
export function firstAffirmativeMatch(haystack: string, terms: readonly string[], options?: MatchOptions): string | null {
  const result = matchKeywords(haystack, terms, options);
  const hit = result.matches.find((m) => !m.negated);
  return hit ? hit.term : null;
}
