import { beforeEach, describe, expect, it, vi } from "vitest";

// LockScreen.tsx использует tauriApi.readVault (checkExistingVault) и, через
// VaultStore, весь файловый слой (submitCreate -> store.save() ->
// readVault/writeVaultAtomic/rotateBackups). В тестах это недоступный
// реальный Tauri IPC - тот же приём, что и в vaultStore.test.ts: весь модуль
// tauriApi замокан.
vi.mock("../lib/tauriApi", () => ({
  readVault: vi.fn(),
  writeVaultAtomic: vi.fn(),
  listBackups: vi.fn(),
  rotateBackups: vi.fn(),
}));

import { readVault, writeVaultAtomic, listBackups, rotateBackups } from "../lib/tauriApi";
import { VaultStore } from "../lib/vaultStore";
import {
  checkExistingVault,
  submitUnlock,
  submitCreate,
  submitRecovery,
  UNLOCK_ERROR_MESSAGE,
  CREATE_SAVE_ERROR_MESSAGE,
  PASSWORD_MISMATCH_MESSAGE,
} from "./LockScreen";

const readVaultMock = vi.mocked(readVault);
const writeVaultAtomicMock = vi.mocked(writeVaultAtomic);
const listBackupsMock = vi.mocked(listBackups);
const rotateBackupsMock = vi.mocked(rotateBackups);

beforeEach(() => {
  readVaultMock.mockReset();
  writeVaultAtomicMock.mockReset().mockResolvedValue(undefined);
  listBackupsMock.mockReset().mockResolvedValue([]);
  rotateBackupsMock.mockReset().mockResolvedValue(undefined);
});

describe("checkExistingVault (определяет режим экрана - R95)", () => {
  it("returns the file bytes when a vault.dat already exists at the path", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    readVaultMock.mockResolvedValue(bytes);

    await expect(checkExistingVault("D:/vault/vault.dat")).resolves.toBe(bytes);
  });

  it("returns null when reading the file fails - no vault.dat yet is a valid state", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT: no such file"));

    await expect(checkExistingVault("D:/vault/vault.dat")).resolves.toBeNull();
  });
});

