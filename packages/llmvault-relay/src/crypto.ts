/**
 * ECDH + AES-GCM utilities for the Phone Wallet Relay.
 *
 * Uses Web Crypto API only (available in browsers and Cloudflare Workers).
 *
 * Protocol:
 *   1. Both sides generate ephemeral ECDH P-256 key pairs.
 *   2. Exchange public keys via the relay server.
 *   3. Derive a shared secret via ECDH → HKDF-SHA-256 → AES-GCM-256.
 *      The HKDF `info` label MUST match byte-for-byte on both sides
 *      and is supplied by the caller (default: `"llmvault-relay-v1"`).
 *   4. All messages encrypted with AES-GCM using random 12-byte IVs.
 */

const ECDH_CURVE = "P-256";
const DEFAULT_HKDF_LABEL = "llmvault-relay-v1";
const AES_KEY_LENGTH = 256;
const IV_LENGTH = 12;

// ── Key Generation ──────────────────────────────────────

/** Generate an ephemeral ECDH P-256 key pair for a relay session. */
export async function generateECDHKeyPair(): Promise<CryptoKeyPair> {
  // CF Workers types widen generateKey's return to `CryptoKey | CryptoKeyPair`;
  // for an extractable ECDH key pair, the runtime guarantees CryptoKeyPair.
  return crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: ECDH_CURVE },
    true,
    ["deriveKey", "deriveBits"],
  ) as Promise<CryptoKeyPair>;
}

// ── Key Export / Import ─────────────────────────────────

/** Export a public key as base64url-encoded raw bytes. */
export async function exportPublicKey(key: CryptoKey): Promise<string> {
  // CF Workers types return `ArrayBuffer | JsonWebKey`; for "raw" format the
  // runtime always returns ArrayBuffer.
  const raw = (await crypto.subtle.exportKey("raw", key)) as ArrayBuffer;
  return base64urlEncode(new Uint8Array(raw));
}

/** Import a peer's public key from base64url-encoded raw bytes. */
export async function importPublicKey(base64url: string): Promise<CryptoKey> {
  const raw = base64urlDecode(base64url);
  return crypto.subtle.importKey(
    "raw",
    raw.buffer as ArrayBuffer,
    { name: "ECDH", namedCurve: ECDH_CURVE },
    false,
    [],
  );
}

// ── Key Derivation ──────────────────────────────────────

/**
 * Derive a shared AES-GCM-256 session key from an ECDH key exchange.
 *
 * `hkdfLabel` MUST match on both sides (default `"llmvault-relay-v1"`).
 * Downstream apps that already have a deployed pairing protocol should
 * pass their historical label here to preserve compatibility.
 */
export async function deriveSessionKey(
  privateKey: CryptoKey,
  peerPublicKey: CryptoKey,
  localPublicKeyBase64: string,
  peerPublicKeyBase64: string,
  hkdfLabel: string = DEFAULT_HKDF_LABEL,
): Promise<CryptoKey> {
  // CF Workers types declare the ECDH peer key field as `$public` (TS keyword
  // avoidance) while DOM types use `public`. `AlgorithmIdentifier` also exists
  // only under DOM, so fall back to a generic parameter cast.
  const deriveAlgorithm = { name: "ECDH", public: peerPublicKey };
  const sharedBits = await crypto.subtle.deriveBits(
    deriveAlgorithm as Parameters<typeof crypto.subtle.deriveBits>[0],
    privateKey,
    256,
  );

  const hkdfKey = await crypto.subtle.importKey("raw", sharedBits, "HKDF", false, ["deriveKey"]);
  const salt = await computeSalt(localPublicKeyBase64, peerPublicKeyBase64);
  const info = new TextEncoder().encode(hkdfLabel);

  return crypto.subtle.deriveKey(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt,
      info,
    },
    hkdfKey,
    { name: "AES-GCM", length: AES_KEY_LENGTH },
    false,
    ["encrypt", "decrypt"],
  );
}

// ── Encryption / Decryption ─────────────────────────────

/**
 * Encrypt a plaintext string with AES-GCM. Returns ciphertext + IV (base64url).
 *
 * @param additionalData  Optional AAD (e.g. `"sessionId:requestId"`) that is
 *                        authenticated but NOT encrypted. The same value must be
 *                        supplied to {@link decrypt} or decryption will fail.
 */
export async function encrypt(
  key: CryptoKey,
  plaintext: string,
  additionalData?: string,
): Promise<{ ciphertextBase64: string; ivBase64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoded = new TextEncoder().encode(plaintext);

  const aad = additionalData ? new TextEncoder().encode(additionalData) : undefined;

  const ciphertext = await crypto.subtle.encrypt(
    aad
      ? { name: "AES-GCM", iv: iv as ArrayBufferView<ArrayBuffer>, additionalData: aad }
      : { name: "AES-GCM", iv: iv as ArrayBufferView<ArrayBuffer> },
    key,
    encoded,
  );

  return {
    ciphertextBase64: base64urlEncode(new Uint8Array(ciphertext)),
    ivBase64: base64urlEncode(iv),
  };
}

/**
 * Decrypt an AES-GCM encrypted message.
 *
 * @param additionalData  Must match the value passed to {@link encrypt}.
 */
export async function decrypt(
  key: CryptoKey,
  ciphertextBase64: string,
  ivBase64: string,
  additionalData?: string,
): Promise<string> {
  const ciphertext = base64urlDecode(ciphertextBase64);
  const iv = base64urlDecode(ivBase64);

  const aad = additionalData ? new TextEncoder().encode(additionalData) : undefined;

  const plaintext = await crypto.subtle.decrypt(
    aad
      ? { name: "AES-GCM", iv: iv as ArrayBufferView<ArrayBuffer>, additionalData: aad }
      : { name: "AES-GCM", iv: iv as ArrayBufferView<ArrayBuffer> },
    key,
    ciphertext.buffer as ArrayBuffer,
  );

  return new TextDecoder().decode(plaintext);
}

// ── Short Verification Code ─────────────────────────────

/**
 * Compute a 6-digit verification code from two public keys.
 * Used for visual MITM detection — both devices should show the same code.
 */
export async function computeShortCode(key1Base64: string, key2Base64: string): Promise<string> {
  const sorted = [key1Base64, key2Base64].sort().join("");
  const data = new TextEncoder().encode(sorted);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(hash);
  const num = (bytes[0] << 16) | (bytes[1] << 8) | bytes[2];
  return String(num % 1_000_000).padStart(6, "0");
}

// ── Base64url Helpers ───────────────────────────────────

function base64urlEncode(bytes: Uint8Array): string {
  const binary = Array.from(bytes)
    .map((b) => String.fromCharCode(b))
    .join("");
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function computeSalt(key1: string, key2: string): Promise<ArrayBuffer> {
  const sorted = [key1, key2].sort().join("");
  const data = new TextEncoder().encode(sorted);
  return crypto.subtle.digest("SHA-256", data);
}
