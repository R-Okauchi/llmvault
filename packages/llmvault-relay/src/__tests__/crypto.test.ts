/**
 * Crypto round-trip tests for llmvault-relay.
 * Runs under Node via Vitest; Node ≥ 20 ships a WebCrypto-compatible
 * `globalThis.crypto` so the same code used in browsers and Workers
 * can be exercised here.
 */
import { describe, it, expect } from "vitest";
import {
  generateECDHKeyPair,
  exportPublicKey,
  importPublicKey,
  deriveSessionKey,
  encrypt,
  decrypt,
  computeShortCode,
} from "../crypto.js";

describe("generateECDHKeyPair", () => {
  it("produces a usable ECDH P-256 key pair with both private and public keys", async () => {
    const pair = await generateECDHKeyPair();
    expect(pair.privateKey).toBeDefined();
    expect(pair.publicKey).toBeDefined();
    expect(pair.privateKey.algorithm.name).toBe("ECDH");
    expect(pair.publicKey.algorithm.name).toBe("ECDH");
  });
});

describe("export/importPublicKey", () => {
  it("round-trips through base64url raw format", async () => {
    const pair = await generateECDHKeyPair();
    const exported = await exportPublicKey(pair.publicKey);
    expect(exported).toMatch(/^[A-Za-z0-9_-]+$/); // base64url, no padding
    const imported = await importPublicKey(exported);
    expect(imported.algorithm.name).toBe("ECDH");
  });
});

describe("deriveSessionKey (ECDH + HKDF)", () => {
  it("derives the same AES-GCM key on both sides of the exchange", async () => {
    const pcPair = await generateECDHKeyPair();
    const mobilePair = await generateECDHKeyPair();

    const pcPub = await exportPublicKey(pcPair.publicKey);
    const mobilePub = await exportPublicKey(mobilePair.publicKey);

    const pcImportedMobile = await importPublicKey(mobilePub);
    const mobileImportedPc = await importPublicKey(pcPub);

    const pcSessionKey = await deriveSessionKey(
      pcPair.privateKey,
      pcImportedMobile,
      pcPub,
      mobilePub,
    );
    const mobileSessionKey = await deriveSessionKey(
      mobilePair.privateKey,
      mobileImportedPc,
      mobilePub,
      pcPub,
    );

    // Cross-check: PC encrypts, mobile decrypts.
    const plaintext = "hello from PC";
    const { ciphertextBase64, ivBase64 } = await encrypt(pcSessionKey, plaintext);
    const decrypted = await decrypt(mobileSessionKey, ciphertextBase64, ivBase64);
    expect(decrypted).toBe(plaintext);
  });

  it("derives a different key when the HKDF label differs", async () => {
    const pcPair = await generateECDHKeyPair();
    const mobilePair = await generateECDHKeyPair();
    const pcPub = await exportPublicKey(pcPair.publicKey);
    const mobilePub = await exportPublicKey(mobilePair.publicKey);

    const k1 = await deriveSessionKey(
      pcPair.privateKey,
      await importPublicKey(mobilePub),
      pcPub,
      mobilePub,
      "label-a",
    );
    const k2 = await deriveSessionKey(
      mobilePair.privateKey,
      await importPublicKey(pcPub),
      mobilePub,
      pcPub,
      "label-b",
    );

    // Round-trip should fail when labels mismatch (different session keys).
    const { ciphertextBase64, ivBase64 } = await encrypt(k1, "msg");
    await expect(decrypt(k2, ciphertextBase64, ivBase64)).rejects.toBeDefined();
  });
});

