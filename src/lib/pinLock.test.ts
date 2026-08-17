import { describe, expect, it } from "vitest";
import { deriveKey, encrypt, decrypt } from "./crypto";
import {
  PIN_LOCKOUT_MAX_ATTEMPTS,
  PIN_LOCKOUT_DURATION_MS,
  PIN_MIN_LENGTH,
  PIN_MAX_LENGTH,
  isValidPinFormat,
  setUpPin,
  unwrapVaultKeyWithPin,
  PinUnlockError,
  isPinLockedOut,
  recordFailedPinAttempt,
  resetPinLockout,
  type PinLockoutState,
} from "./pinLock";

describe("isValidPinFormat", () => {
  it("accepts a purely numeric PIN within [PIN_MIN_LENGTH, PIN_MAX_LENGTH]", () => {
    expect(isValidPinFormat("1234")).toBe(true);
    expect(isValidPinFormat("12345678")).toBe(true);
  });

  it("rejects a PIN shorter than PIN_MIN_LENGTH", () => {
    expect(isValidPinFormat("1".repeat(PIN_MIN_LENGTH - 1))).toBe(false);
  });

  it("rejects a PIN longer than PIN_MAX_LENGTH", () => {
    expect(isValidPinFormat("1".repeat(PIN_MAX_LENGTH + 1))).toBe(false);
  });

  it("rejects a PIN containing non-digit characters", () => {
    expect(isValidPinFormat("12a4")).toBe(false);
    expect(isValidPinFormat("12.4")).toBe(false);
    expect(isValidPinFormat("")).toBe(false);
  });
});

describe("setUpPin -> unwrapVaultKeyWithPin: envelope roundtrip", () => {
  it("unwraps to raw bits that import into the SAME AES key as deriveKey(password, salt, iterations)", async () => {
    const vaultPassword = "correct horse battery staple";
    const vaultSalt = crypto.getRandomValues(new Uint8Array(16));
    const vaultIterations = 1000;

    // Что было бы реальным ключом хранилища (VaultStore.loadFromBytes идёт
    // ровно этим путём) - используется как оракул для сравнения.
    const realKey = await deriveKey(vaultPassword, vaultSalt, vaultIterations);
    const plaintext = new TextEncoder().encode(JSON.stringify([{ id: "1", title: "t" }]));
    const { iv, ciphertext } = await encrypt(realKey, plaintext);

    const wrap = await setUpPin(vaultPassword, vaultSalt, vaultIterations, "4242");
    const rawBits = await unwrapVaultKeyWithPin(wrap, "4242");

    const importedKey = await crypto.subtle.importKey(
      "raw",
      rawBits as BufferSource,
      { name: "AES-GCM", length: 256 },
      false,
      ["decrypt"],
    );

    // Ключ, восстановленный через PIN-обёртку, должен уметь расшифровать то,
    // что было зашифровано РЕАЛЬНЫМ ключом базы - именно это доказывает, что
    // это те же самые 256 бит, не просто "какой-то валидный ключ".
    const decrypted = await decrypt(importedKey, iv, ciphertext);
    expect(decrypted).toEqual(plaintext);
  });

  it("PinWrap carries its own salt, separate from the vault's own salt", async () => {
    const vaultSalt = crypto.getRandomValues(new Uint8Array(16));
    const wrap = await setUpPin("pw", vaultSalt, 1000, "1234");

    const vaultSaltB64 = btoa(String.fromCharCode(...vaultSalt));
    expect(wrap.salt).not.toBe(vaultSaltB64);
    expect(wrap.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it("throws PinUnlockError when unwrapping with the wrong PIN", async () => {
    const vaultSalt = crypto.getRandomValues(new Uint8Array(16));
    const wrap = await setUpPin("correct horse battery staple", vaultSalt, 1000, "1234");

    await expect(unwrapVaultKeyWithPin(wrap, "9999")).rejects.toThrow(PinUnlockError);
  });
});

describe("PIN lockout state transitions", () => {
  const now = new Date("2026-08-16T12:00:00.000Z");

  it("resetPinLockout returns a clean zero state", () => {
    expect(resetPinLockout()).toEqual({ failedAttempts: 0, lockedUntil: null });
  });

  it("isPinLockedOut is false when there is no stored state", () => {
    expect(isPinLockedOut(undefined, now)).toBe(false);
  });

  it("isPinLockedOut is false for a state with no lockedUntil", () => {
    expect(isPinLockedOut({ failedAttempts: 1, lockedUntil: null }, now)).toBe(false);
  });

  it("does not lock out before PIN_LOCKOUT_MAX_ATTEMPTS failures", () => {
    let state: PinLockoutState | undefined = undefined;
    for (let i = 0; i < PIN_LOCKOUT_MAX_ATTEMPTS - 1; i++) {
      state = recordFailedPinAttempt(state, now);
      expect(isPinLockedOut(state, now)).toBe(false);
    }
    expect(state?.failedAttempts).toBe(PIN_LOCKOUT_MAX_ATTEMPTS - 1);
  });

  it("locks out exactly on reaching PIN_LOCKOUT_MAX_ATTEMPTS, for PIN_LOCKOUT_DURATION_MS", () => {
    let state: PinLockoutState | undefined = undefined;
    for (let i = 0; i < PIN_LOCKOUT_MAX_ATTEMPTS; i++) {
      state = recordFailedPinAttempt(state, now);
    }
    expect(state?.failedAttempts).toBe(PIN_LOCKOUT_MAX_ATTEMPTS);
    expect(isPinLockedOut(state, now)).toBe(true);

    const justBeforeExpiry = new Date(now.getTime() + PIN_LOCKOUT_DURATION_MS - 1);
    expect(isPinLockedOut(state, justBeforeExpiry)).toBe(true);

    const justAfterExpiry = new Date(now.getTime() + PIN_LOCKOUT_DURATION_MS + 1);
    expect(isPinLockedOut(state, justAfterExpiry)).toBe(false);
  });

  it("a failed attempt right after an expired lockout re-locks immediately (no free retries)", () => {
    let state: PinLockoutState | undefined = undefined;
    for (let i = 0; i < PIN_LOCKOUT_MAX_ATTEMPTS; i++) {
      state = recordFailedPinAttempt(state, now);
    }
    const afterExpiry = new Date(now.getTime() + PIN_LOCKOUT_DURATION_MS + 1);
    expect(isPinLockedOut(state, afterExpiry)).toBe(false);

    const nextFailure = recordFailedPinAttempt(state, afterExpiry);
    expect(isPinLockedOut(nextFailure, afterExpiry)).toBe(true);
  });

  it("a successful login resets the lockout regardless of prior failures", () => {
    let state: PinLockoutState | undefined = undefined;
    for (let i = 0; i < PIN_LOCKOUT_MAX_ATTEMPTS; i++) {
      state = recordFailedPinAttempt(state, now);
    }
    const reset = resetPinLockout();
    expect(isPinLockedOut(reset, now)).toBe(false);
    expect(reset.failedAttempts).toBe(0);
  });
});
