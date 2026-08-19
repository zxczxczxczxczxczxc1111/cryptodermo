import { describe, expect, it } from "vitest";
import { base64ToBytes, bytesToBase64 } from "./base64";

describe("base64", () => {
  it("round-trip не теряет байты на всех вариантах паддинга", () => {
    // Длины 0..3 по модулю 3 покрывают все три случая паддинга base64
    // ("", "=", "=="), 300 - что цикл не ломается на длинных данных.
    for (const length of [0, 1, 2, 3, 4, 5, 300]) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) bytes[i] = (i * 37) % 256;
      expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
    }
  });

  it("совпадает с эталонными значениями RFC 4648", () => {
    // Ожидаемые строки взяты из самой спецификации, не получены вызовом
    // кода под тестом.
    const encode = (s: string) => bytesToBase64(new TextEncoder().encode(s));
    expect(encode("")).toBe("");
    expect(encode("f")).toBe("Zg==");
    expect(encode("fo")).toBe("Zm8=");
    expect(encode("foo")).toBe("Zm9v");
    expect(encode("foob")).toBe("Zm9vYg==");
    expect(encode("fooba")).toBe("Zm9vYmE=");
    expect(encode("foobar")).toBe("Zm9vYmFy");
  });

  it("держит байты старше 0x7f - именно они ломаются при наивном обходе через строку", () => {
    const bytes = new Uint8Array([0x00, 0x7f, 0x80, 0xfe, 0xff]);
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });
});
