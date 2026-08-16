import { describe, expect, it } from "vitest";
import { serializeContainer, parseContainer, FormatError, type VaultHeader } from "./vaultFormat";

describe("vault-format: serialize -> parse roundtrip", () => {
  it("restores the original header and ciphertext byte-for-byte", () => {
    const header: VaultHeader = {
      v: 1,
      kdf: {
        alg: "PBKDF2-SHA256",
        params: { iterations: 5_000_000 },
        salt: "AAECAwQFBgcICQoLDA0ODw==",
      },
      cipher: "AES-256-GCM",
      iv: "AAECAwQFBgcICQoL",
    };
    const ciphertext = new Uint8Array([1, 2, 3, 4, 250, 251, 252, 253, 0, 255]);

    const bytes = serializeContainer(header, ciphertext);
    const parsed = parseContainer(bytes);

    expect(parsed.header).toEqual(header);
    expect(parsed.ciphertext).toEqual(ciphertext);
  });

  it("rejects a container with an unknown format version instead of guessing its structure", () => {
    const futureContainer = {
      v: 99,
      kdf: { alg: "PBKDF2-SHA256", params: { iterations: 5_000_000 }, salt: "AA==" },
      cipher: "AES-256-GCM",
      iv: "AA==",
      ct: "AA==",
    };
    const bytes = new TextEncoder().encode(JSON.stringify(futureContainer));

    expect(() => parseContainer(bytes)).toThrow(FormatError);
  });
});
