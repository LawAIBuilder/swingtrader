import { describe, expect, it } from 'vitest';
import {
  entryKeyForIntradayTrade,
  entryKeyForPaperTrade,
  exitKeyForIntradayTrade,
  exitKeyForPaperTrade
} from './idempotency';

describe('broker idempotency keys', () => {
  it('produces stable, scoped keys', () => {
    expect(entryKeyForPaperTrade(7)).toBe('bt:pt:7:entry');
    expect(exitKeyForPaperTrade(7, 'target')).toBe('bt:pt:7:exit:target');
    expect(entryKeyForIntradayTrade(7)).toBe('bt:it:7:entry');
    expect(exitKeyForIntradayTrade(7, 'stop')).toBe('bt:it:7:exit:stop');
  });

  it('separates paper and intraday namespaces', () => {
    expect(entryKeyForPaperTrade(1)).not.toBe(entryKeyForIntradayTrade(1));
  });

  it('separates entry and exit namespaces', () => {
    expect(entryKeyForPaperTrade(1)).not.toBe(exitKeyForPaperTrade(1, 'stop'));
  });
});