describe("encrypt/decrypt (AES-GCM)", () => {
  it("round-trips plaintext", async () => {
    const pair = await generateECDHKeyPair();
    const peer = await generateECDHKeyPair();
    const aPub = await exportPublicKey(pair.publicKey);
    const bPub = await exportPublicKey(peer.publicKey);
    const key = await deriveSessionKey(
      pair.privateKey,
      await importPublicKey(bPub),
      aPub,
      bPub,
    );

    for (const msg of ["", "hello", "日本語", "a".repeat(5000)]) {
      const { ciphertextBase64, ivBase64 } = await encrypt(key, msg);
      expect(await decrypt(key, ciphertextBase64, ivBase64)).toBe(msg);
    }
  });

  it("produces a different IV on every call (12 random bytes)", async () => {
    const pair = await generateECDHKeyPair();
    const peer = await generateECDHKeyPair();
    const aPub = await exportPublicKey(pair.publicKey);
    const bPub = await exportPublicKey(peer.publicKey);
    const key = await deriveSessionKey(
      pair.privateKey,
      await importPublicKey(bPub),
      aPub,
      bPub,
    );

    const ivs = new Set<string>();
    for (let i = 0; i < 16; i++) {
      const { ivBase64 } = await encrypt(key, "x");
      ivs.add(ivBase64);
    }
    expect(ivs.size).toBe(16);
  });

  it("round-trips plaintext with AAD", async () => {
    const pair = await generateECDHKeyPair();
    const peer = await generateECDHKeyPair();
    const aPub = await exportPublicKey(pair.publicKey);
    const bPub = await exportPublicKey(peer.publicKey);
    const key = await deriveSessionKey(
      pair.privateKey,
      await importPublicKey(bPub),
      aPub,
      bPub,
    );

    const aad = "session123:request456";
    const { ciphertextBase64, ivBase64 } = await encrypt(key, "hello AAD", aad);
    expect(await decrypt(key, ciphertextBase64, ivBase64, aad)).toBe("hello AAD");
  });

  it("rejects decryption when AAD mismatches", async () => {
    const pair = await generateECDHKeyPair();
    const peer = await generateECDHKeyPair();
    const aPub = await exportPublicKey(pair.publicKey);
    const bPub = await exportPublicKey(peer.publicKey);
    const key = await deriveSessionKey(
      pair.privateKey,
      await importPublicKey(bPub),
      aPub,
      bPub,
    );

    const { ciphertextBase64, ivBase64 } = await encrypt(key, "secret", "correct-aad");
    await expect(decrypt(key, ciphertextBase64, ivBase64, "wrong-aad")).rejects.toBeDefined();
  });

  it("rejects decryption when AAD is omitted but was used for encryption", async () => {
    const pair = await generateECDHKeyPair();
    const peer = await generateECDHKeyPair();
    const aPub = await exportPublicKey(pair.publicKey);
    const bPub = await exportPublicKey(peer.publicKey);
    const key = await deriveSessionKey(
      pair.privateKey,
      await importPublicKey(bPub),
      aPub,
      bPub,
    );

    const { ciphertextBase64, ivBase64 } = await encrypt(key, "secret", "some-aad");
    await expect(decrypt(key, ciphertextBase64, ivBase64)).rejects.toBeDefined();
  });

  it("rejects a tampered ciphertext (AES-GCM auth tag)", async () => {
    const pair = await generateECDHKeyPair();
    const peer = await generateECDHKeyPair();
    const aPub = await exportPublicKey(pair.publicKey);
    const bPub = await exportPublicKey(peer.publicKey);
    const key = await deriveSessionKey(
      pair.privateKey,
      await importPublicKey(bPub),
      aPub,
      bPub,
    );

    const { ciphertextBase64, ivBase64 } = await encrypt(key, "secret");
    // Flip the first character (still valid base64url, invalid ciphertext).
    const first = ciphertextBase64[0];
    const tampered = (first === "A" ? "B" : "A") + ciphertextBase64.slice(1);
    await expect(decrypt(key, tampered, ivBase64)).rejects.toBeDefined();
  });
});

describe("computeShortCode", () => {
  it("is deterministic and symmetric in the two keys", async () => {
    const a = "keyA-aGVsbG8";
    const b = "keyB-d29ybGQ";
    const ab = await computeShortCode(a, b);
    const ba = await computeShortCode(b, a);
    expect(ab).toBe(ba);
    expect(ab).toMatch(/^\d{6}$/);
  });

  it("differs for different inputs", async () => {
    const a = await computeShortCode("x", "y");
    const b = await computeShortCode("x", "z");
    expect(a).not.toBe(b);
  });
});
