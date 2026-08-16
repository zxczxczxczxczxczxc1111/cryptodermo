import { beforeEach, describe, expect, it, vi } from "vitest";

// readAutoLockTimeoutMs читает vault.settings.json через tauriApi.readVault
// (interfaces.md: "читает readVault(path) из tauriApi.ts + JSON.parse
// напрямую") - недоступный реальный Tauri IPC в тестах, тот же приём, что и
// в vaultStore.test.ts: весь модуль tauriApi замокан. clipboard.ts тоже
// замокан - performAutoLock должен звать именно clearNow() из него, а не
// трогать navigator.clipboard напрямую (в Node-окружении тестов его вообще
// может не быть).
vi.mock("../lib/tauriApi", () => ({
  readVault: vi.fn(),
}));
vi.mock("../lib/clipboard", () => ({
  clearNow: vi.fn(),
}));

import { readVault } from "../lib/tauriApi";
import { clearNow } from "../lib/clipboard";
import { VaultStore, ItemCountDecreasedError } from "../lib/vaultStore";
import { DEFAULT_AUTO_LOCK_TIMEOUT_MS, readAutoLockTimeoutMs, performAutoLock } from "./useAutoLock";

const readVaultMock = vi.mocked(readVault);
const clearNowMock = vi.mocked(clearNow);

beforeEach(() => {
  readVaultMock.mockReset();
  clearNowMock.mockReset();
});

describe("readAutoLockTimeoutMs (vault.settings.json, R47)", () => {
  it("returns the default when vault.settings.json does not exist - a valid state", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT: no such file"));

    await expect(readAutoLockTimeoutMs("D:/vault/vault.dat")).resolves.toBe(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  });

  it("returns the value from vault.settings.json when present and valid", async () => {
    const json = JSON.stringify({ autoLockTimeoutMs: 60_000 });
    readVaultMock.mockResolvedValue(new TextEncoder().encode(json));

    await expect(readAutoLockTimeoutMs("D:/vault/vault.dat")).resolves.toBe(60_000);
  });

  it("returns the default when the file contains malformed JSON", async () => {
    readVaultMock.mockResolvedValue(new TextEncoder().encode("{ not json"));

    await expect(readAutoLockTimeoutMs("D:/vault/vault.dat")).resolves.toBe(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  });

  it("returns the default when autoLockTimeoutMs is missing from an otherwise valid JSON object", async () => {
    const json = JSON.stringify({ lastVaultPath: "C:\\Users\\me\\vault.dat" });
    readVaultMock.mockResolvedValue(new TextEncoder().encode(json));

    await expect(readAutoLockTimeoutMs("D:/vault/vault.dat")).resolves.toBe(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  });

  it("reads from '<vault dir>/vault.settings.json', handling both '/' and '\\\\' paths", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));

    await readAutoLockTimeoutMs("D:/vault/vault.dat");
    expect(readVaultMock).toHaveBeenLastCalledWith("D:/vault/vault.settings.json");

    await readAutoLockTimeoutMs("C:\\Users\\me\\vault\\vault.dat");
    expect(readVaultMock).toHaveBeenLastCalledWith("C:\\Users\\me\\vault\\vault.settings.json");
  });
});

describe("performAutoLock (R47.1/R48.1 - что происходит в момент блокировки)", () => {
  async function dirtyStore(): Promise<VaultStore> {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({ type: "note", title: "unsaved edit", tags: [], fields: [] });
    return store;
  }

  async function cleanStore(): Promise<VaultStore> {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    return store;
  }

  it("saves unsaved changes, then clears the clipboard, then signals lock - in that order", async () => {
    const store = await dirtyStore();
    const calls: string[] = [];
    vi.spyOn(store, "save").mockImplementation(async () => {
      calls.push("save");
    });
    clearNowMock.mockImplementation(() => {
      calls.push("clearNow");
    });
    const onLock = vi.fn(() => calls.push("onLock"));

    await performAutoLock({ store, vaultPath: "D:/vault/vault.dat", onLock });

    expect(store.save).toHaveBeenCalledWith("D:/vault/vault.dat");
    expect(onLock).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["save", "clearNow", "onLock"]);
  });

  it("does not call save when the store has no unsaved changes", async () => {
    const store = await cleanStore();
    const saveSpy = vi.spyOn(store, "save").mockResolvedValue(undefined);

    await performAutoLock({ store, vaultPath: "D:/vault/vault.dat", onLock: vi.fn() });

    expect(saveSpy).not.toHaveBeenCalled();
    expect(clearNowMock).toHaveBeenCalledTimes(1);
  });

  it("still clears the clipboard and signals lock even if the autosave fails", async () => {
    const store = await dirtyStore();
    vi.spyOn(store, "save").mockRejectedValue(new Error("disk busy"));
    const onLock = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(performAutoLock({ store, vaultPath: "D:/vault/vault.dat", onLock })).resolves.toBeUndefined();

    // Приоритет 1 из спецификации ("данные не теряются") здесь в напряжении с
    // требованием блокировать без диалога - решение тикета: попытка
    // сохранить не блокирует саму блокировку, ошибка только логируется
    // (нет диалога - некому её увидеть до блокировки).
    expect(clearNowMock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });

  it("retries with { allowCountDecrease: true } when save() rejects with ItemCountDecreasedError (R28)", async () => {
    const store = await dirtyStore();
    const saveSpy = vi.spyOn(store, "save").mockImplementation(async (_path, opts) => {
      if (!opts?.allowCountDecrease) {
        throw new ItemCountDecreasedError(5, 2);
      }
    });
    const onLock = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await performAutoLock({ store, vaultPath: "D:/vault/vault.dat", onLock });

    // Первая попытка - как обычно, без подтверждения; вторая - с ним, после
    // отлова ItemCountDecreasedError. Блокировка не срывается диалогом,
    // которого некому увидеть (решение оркестратора 2026-08-16).
    expect(saveSpy).toHaveBeenNthCalledWith(1, "D:/vault/vault.dat");
    expect(saveSpy).toHaveBeenNthCalledWith(2, "D:/vault/vault.dat", { allowCountDecrease: true });
    expect(clearNowMock).toHaveBeenCalledTimes(1);
    expect(onLock).toHaveBeenCalledTimes(1);
    consoleErrorSpy.mockRestore();
  });
});
