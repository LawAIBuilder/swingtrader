import Anthropic from '@anthropic-ai/sdk';
import pLimit from 'p-limit';
import { env } from '@/lib/env';
import type { CatalystEvidence } from '@/lib/catalysts/evidence';
import { buildAnalysisPrompt } from './prompt';
import { estimateCostUsd } from './pricing';
import { AnalysisSchema, type AnalysisOutput } from './schema';

// Single shared cap for concurrent Anthropic calls. The screener loop is
// currently sequential, so this is effectively a no-op at one-call-at-a-time;
// it exists so any future parallelization (e.g. parallel candidate processing
// in PR 3) cannot exceed env.anthropicConcurrency without additional work.
let cachedAnthropicLimit: ReturnType<typeof pLimit> | null = null;
function getAnthropicLimit() {
  if (!cachedAnthropicLimit) cachedAnthropicLimit = pLimit(env.anthropicConcurrency);
  return cachedAnthropicLimit;
}

let cachedClient: Anthropic | null = null;
function getAnthropicClient(): Anthropic {
  if (cachedClient) return cachedClient;
  cachedClient = new Anthropic({
    apiKey: env.anthropicApiKey,
    timeout: env.anthropicTimeoutMs,
    maxRetries: 0
  });
  return cachedClient;
}

export interface AnalysisResult {
  output: AnalysisOutput;
  rawResponse: string;
  schemaValid: boolean;
  retryCount: number;
  tokensUsed: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedCostUsd: number | null;
  modelName: string;
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced?.[1]) return fenced[1].trim();
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first >= 0 && last > first) return trimmed.slice(first, last + 1);
  return trimmed;
}

function fallbackAnalysis(reason: string): AnalysisOutput {
  return {
    tier: 'PASS',
    thesis: `Analysis unavailable or invalid: ${reason}. Treat as PASS until reviewed manually.`,
    selloff_type: 'unknown',
    day_of_drop: 1,
    invalidation_reason: 'Analyzer failed, so no qualitative invalidation reason is trusted.',
    risk_flags: ['analysis_failed'],
    confidence_in_tier: 'low'
  };
}

function mockAnalysis(evidence: CatalystEvidence): AnalysisOutput {
  const text = evidence.news.map((n) => `${n.title} ${n.description ?? ''}`).join(' ').toLowerCase();
  if (text.includes('offering') || text.includes('dilution') || text.includes('convertible')) {
    return {
      tier: 'AVOID',
      thesis: 'Mock analyzer detected financing or dilution language in the recent news packet.',
      selloff_type: 'offering',
      day_of_drop: 1,
      invalidation_reason: 'Dilution-related selloffs are excluded in the MVP risk rules.',
      risk_flags: ['mock_ai', 'possible_dilution'],
      confidence_in_tier: 'medium'
    };
  }
  if (evidence.candidate.relVolume > 2 && evidence.candidate.pctChange <= -8) {
    return {
      tier: 'BUY',
      thesis: 'Mock analyzer sees a high-volume selloff without obvious impairment language in the supplied news.',
      selloff_type: text.includes('sector') ? 'sector' : 'technical',
      day_of_drop: 1,
      invalidation_reason: 'If the stock continues below the signal-day low, the bounce thesis weakens.',
      risk_flags: ['mock_ai'],
      confidence_in_tier: 'low'
    };
  }
  return {
    tier: 'PASS',
    thesis: 'Mock analyzer sees an incomplete or only moderate bounce setup based on the evidence packet.',
    selloff_type: 'unknown',
    day_of_drop: 1,
    invalidation_reason: 'Insufficient catalyst clarity to support a stronger paper signal.',
    risk_flags: ['mock_ai'],
    confidence_in_tier: 'low'
  };
}

export async function analyzeWithClaude(evidence: CatalystEvidence): Promise<AnalysisResult> {
  const modelName = env.anthropicModel;

  if (env.useMockAi || !env.anthropicApiKey) {
    const output = mockAnalysis(evidence);
    return {
      output,
      rawResponse: JSON.stringify(output),
      schemaValid: true,
      retryCount: 0,
      tokensUsed: null,
      inputTokens: null,
      outputTokens: null,
      estimatedCostUsd: null,
      modelName: 'mock-ai'
    };
  }

  const client = getAnthropicClient();
  const limit = getAnthropicLimit();
  const prompt = buildAnalysisPrompt(evidence);
  let lastRaw = '';
  let lastReason = 'unknown';
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const message = await limit(() => client.messages.create({
      model: modelName,
      max_tokens: 800,
      temperature: 0,
      system: 'You are a strict JSON-output trading-research classifier. You do not provide investment advice and you never place trades.',
      messages: [
        {
          role: 'user',
          content: attempt === 0 ? prompt : `${prompt}\n\nYour prior response failed JSON validation. Return ONLY the JSON object, with no commentary.`
        }
      ]
    }));

    inputTokensTotal += message.usage?.input_tokens ?? 0;
    outputTokensTotal += message.usage?.output_tokens ?? 0;
    lastRaw = message.content
      .map((block) => (block.type === 'text' ? block.text : ''))
      .join('\n')
      .trim();

    try {
      const jsonText = extractJson(lastRaw);
      const parsed = JSON.parse(jsonText) as unknown;
      const output = AnalysisSchema.parse(parsed);
      const tokensUsed = inputTokensTotal + outputTokensTotal;
      return {
        output,
        rawResponse: lastRaw,
        schemaValid: true,
        retryCount: attempt,
        tokensUsed,
        inputTokens: inputTokensTotal,
        outputTokens: outputTokensTotal,
        estimatedCostUsd: estimateCostUsd(modelName, inputTokensTotal, outputTokensTotal),
        modelName
      };
    } catch (err) {
      lastReason = err instanceof Error ? err.message : String(err);
    }
  }

  const output = fallbackAnalysis(lastReason);
  const tokensUsed = inputTokensTotal + outputTokensTotal;
  return {
    output,
    rawResponse: lastRaw || JSON.stringify(output),
    schemaValid: false,
    retryCount: 1,
    tokensUsed,
    inputTokens: inputTokensTotal,
    outputTokens: outputTokensTotal,
    estimatedCostUsd: estimateCostUsd(modelName, inputTokensTotal, outputTokensTotal),
    modelName
  };
}

export function syntheticAnalysisForDisposition(disposition: 'AVOID' | 'BLACKOUT', reasons: string[]): AnalysisResult {
  const output: AnalysisOutput = {
    tier: 'AVOID',
    thesis: disposition === 'BLACKOUT'
      ? 'Pre-flag rules placed this ticker in an earnings blackout. It is tracked but not eligible for trading.'
      : 'Pre-flag rules found a high-risk catalyst. It is tracked as AVOID without spending an AI call.',
    selloff_type: reasons.some((r) => r.includes('offering')) ? 'offering' : 'unknown',
    day_of_drop: 1,
    invalidation_reason: 'Pre-flag exclusion takes precedence over qualitative analysis.',
    risk_flags: [disposition.toLowerCase(), ...reasons],
    confidence_in_tier: 'high'
  };
  return {
    output,
    rawResponse: JSON.stringify(output),
    schemaValid: true,
    retryCount: 0,
    tokensUsed: 0,
    inputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    modelName: 'preflag-rules'
  };
}
