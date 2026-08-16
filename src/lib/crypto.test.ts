import { describe, expect, it } from "vitest";
import { deriveKey, encrypt, decrypt, DecryptError } from "./crypto";

describe("crypto: derive -> encrypt -> decrypt roundtrip", () => {
  it("returns the original plaintext bytes after a full roundtrip", async () => {
    const password = "correct horse battery staple";
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const plaintext = new TextEncoder().encode(
      JSON.stringify([{ id: "1", title: "test item" }]),
    );

    const key = await deriveKey(password, salt, 1000);
    const { iv, ciphertext } = await encrypt(key, plaintext);
    const decrypted = await decrypt(key, iv, ciphertext);

    expect(decrypted).toEqual(plaintext);
  });

  it("returns a non-extractable key so raw key bytes can never be read out", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey("some password", salt, 1000);

    expect(key.extractable).toBe(false);
  });

  it("throws DecryptError when decrypting with the wrong key", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const plaintext = new TextEncoder().encode("secret note");

    const correctKey = await deriveKey("correct password", salt, 1000);
    const wrongKey = await deriveKey("wrong password", salt, 1000);
    const { iv, ciphertext } = await encrypt(correctKey, plaintext);

    await expect(decrypt(wrongKey, iv, ciphertext)).rejects.toThrow(
      DecryptError,
    );
  });
});
