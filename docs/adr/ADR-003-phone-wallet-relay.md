# ADR-003: Phone Wallet Relay (QR Pairing for PC Browser)

## Status

Accepted.

## Context

ADR-001 covers BYOK on PC browsers via an extension. Some users cannot or prefer not to install extensions (corporate lockdowns, Chromebooks, shared computers). If those users already run the mobile wallet (ADR-002), their phone can serve as a remote wallet for the PC browser — no PC-side install required.

## Decision

Ship `llmvault-relay`: a zero-knowledge WebSocket relay that pairs a browser client with a mobile wallet and forwards end-to-end encrypted AI requests.

### Pairing flow

1. Browser calls `PhoneRelayClient.createPairing()` → generates a pairing token, an ephemeral ECDH key, and a QR payload.
2. User scans the QR with the mobile app (`SecureRelay.acceptPairing`).
3. Mobile app validates the pairing token, performs ECDH P-256 key exchange, and opens a WebSocket to the relay server.
4. Both sides derive a shared session key via HKDF-SHA-256 over the ECDH secret.
5. All subsequent messages are encrypted with AES-GCM-256 (fresh nonce per message).

### Request flow (after pairing)

```
PC Browser                 Relay Server                Phone
 (llmvault-relay/client)  (llmvault-relay/server)     (llmvault-mobile)
     │  WebSocket (E2E encrypted; server sees ciphertext only)   │
     ├────────────────────────────────────────────────────────────┤
     │                                                            │
     └─► encrypt request with session key                         │
                    └─► forwarded verbatim                        │
                                                                  ├─► decrypt
                                                                  ├─► biometric prompt
                                                                  ├─► decrypt API key
                                                                  └─► HTTPS to provider
                                                                      └─► response
                                                                  ◄─ encrypted reply
                    ◄─ forwarded verbatim
     ◄─ decrypt on PC
```

### Security properties

- API key never leaves the phone.
- Relay server sees **ciphertext only**; decryption / payload inspection are impossible without the session key.
- Pairing token is 16 bytes CSPRNG, single-use, 5-minute TTL.
- ECDH key exchange prevents MITM; optional short-code verification on both ends gives a human-checkable confirmation.
- Session expires after a configurable idle timeout (default 30 minutes).
- Phone surfaces a notification for each incoming AI request so the user can see what the PC is asking for.

### Implementation split

- [`llmvault-relay/client`](../../packages/llmvault-relay/src/client) — browser `PhoneRelayClient`.
- [`llmvault-relay/server`](../../packages/llmvault-relay/src/server) — Cloudflare Durable Object (`RelaySessionDO`) + Hono route factory (`createRelayRoutes`).
- Phone-side accept / encrypt / decrypt — native `RelaySessionHandler` in [`llmvault-mobile`](../../packages/llmvault-mobile) (Swift / Kotlin).
- Wire-protocol types — [`llmvault-relay`](../../packages/llmvault-relay/src/types.ts) root entry re-exports types only, so both ends can type-check against the same schema.

## Consequences

Positive:

- Zero-install AI on PC (assuming the user already runs the mobile wallet).
- API key never touches the PC or the relay server.
- Works on any modern browser, including Chromebooks and locked-down corporate machines.
- Reuses the existing mobile wallet infrastructure; no new key-custody path.

Negative:

- Requires the phone to be online and nearby during use.
- Higher latency than a local extension call (PC → relay → phone → LLM → phone → relay → PC).
- WebSocket relay adds server cost (minimal for text streams).
- Pairing UX is an extra step vs. an installed extension.
- Phone battery impact from keeping a WebSocket open.

Mitigations:

- Aggressive idle timeout to limit battery impact.
- Graceful degradation: if the phone disconnects, surface a "reconnect" prompt rather than a hard error.
- WebRTC DataChannel is a future optimization to bypass the relay server entirely.

## Cross-reference with ADR-002

`RelaySessionHandler` must trigger a `BiometricPrompt` when the Android Keystore validity window has expired. `BiometricPrompt` requires a `FragmentActivity` on the UI thread. If the mobile app is backgrounded when a relay request arrives, the prompt cannot be surfaced and the handler times out (default 60 s), sending an error envelope back to the PC.

**Implication:** the mobile app must be in the foreground for relay traffic to complete. UIs that advertise a "keep relay alive in the background" feature must state this constraint inline.

## Alternatives considered

- **Bluetooth / NFC pairing** — browser APIs are limited and unreliable across platforms.
- **Push-notification relay** — latency is too high for streaming responses.
- **QR-per-request (no session)** — poor UX for multi-turn chat.
