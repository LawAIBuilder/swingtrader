// Anthropic public pricing snapshot (USD per 1M tokens). Source values are
// model-specific and change occasionally; treat the output here as an
// estimate, not a billing source of truth. Update when Anthropic re-prices.
//
// We deliberately don't reach the network to fetch live pricing — that would
// add a second auth surface and a startup dependency. The dashboard surfaces
// "estimated_cost_usd" with that wording.

interface PriceTable {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
}

const DEFAULT_PRICE: PriceTable = {
  // Sonnet-class default. ~$3 in / $15 out per M tokens.
  inputUsdPerMillion: 3,
  outputUsdPerMillion: 15
};

const MODEL_PRICES: Record<string, PriceTable> = {
  'claude-sonnet-4-6': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  'claude-3-5-sonnet-latest': { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
  'claude-3-5-haiku-latest': { inputUsdPerMillion: 0.8, outputUsdPerMillion: 4 },
  'claude-3-opus-latest': { inputUsdPerMillion: 15, outputUsdPerMillion: 75 }
};

export function priceFor(model: string): PriceTable {
  return MODEL_PRICES[model] ?? DEFAULT_PRICE;
}

export function estimateCostUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = priceFor(model);
  const usd =
    (inputTokens / 1_000_000) * price.inputUsdPerMillion +
    (outputTokens / 1_000_000) * price.outputUsdPerMillion;
  return Math.round(usd * 1_000_000) / 1_000_000;
}
