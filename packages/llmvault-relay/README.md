# llmvault-relay

**Zero-knowledge E2E-encrypted WebSocket relay for pairing a PC browser with a mobile LLM wallet.**

When the mobile app holds the LLM API keys (via [`llmvault-mobile`](../llmvault-mobile)) and the user wants to use those keys from a PC browser, `llmvault-relay` provides a secure bridge:

```
 PC browser                Relay server              Phone
┌───────────┐              ┌──────────┐             ┌──────────────┐
│           │  QR pairing  │          │             │              │
│  client   │─────────────>│   DO     │<───────────>│  native app  │
│ (browser) │              │(ciphertext│  WebSocket │ (Keychain/KS)│
│           │◄─────────────│  only)   │             │              │
└───────────┘   WebSocket  └──────────┘             └──────────────┘
     │                                                      │
     └────────── ECDH P-256 + HKDF + AES-GCM ────────────────┘
                 (server never sees plaintext)
```

The relay server **sees only ciphertext**. Pairing token → single-use, 5-minute expiry.

## Install

```bash
pnpm add llmvault-relay
# or, if you're using it in a Cloudflare Worker:
pnpm add llmvault-relay hono
```

## Package layout

| Entry | Use |
|---|---|
| `llmvault-relay/client` | Browser-side: `PhoneRelayClient` and QR helpers |
| `llmvault-relay/server` | Server-side: `RelaySessionDO` (Cloudflare Durable Object) + `createRelayRoutes` (Hono factory) |
| `llmvault-relay` (root) | Wire protocol types only (no runtime code) |

## Server usage (Cloudflare Workers + Hono)

```ts
import { Hono } from "hono";
import { createRelayRoutes } from "llmvault-relay/server";
export { RelaySessionDO } from "llmvault-relay/server";

type Env = {
  RELAY_SESSIONS: DurableObjectNamespace;
  ALLOWED_ORIGINS?: string;
};

const app = new Hono<{ Bindings: Env }>();

app.route(
  "/relay",
  createRelayRoutes<Env>({
    getDurableObject: (env) => env.RELAY_SESSIONS,
    allowedWsOrigins: (env) => [
      "https://your-app.example.com",
      ...(env.ALLOWED_ORIGINS ?? "").split(",").filter(Boolean),
    ],
  }),
);

export default app;
```

`wrangler.jsonc`:
```jsonc
{
  "durable_objects": {
    "bindings": [{ "name": "RELAY_SESSIONS", "class_name": "RelaySessionDO" }]
  },
  "migrations": [{ "tag": "v1", "new_classes": ["RelaySessionDO"] }]
}
```

## Client usage (browser)

```ts
import { PhoneRelayClient } from "llmvault-relay/client";

const client = new PhoneRelayClient({
  relayUrl: "wss://your-relay.example.com/relay",
});

// 1. Generate pairing QR
const { pairingToken, qrPayload } = await client.createPairing();
// ... render qrPayload as QR code ...

// 2. After the phone scans and accepts:
await client.waitForPaired(pairingToken);

// 3. Send an AI request (E2E encrypted end to end)
const response = await client.sendRequest({
  provider: "openai",
  messages: [{ role: "user", content: "Hello" }],
});
```

## Protocol

- **Key exchange**: ECDH P-256 between browser and phone.
- **Key derivation**: HKDF-SHA-256 with a protocol-specific info label (`llmvault-relay-v1` by default; override per app if desired).
- **Symmetric**: AES-GCM-256, nonce per message.
- **Pairing token**: 16 bytes of CSPRNG-backed entropy, single use, 5-minute TTL.
- **Session**: 30-minute idle timeout (configurable server-side).

All crypto uses Web Crypto only (no Node-specific APIs) — runs in browsers, Cloudflare Workers, and Deno.

## Security properties

1. Relay server sees **ciphertext only**.
2. Pairing token is single-use and short-lived.
3. Session key is ephemeral — lost when either peer disconnects.
4. Replay protection via AES-GCM nonce + sequence numbering.

## License

MIT
