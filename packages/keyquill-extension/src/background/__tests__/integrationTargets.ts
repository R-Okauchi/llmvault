/**
 * Catalog of provider×model×env combinations that the live-API integration
 * suite exercises. Also consumed by the unit-level coverage guard in
 * providerFetch.test.ts so a new preset can't silently land without
 * integration coverage.
 */

export interface Target {
  id: string;
  env: string;
  baseUrl: string;
  chatModels: string[];
  /**
   * Pro/reasoning models under tight max_output_tokens return empty
   * content with finish_reason=length — still a successful request.
   */
  expectEmptyContentFor?: RegExp;
}

export const INTEGRATION_TARGETS: Target[] = [
  {
    id: "openai",
    env: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    chatModels: [
      "gpt-5.4-mini",
      "gpt-5-mini",
      "gpt-4o-mini",
      "o3-mini",
      "gpt-5.4-pro",
    ],
    expectEmptyContentFor: /pro$/,
  },
  {
    id: "anthropic",
    env: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    chatModels: ["claude-sonnet-4-6", "claude-haiku-4-5"],
  },
  {
    id: "groq",
    env: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    chatModels: ["llama-3.3-70b-versatile"],
  },
  {
    id: "deepseek",
    env: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    chatModels: ["deepseek-chat"],
  },
  {
    id: "mistral",
    env: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    chatModels: ["mistral-small-latest"],
  },
  {
    id: "together",
    env: "TOGETHER_API_KEY",
    baseUrl: "https://api.together.xyz/v1",
    chatModels: ["meta-llama/Llama-3.3-70B-Instruct-Turbo"],
  },
  {
    id: "xai",
    env: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    chatModels: ["grok-4-1-fast-non-reasoning"],
  },
  {
    id: "gemini",
    env: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    chatModels: ["gemini-2.5-flash"],
  },
  {
    id: "openrouter",
    env: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    chatModels: ["openrouter/auto"],
  },
];
