import { describe, expect, it } from 'vitest';
import { firstAffirmativeMatch, matchKeywords } from './match';

const offeringTerms = ['offering', 'dilution', 'convertible notes'];
const dividendTerms = ['suspends dividend', 'suspended dividend', 'dividend suspension'];

describe('matchKeywords', () => {
  it('matches a plain affirmative phrase', () => {
    const r = matchKeywords('Company prices public offering of $200M.', offeringTerms);
    expect(r.matched).toBe(true);
    expect(r.matches.find((m) => !m.negated)?.term).toBe('offering');
  });

  it('does not match when the term is preceded by a negation token in the local window', () => {
    const r = matchKeywords('CEO says there is no offering planned this year.', offeringTerms);
    expect(r.matched).toBe(false);
    expect(r.matches.every((m) => m.negated)).toBe(true);
  });

  it('does not match negated dividend suspension', () => {
    const r = matchKeywords('Company has not suspended dividend amid downturn.', dividendTerms);
    expect(r.matched).toBe(false);
  });

  it('matches affirmative dividend suspension', () => {
    const r = matchKeywords('Company suspends dividend until further notice.', dividendTerms);
    expect(r.matched).toBe(true);
  });

  it('does not let a negation in a different sentence cross over', () => {
    // Default 36-char window. The "no" here is more than 36 chars from "offering".
    const text = 'No analyst downgrades materialized this morning. Separately, the company prices a public offering today.';
    const r = matchKeywords(text, offeringTerms);
    expect(r.matched).toBe(true);
  });

  it('honors a wider window when configured', () => {
    const text = 'Company says no plans for any future offering.';
    const r = matchKeywords(text, offeringTerms, { windowChars: 50 });
    expect(r.matched).toBe(false);
  });

  it('matches multi-word terms with internal whitespace', () => {
    const r = matchKeywords('Issuer plans to offer convertible notes to fund operations.', offeringTerms);
    expect(r.matched).toBe(true);
    expect(r.matches.find((m) => !m.negated)?.term).toBe('convertible notes');
  });

  it('does not match a substring inside a larger word', () => {
    // "northern" should not trip "no" negation, and "buffering" should not match "offering".
    const r = matchKeywords('Northern team says buffering is the only issue.', offeringTerms);
    expect(r.matched).toBe(false);
    expect(r.matches).toHaveLength(0);
  });

  it('ignores case', () => {
    const r = matchKeywords('CONVERTIBLE NOTES priced today at par.', offeringTerms);
    expect(r.matched).toBe(true);
  });

  it('reports each occurrence individually', () => {
    const r = matchKeywords('First offering today, but no offering planned next quarter.', offeringTerms);
    expect(r.matches).toHaveLength(2);
    expect(r.matches[0].negated).toBe(false);
    expect(r.matches[1].negated).toBe(true);
    expect(r.matched).toBe(true);
  });
});

describe('firstAffirmativeMatch', () => {
  it('returns the first non-negated term, or null', () => {
    expect(firstAffirmativeMatch('No offering this year.', offeringTerms)).toBeNull();
    expect(firstAffirmativeMatch('Convertible notes priced today.', offeringTerms)).toBe('convertible notes');
  });
});
