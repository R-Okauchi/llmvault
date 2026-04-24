# Keyquill

**Bring Your Own Key (BYOK) to any app — without trusting their server.**

A family of libraries that let users securely use their own LLM API keys from web apps, browser extensions, and mobile apps. Keys never leave the user's device — no server relay needed.

## Packages

| Package | Description | npm |
|---|---|---|
| [`keyquill`](./packages/keyquill) | Framework-agnostic SDK for web apps. Talks to the Keyquill browser extension via content-script message passing. | `keyquill` |
| [`keyquill-extension`](./packages/keyquill-extension) | Chrome / Firefox MV3 extension. Stores keys in `chrome.storage.session` and makes CORS-free calls to LLM providers. Per-origin consent (MetaMask-style). | (Chrome Web Store / Firefox AMO) |
| [`keyquill-mobile`](./packages/keyquill-mobile) | Capacitor plugin. Stores keys in iOS Keychain / Android Keystore, biometric-gated, calls providers directly from native code. | `keyquill-mobile` |
| [`keyquill-relay`](./packages/keyquill-relay) | Phone Wallet Relay — zero-knowledge E2E encrypted WebSocket relay for pairing a desktop browser with a mobile wallet. Ships a browser client, a Cloudflare Durable Object, and a Hono route factory. | `keyquill-relay` |

## Quick start

### Web app + browser extension
```bash
pnpm add keyquill
```
Install the Keyquill extension from the Chrome Web Store / Firefox AMO.
```typescript
import { Keyquill } from "keyquill";
const quill = new Keyquill();
if (await quill.isAvailable()) {
  await quill.connect();
  const result = await quill.chat({ model: "gpt-4o", messages: [{ role: "user", content: "Hello" }] });
}
```

### Mobile app (Capacitor)
```bash
pnpm add keyquill-mobile
npx cap sync
```

### Phone Wallet Relay (PC ↔ phone pairing)
```bash
pnpm add keyquill-relay
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

Versions of the three published packages (`keyquill`, `keyquill-mobile`, `keyquill-relay`) are kept in lockstep via a [changesets](https://github.com/changesets/changesets) `fixed` group. See [`.changeset/config.json`](.changeset/config.json). `keyquill-extension` is `ignore`d here and distributed through browser add-on stores instead.

Publishing is fully automated by [`changesets/action`](https://github.com/changesets/action) in [`.github/workflows/release.yml`](.github/workflows/release.yml):

1. Make your change on a feature branch.
2. Record the change: `pnpm changeset` (pick bump level + summary).
3. Commit the generated `.changeset/*.md` file with your PR and merge to `main`.
4. A bot opens a **"Version Packages"** PR that bumps `package.json` versions and writes `CHANGELOG.md` entries.
5. Merge that PR → CI runs `changeset publish`, pushes tarballs to npm, and creates tagged GitHub Releases.

The CI-side scripts are named `ci:version` / `ci:release` instead of `version` / `release` to avoid a collision with pnpm's built-in `version` subcommand.

## License

MIT
