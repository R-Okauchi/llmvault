/** Default provider allowlist for the relay policy engine. */
export const DEFAULT_PROVIDER_ALLOWLIST = [
  { hostPattern: "api.openai.com", httpsOnly: true as const },
  { hostPattern: "api.anthropic.com", httpsOnly: true as const },
  { hostPattern: "api.groq.com", httpsOnly: true as const },
  { hostPattern: "generativelanguage.googleapis.com", httpsOnly: true as const },
  { hostPattern: "api.mistral.ai", httpsOnly: true as const },
];

/** Private IP ranges to block (RFC 1918, loopback, link-local). */
export const PRIVATE_IP_PATTERNS = [
  /^10\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^127\./,
  /^0\./,
  /^169\.254\./,
  /^::1$/,
  /^fd/i,
  /^fc/i,
  /^fe80:/i,
];

/**
 * Rough cost estimation per 1K tokens (in microunits = 1/1,000,000 USD).
 * These are conservative estimates; actual pricing varies by provider/model.
 */
export const COST_PER_1K_TOKENS: Record<string, { prompt: number; completion: number }> = {
  "gpt-4o": { prompt: 2500, completion: 10000 },
  "gpt-4o-mini": { prompt: 150, completion: 600 },
  "gpt-4-turbo": { prompt: 10000, completion: 30000 },
  "claude-sonnet-4-20250514": { prompt: 3000, completion: 15000 },
  "claude-haiku-4-20250414": { prompt: 800, completion: 4000 },
  default: { prompt: 3000, completion: 15000 },
};
