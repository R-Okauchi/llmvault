# LLMVault

**Bring Your Own Key (BYOK) to any app — without trusting their server.**

A family of libraries that let users securely use their own LLM API keys from web apps, browser extensions, and mobile apps. Keys never leave the user's device — no server relay needed.

## Packages

| Package | Description | npm |
|---|---|---|
| [`llmvault`](./packages/llmvault) | Framework-agnostic SDK for web apps. Talks to the LLMVault browser extension via content-script message passing. | `llmvault` |
| [`llmvault-extension`](./packages/llmvault-extension) | Chrome / Firefox MV3 extension. Stores keys in `chrome.storage.session` and makes CORS-free calls to LLM providers. Per-origin consent (MetaMask-style). | (Chrome Web Store / Firefox AMO) |
| [`llmvault-mobile`](./packages/llmvault-mobile) | Capacitor plugin. Stores keys in iOS Keychain / Android Keystore, biometric-gated, calls providers directly from native code. | `llmvault-mobile` |
| [`llmvault-relay`](./packages/llmvault-relay) | Phone Wallet Relay — zero-knowledge E2E encrypted WebSocket relay for pairing a desktop browser with a mobile wallet. Ships a browser client, a Cloudflare Durable Object, and a Hono route factory. | `llmvault-relay` |

## Quick start

### Web app + browser extension
```bash
pnpm add llmvault
```
Install the LLMVault extension from the Chrome Web Store / Firefox AMO.
```typescript
import { LLMVault } from "llmvault";
const vault = new LLMVault();
if (await vault.isAvailable()) {
  await vault.connect();
  const result = await vault.chat({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] });
}
```

### Mobile app (Capacitor)
```bash
pnpm add llmvault-mobile
npx cap sync
```

### Phone Wallet Relay (PC ↔ phone pairing)
```bash
pnpm add llmvault-relay
```

## Security model

Keys are only ever stored in **user-controlled secure storage**:
- Browser extension: `chrome.storage.session` (ephemeral, cleared on browser close)
- Mobile: iOS Keychain / Android Keystore, biometric-gated
- Relay: E2E encrypted (ECDH P-256 + HKDF-SHA-256 + AES-GCM-256), server sees ciphertext only

Server operators — including any app using these libraries — **never see the user's API key**.

## Development

```bash
pnpm install
pnpm -r build
pnpm -r test
pnpm -r typecheck
```

## Releases

Versions of the three published packages (`llmvault`, `llmvault-mobile`, `llmvault-relay`) are kept in lockstep via a [changesets](https://github.com/changesets/changesets) `fixed` group. See [`.changeset/config.json`](.changeset/config.json). `llmvault-extension` is `ignore`d here and distributed through browser add-on stores instead.

Publishing is fully automated by [`changesets/action`](https://github.com/changesets/action) in [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Make your change on a feature branch.
2. Record the change: `pnpm changeset` (pick bump level + summary).
3. Commit the generated `.changeset/*.md` file with your PR and merge to `main`.
4. A bot opens a **"Version Packages"** PR that bumps `package.json` versions and writes `CHANGELOG.md` entries.
5. Merge that PR → CI runs `changeset publish`, pushes tarballs to npm, and creates tagged GitHub Releases.

The CI-side scripts are named `ci:version` / `ci:release` instead of `version` / `release` to avoid a collision with pnpm's built-in `version` subcommand.

## License

MIT