describe("submitUnlock (критерий: верный пароль открывает список записей)", () => {
  async function existingVaultBytes(password: string): Promise<Uint8Array> {
    const store = new VaultStore();
    await store.createNewVault(password, 1000);
    store.addItem({ type: "login", title: "GitHub", tags: [], fields: [] });
    return store.toBytes();
  }

  it("calls onUnlock with a usable VaultStore when the password is correct", async () => {
    const bytes = await existingVaultBytes("correct horse battery staple");
    const onUnlock = vi.fn();

    const result = await submitUnlock({
      existingBytes: bytes,
      password: "correct horse battery staple",
      vaultPath: "D:/vault/vault.dat",
      onUnlock,
    });

    expect(result).toEqual({ ok: true });
    expect(onUnlock).toHaveBeenCalledTimes(1);
    const [calledStore, calledPath] = onUnlock.mock.calls[0];
    expect(calledPath).toBe("D:/vault/vault.dat");
    expect(calledStore).toBeInstanceOf(VaultStore);
    // "Открывает список записей" проверяется тем, что переданный стор
    // реально расшифрован и рабочий - search() отдаёт добавленную запись.
    expect(calledStore.search("")).toMatchObject([{ title: "GitHub" }]);
  });

  it("does not call onUnlock and returns the unified error text on a wrong password", async () => {
    const bytes = await existingVaultBytes("right password");
    const onUnlock = vi.fn();

    const result = await submitUnlock({
      existingBytes: bytes,
      password: "wrong password",
      vaultPath: "D:/vault/vault.dat",
      onUnlock,
    });

    expect(result).toEqual({ ok: false, message: UNLOCK_ERROR_MESSAGE });
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it("does not call onUnlock and returns the SAME unified error text on a corrupted file", async () => {
    const onUnlock = vi.fn();
    const garbage = new TextEncoder().encode("not a vault container at all");

    const result = await submitUnlock({
      existingBytes: garbage,
      password: "whatever",
      vaultPath: "D:/vault/vault.dat",
      onUnlock,
    });

    // Дословно из тикета: AES-GCM (и в этом случае - разбор контейнера) не
    // различает "неверный пароль" и "файл повреждён", текст один и тот же.
    expect(result).toEqual({ ok: false, message: UNLOCK_ERROR_MESSAGE });
    expect(onUnlock).not.toHaveBeenCalled();
  });
});

describe("submitCreate (создание базы поверх пустого пути)", () => {
  it("creates a new vault, persists it to disk, and calls onUnlock", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT")); // по пути ещё ничего нет
    const onUnlock = vi.fn();

    const result = await submitCreate({
      vaultPath: "D:/vault/vault.dat",
      password: "new master password",
      passwordConfirm: "new master password",
      onUnlock,
    });

    expect(result).toEqual({ ok: true });
    expect(onUnlock).toHaveBeenCalledTimes(1);
    const [calledStore, calledPath] = onUnlock.mock.calls[0];
    expect(calledPath).toBe("D:/vault/vault.dat");
    expect(calledStore.isDirty()).toBe(false); // save() уже прошёл

    const vaultWrites = writeVaultAtomicMock.mock.calls.filter(([path]) => path === "D:/vault/vault.dat");
    expect(vaultWrites).toHaveLength(1);
  });

  it("returns an error message and does not call onUnlock when writing to disk fails", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    writeVaultAtomicMock.mockRejectedValue(new Error("disk full"));
    const onUnlock = vi.fn();

    const result = await submitCreate({
      vaultPath: "D:/vault/vault.dat",
      password: "new master password",
      passwordConfirm: "new master password",
      onUnlock,
    });

    expect(result).toEqual({ ok: false, message: CREATE_SAVE_ERROR_MESSAGE });
    expect(onUnlock).not.toHaveBeenCalled();
  });

  it("does not create a vault and returns a clear error when the passwords do not match", async () => {
    // Опечатка в повторе пароля - критичный сценарий (см. решение
    // оркестратора 2026-08-16): проверяем, что несовпадение перехватывается
    // ДО createNewVault/save - ни попытки записи на диск, ни onUnlock.
    const onUnlock = vi.fn();

    const result = await submitCreate({
      vaultPath: "D:/vault/vault.dat",
      password: "correct horse battery staple",
      passwordConfirm: "correct horse battery staplee", // опечатка
      onUnlock,
    });

    expect(result).toEqual({ ok: false, message: PASSWORD_MISMATCH_MESSAGE });
    expect(onUnlock).not.toHaveBeenCalled();
    expect(readVaultMock).not.toHaveBeenCalled();
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });

  it("creates the vault as before when the passwords match exactly", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const onUnlock = vi.fn();

    const result = await submitCreate({
      vaultPath: "D:/vault/vault.dat",
      password: "matching password",
      passwordConfirm: "matching password",
      onUnlock,
    });

    expect(result).toEqual({ ok: true });
    expect(onUnlock).toHaveBeenCalledTimes(1);
  });
});

describe("submitRecovery (R114i - открыть последнюю рабочую копию)", () => {
  it("opens the given backup file with the typed password and calls onUnlock with the MAIN vault path", async () => {
    const backupStore = new VaultStore();
    await backupStore.createNewVault("pw", 1000);
    backupStore.addItem({ type: "note", title: "recovered", tags: [], fields: [] });
    const backupBytes = await backupStore.toBytes();
    readVaultMock.mockResolvedValue(backupBytes);

    const onUnlock = vi.fn();
    const result = await submitRecovery({
      backupPath: "D:/vault/backups/vault-2026-01-01-000000.dat",
      password: "pw",
      vaultPath: "D:/vault/vault.dat",
      onUnlock,
    });

    expect(result).toEqual({ ok: true });
    expect(readVaultMock).toHaveBeenCalledWith("D:/vault/backups/vault-2026-01-01-000000.dat");
    const [calledStore, calledPath] = onUnlock.mock.calls[0];
    // Путь наружу - основной vault.dat, НЕ путь к файлу бэкапа: следующий
    // обычный save() должен писать в боевой файл, не поверх самого бэкапа.
    expect(calledPath).toBe("D:/vault/vault.dat");
    expect(calledStore.search("")).toMatchObject([{ title: "recovered" }]);
  });

  it("returns the unified error text without calling onUnlock when the password is wrong", async () => {
    const backupStore = new VaultStore();
    await backupStore.createNewVault("right pw", 1000);
    const backupBytes = await backupStore.toBytes();
    readVaultMock.mockResolvedValue(backupBytes);

    const onUnlock = vi.fn();
    const result = await submitRecovery({
      backupPath: "D:/vault/backups/vault-2026-01-01-000000.dat",
      password: "wrong pw",
      vaultPath: "D:/vault/vault.dat",
      onUnlock,
    });

    expect(result).toEqual({ ok: false, message: UNLOCK_ERROR_MESSAGE });
    expect(onUnlock).not.toHaveBeenCalled();
  });
});
