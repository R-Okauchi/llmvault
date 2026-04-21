# ADR-002: Mobile Native BYOK via iOS Keychain / Android Keystore

## Status

Accepted.

## Context

On mobile, the OS exposes key-storage primitives that are hardware-backed where available and strictly isolated from the WebView / JS runtime: **iOS Keychain** and **Android Keystore**. These give stronger guarantees than anything a web page or cross-platform JS layer can offer.

Goal: keep LLM API keys out of the JavaScript bridge, out of `SharedPreferences` / `NSUserDefaults` / WebView storage, and off the network once registered.

## Decision

Ship `llmvault-mobile`, a Capacitor plugin with the following properties.

### Storage

- Keys are encrypted and written to **iOS Keychain** (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`) / **Android Keystore**.
- A hardware-bound master key wraps the per-provider key material.
- On Android, the master key is configured with `setUserAuthenticationRequired(true)` and a 300-second validity window, mirroring iOS's `LATouchIDAuthenticationMaximumAllowableReuseDuration`.

### Access

- **Biometric authentication** (Face ID / Touch ID / fingerprint) is required before each decrypt.
- The only time plaintext key material crosses the JS bridge is during `registerKey` — the native side persists it immediately and zeroes the incoming buffer.

### Outbound calls

- `chat` / `chatStream` run entirely in native code: fetch ciphertext, prompt biometric, decrypt, call the provider over HTTPS, stream bytes back to the WebView via Capacitor events.
- Providers are restricted to an **HTTPS-only allowlist**. Plain HTTP, private-IP targets, and non-allowlisted hosts are rejected.

### Policy engine

- Per-provider base-URL allowlist.
- Per-request `max_tokens` cap.
- Daily and monthly USD budgets.
- Optional "require biometric for high-cost requests" flag.
- Screen-capture protection (Android `WindowManager.FLAG_SECURE`) toggleable per screen; iOS no-op (WKWebView does not expose per-screen blocking).

## Consequences

Positive:

- Keys never exist outside the secure-enclave boundary except during `registerKey` (and only transiently in RAM).
- Biometric gate adds a physical security layer beyond OS unlock.
- Policy engine prevents runaway spend and SSRF-style misuse even if the WebView is compromised.
- App operators cannot see keys; neither can consuming SDKs.

Negative:

- Capacitor bridge streaming has slightly higher latency than direct browser SSE.
- Hardware-backed Keystore is not guaranteed on all Android devices; on software-only devices the guarantees degrade to OS-level isolation.
- Root / jailbreak invalidates the Keystore / Secure Enclave boundary; detection is deliberately out of scope — the enclave is the authoritative defence, and jailbroken devices forfeit that guarantee.
- Requires distribution through App Store / Play Store.

## Cross-reference

Biometric prompts on Android require a foreground `FragmentActivity` on the UI thread. If an AI request arrives while the app is backgrounded and the Keystore validity window has expired, the prompt cannot be surfaced and the request times out. This has implications for ADR-003 (Phone Wallet Relay) — the phone app must be in the foreground while a relay session is active. See ADR-003 for details.

## Alternatives considered

- **WebCrypto / Service Worker on mobile web**: same trust boundary as the page; no real isolation.
- **WASM crypto**: key material remains in page memory.
- **Per-app custom KDF + `localStorage`**: derivable from page JS; gives no meaningful protection.

## Pointers

- Plugin: [`packages/llmvault-mobile`](../../packages/llmvault-mobile)
- iOS sources: `packages/llmvault-mobile/ios/Sources/SecureRelayPlugin/`
- Android sources: `packages/llmvault-mobile/android/src/main/java/io/llmvault/mobile/`
