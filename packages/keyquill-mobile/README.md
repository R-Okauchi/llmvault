# keyquill-mobile

**Bring Your Own Key on mobile — a Capacitor plugin that keeps LLM API keys in iOS Keychain / Android Keystore and calls providers directly from native code.**

> ## Note: parallel track with `keyquill-extension@1.0+`
>
> `keyquill-extension` has moved to a v1.0 **policy broker** architecture
> (model catalogue with capability tags, `KeyPolicy` with allowlist /
> denylist / budgets in USD, resolver pipeline, audit ledger, capability-
> first SDK). `keyquill-mobile` pre-dates that work and currently ships
> its own, earlier `RelayPolicy` surface (provider-hostname allowlist,
> budgets in microunits, biometric gating) — a **different policy model**
> with different wire shape (`chatStream({ provider, messages, systemPrompt, maxTokens })`).
>
> Unifying mobile onto the broker is tracked as a future arc; it is
> **explicitly out of scope** for the v1.0 extension release. Today,
> mobile is a fully-functional product on its own but is not a broker
> peer.

```
┌──────────────────────────────────────────────┐
│                 Your App                      │
│                                                │
│  WebView (Capacitor)    ◄─── JS bridge ───┐    │
└──────────────────────────────────────────│────┘
                                            │
                                  ┌─────────▼──────────┐
                                  │ keyquill-mobile    │
                                  │ (native plugin)    │
                                  │                    │
                                  │ - Keychain/Keystore│
                                  │ - Biometric gate   │
                                  │ - Policy engine    │
                                  │ - Direct HTTPS ────┼──► OpenAI / Anthropic / ...
                                  └────────────────────┘
```

- **Keys never cross the JS bridge** (except during `registerKey`, and only once).
- **Biometric auth** (Face ID / Touch ID / fingerprint) required before key access.
- **Policy engine**: provider allowlist, per-request token cap, daily cost cap, HTTPS-only.
- **E2E pairable**: `acceptPairing()` hands off session-encrypted AI requests from a PC browser via [`keyquill-relay`](../keyquill-relay).

## Install

```bash
pnpm add keyquill-mobile
npx cap sync
```

iOS requires deployment target ≥ 14.0. Android requires compileSdk ≥ 34.

## Usage

```ts
import { SecureRelay } from "keyquill-mobile";

// Register a provider key (the only time the key crosses the bridge).
await SecureRelay.registerKey({
  provider: "openai",
  apiKey: "sk-...",
  baseUrl: "https://api.openai.com/v1",
  defaultModel: "gpt-4o",
});

// Stream a chat completion — native side decrypts key, calls provider directly.
const { streamId } = await SecureRelay.chatStream({
  provider: "openai",
  messages: [{ role: "user", content: "Hello" }],
  systemPrompt: "",
});

SecureRelay.addListener("relayStreamEvent", (event) => {
  if (event.type === "delta") console.log(event.text);
});
```

## Policy configuration

```ts
import { SecureRelay, defaultPolicy } from "keyquill-mobile";

await SecureRelay.updatePolicy({
  policy: {
    ...defaultPolicy,
    allowedProviders: [
      { provider: "openai", baseUrl: "https://api.openai.com/v1" },
      { provider: "anthropic", baseUrl: "https://api.anthropic.com/v1" },
    ],
    maxTokensPerRequest: 8192,
    dailyBudgetUsd: 5,
    biometricRequiredForHighCost: true,
  },
});
```

## Phone Wallet Relay integration

```ts
// After the user scans a pairing QR from their PC browser:
const { sessionId } = await SecureRelay.acceptPairing({
  pairingToken,
  relayUrl: "wss://relay.example.com/relay",
  peerPublicKey,
});
```

## Screen-capture protection

```ts
// Android: blocks screenshots/screen-recording of the current Activity.
// iOS: no-op (WKWebView doesn't expose per-screen screenshot block).
await SecureRelay.setScreenSecure({ enabled: true });
```

## Security properties

- Keys stored in iOS Keychain (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) / Android Keystore (TEE-backed when available).
- Symmetric encryption for key material at rest (hardware-backed).
- Biometric authentication required before decrypting the key.
- Logs never contain tokens, keys, or credentials.

## License

MIT
