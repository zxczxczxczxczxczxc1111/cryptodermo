import { beforeEach, describe, expect, it, vi } from "vitest";

// settingsConfig.ts читает/пишет через tauriApi.ts (readVault/writeVaultAtomic),
// которые в реальном приложении идут в Rust через Tauri IPC - недоступный в
// тестах на Node. Тот же приём, что в vaultStore.test.ts/LockScreen.test.ts:
// весь модуль tauriApi замокан, проверяется контракт этого модуля с ним.
vi.mock("./tauriApi", () => ({
  readVault: vi.fn(),
  writeVaultAtomic: vi.fn(),
}));

import { readVault, writeVaultAtomic } from "./tauriApi";
import {
  DEFAULT_AUTO_LOCK_TIMEOUT_MS,
  readSettings,
  writeSettings,
  updateSettings,
  settingsPathFor,
} from "./settingsConfig";

const readVaultMock = vi.mocked(readVault);
const writeVaultAtomicMock = vi.mocked(writeVaultAtomic);

beforeEach(() => {
  readVaultMock.mockReset();
  writeVaultAtomicMock.mockReset().mockResolvedValue(undefined);
});

describe("settingsPathFor (тот же путь, что вычисляет useAutoLock.ts)", () => {
  it("places vault.settings.json next to the vault file, Windows-style path", () => {
    expect(settingsPathFor("D:\\vault\\vault.dat")).toBe("D:\\vault\\vault.settings.json");
  });

  it("places vault.settings.json next to the vault file, POSIX-style path", () => {
    expect(settingsPathFor("/home/user/vault/vault.dat")).toBe("/home/user/vault/vault.settings.json");
  });
});

describe("readSettings: отсутствие файла - валидное состояние (критерий приёмки)", () => {
  it("returns the documented defaults when vault.settings.json does not exist yet", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT: no such file"));

    const settings = await readSettings("D:/vault/vault.dat");

    expect(settings).toEqual({ autoLockTimeoutMs: DEFAULT_AUTO_LOCK_TIMEOUT_MS, lastVaultPath: null });
  });
});

describe("readSettings: чтение существующего файла", () => {
  it("returns both fields when the file has valid values for both", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ autoLockTimeoutMs: 60_000, lastVaultPath: "D:\\other\\vault.dat" }),
      ),
    );

    const settings = await readSettings("D:/vault/vault.dat");

    expect(settings).toEqual({ autoLockTimeoutMs: 60_000, lastVaultPath: "D:\\other\\vault.dat" });
  });

  it("falls back to the default timeout alone when only autoLockTimeoutMs is malformed - fields are independent", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ autoLockTimeoutMs: "not a number", lastVaultPath: "D:\\v.dat" })),
    );

    const settings = await readSettings("D:/vault/vault.dat");

    expect(settings).toEqual({ autoLockTimeoutMs: DEFAULT_AUTO_LOCK_TIMEOUT_MS, lastVaultPath: "D:\\v.dat" });
  });

  it("falls back to defaults entirely on unparsable JSON, without throwing", async () => {
    readVaultMock.mockResolvedValue(new TextEncoder().encode("{not json"));

    await expect(readSettings("D:/vault/vault.dat")).resolves.toEqual({
      autoLockTimeoutMs: DEFAULT_AUTO_LOCK_TIMEOUT_MS,
      lastVaultPath: null,
    });
  });
});

describe("readSettings: поля фичи PIN (pin/pinLockout/pinSetupOffered)", () => {
  it("returns pin/pinLockout/pinSetupOffered when present and well-formed", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          autoLockTimeoutMs: 300_000,
          lastVaultPath: null,
          pin: { salt: "c2FsdA==", iterations: 600_000, iv: "aXY=", wrappedKey: "d2s=" },
          pinLockout: { failedAttempts: 1, lockedUntil: null },
          pinSetupOffered: true,
        }),
      ),
    );

    const settings = await readSettings("D:/vault/vault.dat");

    expect(settings.pin).toEqual({ salt: "c2FsdA==", iterations: 600_000, iv: "aXY=", wrappedKey: "d2s=" });
    expect(settings.pinLockout).toEqual({ failedAttempts: 1, lockedUntil: null });
    expect(settings.pinSetupOffered).toBe(true);
  });

  it("leaves pin/pinLockout/pinSetupOffered undefined when the file predates the PIN feature", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(JSON.stringify({ autoLockTimeoutMs: 300_000, lastVaultPath: null })),
    );

    const settings = await readSettings("D:/vault/vault.dat");

    expect(settings.pin).toBeUndefined();
    expect(settings.pinLockout).toBeUndefined();
    expect(settings.pinSetupOffered).toBeUndefined();
  });

  it("treats a malformed pin object as not-configured without failing the whole read", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ autoLockTimeoutMs: 300_000, lastVaultPath: null, pin: { salt: "only-salt" } }),
      ),
    );

    const settings = await readSettings("D:/vault/vault.dat");

    expect(settings.pin).toBeUndefined();
    expect(settings.autoLockTimeoutMs).toBe(300_000);
  });
});

describe("updateSettings: clearing pin/pinLockout (PIN disable / master password change)", () => {
  it("omits pin/pinLockout from the written JSON when patched with undefined", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({
          autoLockTimeoutMs: 300_000,
          lastVaultPath: null,
          pin: { salt: "c2FsdA==", iterations: 600_000, iv: "aXY=", wrappedKey: "d2s=" },
          pinLockout: { failedAttempts: 3, lockedUntil: "2026-08-16T12:10:00.000Z" },
        }),
      ),
    );

    await updateSettings("D:/vault/vault.dat", { pin: undefined, pinLockout: undefined });

    const [, bytes] = writeVaultAtomicMock.mock.calls[0];
    const written = JSON.parse(new TextDecoder().decode(bytes));
    expect(written).not.toHaveProperty("pin");
    expect(written).not.toHaveProperty("pinLockout");
    expect(written.autoLockTimeoutMs).toBe(300_000);
  });
});

describe("writeSettings / updateSettings", () => {
  it("writeSettings writes the given object atomically to <vault dir>/vault.settings.json", async () => {
    await writeSettings("D:/vault/vault.dat", { autoLockTimeoutMs: 120_000, lastVaultPath: null });

    expect(writeVaultAtomicMock).toHaveBeenCalledTimes(1);
    const [path, bytes] = writeVaultAtomicMock.mock.calls[0];
    expect(path).toBe("D:/vault/vault.settings.json");
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual({
      autoLockTimeoutMs: 120_000,
      lastVaultPath: null,
    });
  });

  it("updateSettings merges a patch onto the currently stored settings without dropping the other field", async () => {
    readVaultMock.mockResolvedValue(
      new TextEncoder().encode(
        JSON.stringify({ autoLockTimeoutMs: 60_000, lastVaultPath: "D:\\vault\\vault.dat" }),
      ),
    );

    const result = await updateSettings("D:/vault/vault.dat", { autoLockTimeoutMs: 900_000 });

    expect(result).toEqual({ autoLockTimeoutMs: 900_000, lastVaultPath: "D:\\vault\\vault.dat" });
    const [, bytes] = writeVaultAtomicMock.mock.calls[0];
    expect(JSON.parse(new TextDecoder().decode(bytes))).toEqual(result);
  });
});
