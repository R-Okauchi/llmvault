/**
 * Built-in provider presets.
 *
 * Each preset encodes:
 * - `id`: stable identifier stored as `KeyRecord.provider`. `"anthropic"`
 *   routes through the Anthropic Messages API in `providerFetch.ts`; every
 *   other id falls through to the OpenAI-compatible passthrough (works for
 *   OpenAI itself, Google Gemini's OpenAI-compat endpoint, Groq, DeepSeek,
 *   Mistral, Together AI, xAI, OpenRouter, and arbitrary custom endpoints).
 * - `label`: UI string shown in the add-key dropdown and in KeyCards.
 * - `baseUrl`: provider HTTPS base. The extension appends `/chat/completions`
 *   or `/messages` depending on API shape.
 * - `defaultModel`: a safe starting model — user can override inline.
 * - `models`: curated suggestion list surfaced in the popup as a
 *   `<datalist>` — the model input is a combobox, so any string is still
 *   accepted. Keep this list current: first entry should be the default,
 *   then flagship, then common variants.
 *
 * Base URLs and default models verified against each vendor's public docs
 * as of April 2026.
 */

export interface Preset {
  id: string;
  label: string;
  baseUrl: string;
  defaultModel: string;
  /**
   * Suggestion list shown in the model combobox after this provider is
   * selected. Empty for `custom` (user knows their endpoint).
   */
  models: string[];
}

export const PRESETS: Preset[] = [
  {
    id: "openai",
    label: "OpenAI",
    baseUrl: "https://api.openai.com/v1",
    // GPT-5.4-mini is the cost-balanced active default in the OpenAI API
    // as of 2026-04; the legacy gpt-4.1-mini was retired along with the
    // rest of the GPT-4 family.
    defaultModel: "gpt-5.4-mini",
    models: [
      "gpt-5.4-mini",
      "gpt-5.4",
      "gpt-5.4-pro",
      "gpt-5.4-nano",
      "gpt-5.4-thinking",
      "gpt-5-mini",
      "gpt-5",
      "gpt-5-pro",
      "o4-mini",
      "o3-mini",
      "o3",
      "o3-pro",
      "gpt-4o-mini",
      "gpt-4o",
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    defaultModel: "claude-sonnet-4-6",
    models: ["claude-sonnet-4-6", "claude-haiku-4-5", "claude-opus-4-7"],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "gemini-2.5-flash",
    models: ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-2.5-flash-lite"],
  },
  {
    id: "groq",
    label: "Groq",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "llama-3.3-70b-versatile",
    models: ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    models: ["deepseek-chat", "deepseek-reasoner"],
  },
  {
    id: "mistral",
    label: "Mistral",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "mistral-small-latest",
    models: ["mistral-small-latest", "mistral-medium-latest", "mistral-large-latest"],
  },
  {
    id: "together",
    label: "Together AI",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    // Together catalogs hundreds of models; suggestions are curated to the
    // top few so the list stays scannable. Free-text input still accepts
    // any Together model id.
    models: [
      "meta-llama/Llama-3.3-70B-Instruct-Turbo",
      "meta-llama/Llama-3.1-8B-Instruct-Turbo",
      "deepseek-ai/DeepSeek-V3",
    ],
  },
  {
    id: "xai",
    label: "xAI (Grok)",
    baseUrl: "https://api.x.ai/v1",
    defaultModel: "grok-4-1-fast-non-reasoning",
    models: ["grok-4-1-fast-non-reasoning", "grok-4", "grok-4-heavy"],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openrouter/auto",
    // OpenRouter exposes thousands of models; only the router alias is
    // listed here. Users routinely type their own "vendor/model" string.
    models: ["openrouter/auto"],
  },
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    baseUrl: "",
    defaultModel: "",
    models: [],
  },
];

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find((p) => p.id === id);
}
