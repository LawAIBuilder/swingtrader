// Stable idempotency keys for broker orders. The shape is:
//
//   bt:<scope>:<id>:<intent>
//
// Where scope is 'pt' for paper_trades or 'it' for intraday_paper_trades,
// id is the internal trade id, and intent is 'entry' or 'exit'. This is
// short, human-readable in the broker UI, and guarantees the same logical
// order can never be assigned to two distinct internal trades.
export function entryKeyForPaperTrade(paperTradeId: number): string {
  return `bt:pt:${paperTradeId}:entry`;
}

export function exitKeyForPaperTrade(paperTradeId: number, reason: string): string {
  return `bt:pt:${paperTradeId}:exit:${reason}`;
}

export function entryKeyForIntradayTrade(intradayTradeId: number): string {
  return `bt:it:${intradayTradeId}:entry`;
}

export function exitKeyForIntradayTrade(intradayTradeId: number, reason: string): string {
  return `bt:it:${intradayTradeId}:exit:${reason}`;
}
