Keyquill is a Bring-Your-Own-Key (BYOK) wallet for LLM APIs. You register your OpenAI, Anthropic, Gemini, or any OpenAI-compatible API key inside the extension, and approved web apps can then stream chat completions using your key — without the web app or its server ever seeing the key material.

WHAT PROBLEM IT SOLVES

Web apps that use LLM APIs normally force you to choose between:
• Letting them store your API key on their server (security risk, trust required)
• Entering your key into their page's localStorage (vulnerable to XSS)
• Not using AI features at all

Keyquill gives you a fourth option: keep the key in an isolated extension process, and let web apps request completions through a narrow, user-approved channel.

HOW IT WORKS

1. Click the Keyquill toolbar icon to open the key-management popup.
2. Add a provider (OpenAI, Anthropic, Gemini, Groq, Mistral, DeepSeek, Together, Fireworks, xAI, Ollama, or any OpenAI-compatible endpoint). Paste your API key.
3. Visit any web app that integrates the Keyquill SDK.
4. The first time that app requests access, you see a consent popup showing the origin. You approve or deny.
5. Approved apps can call for completions. The extension's service worker contacts the provider directly over HTTPS — the web page only receives the streamed response text.

SECURITY PROPERTIES

• Keys are stored in chrome.storage.session — ephemeral, cleared when the browser closes, and inaccessible to regular web-page JavaScript.
• Per-origin consent (MetaMask style): every origin that wants to use Keyquill must be explicitly approved by you via a popup. Approvals are stored in chrome.storage.local and can be revoked anytime from the extension popup.
• Key registration and deletion are only possible from the extension popup. Web pages cannot register, delete, or exfiltrate keys.
• The extension does not collect analytics, telemetry, or logs. Zero network calls other than to the LLM provider you chose.
• The extension opens no persistent connections to any Keyquill-controlled servers. There is no Keyquill backend.

WHAT'S NEW IN v1.0 — POLICY BROKER

Every request is brokered through a user-owned policy before it reaches the provider:

• Model policy: allowlist / denylist / capability-only modes. Decide which models web apps can use per key.
• Budget caps: per-request, daily, and monthly USD ceilings. Choose to block, confirm, or warn when hit.
• Privacy rules: HTTPS-only endpoints, provider allowlists, origin regex filters.
• Capability-first API: the web app declares what it needs (tool use, reasoning, long context) — your policy picks the actual model. No more apps quietly upgrading to premium models without your knowledge.
• Consent popups for policy edges: when a web app requests a model outside your allowlist or a high-cost request, a popup shows the breakdown (model, estimated cost, reason). You choose once / always / reject.
• Audit ledger: every request recorded locally with timestamp, origin, model, token usage, estimated + actual cost. Filter by origin, export to CSV. 90-day retention.
• Localized error messages (English / Japanese, auto-detected from browser UI language).

SUPPORTED PROVIDERS

Anything that speaks the OpenAI Chat Completions format works out of the box. Native translation is provided for the Anthropic Messages API.

Confirmed providers: OpenAI, Anthropic, Google Gemini, Groq, Mistral, DeepSeek, Together AI, Fireworks AI, xAI (Grok), Ollama (local), and any OpenAI-compatible endpoint.

FOR DEVELOPERS

Integrate Keyquill in your web app with the official SDK (v2 capability-first API):

    npm install keyquill

    import { Keyquill } from "keyquill";
    const vault = new Keyquill();
    if (await vault.isAvailable()) {
      await vault.connect();
      const { completion } = await vault.chat({
        messages: [{ role: "user", content: "Hello" }],
        requires: ["tool_use"],   // declare capabilities
        tone: "precise",           // abstract over temperature
        maxOutput: 1024,
      });
    }

Your app declares intent; the user's policy picks the concrete model. v1 SDK users can keep pinning keyquill@0.3.x — the extension accepts both wire shapes.

Full docs: https://github.com/R-Okauchi/keyquill

LINKS

• Live demo: https://r-okauchi.github.io/keyquill/demo/
• Source code: https://github.com/R-Okauchi/keyquill
• Privacy policy: https://r-okauchi.github.io/keyquill/privacy-policy
• Report issues: https://github.com/R-Okauchi/keyquill/issues

LICENSE

MIT. The entire extension is open source. You can audit every line of code at the GitHub repository linked above.
