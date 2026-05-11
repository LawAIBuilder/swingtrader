import { z } from 'zod';

export const AnalysisSchema = z.object({
  tier: z.enum(['BUY', 'PASS', 'AVOID']),
  thesis: z.string().min(20).max(500),
  selloff_type: z.enum(['earnings', 'offering', 'downgrade', 'guidance', 'sector', 'macro', 'technical', 'unknown']),
  day_of_drop: z.number().int().min(1).max(10),
  invalidation_reason: z.string().min(10).max(200),
  risk_flags: z.array(z.string()),
  confidence_in_tier: z.enum(['high', 'medium', 'low'])
});

export type AnalysisOutput = z.infer<typeof AnalysisSchema>;
