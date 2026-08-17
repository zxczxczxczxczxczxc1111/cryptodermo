import { beforeEach, describe, expect, it, vi } from "vitest";

// changeMasterPassword использует tauriApi.readVault (для проверки текущего
// пароля по файлу на диске) и, через VaultStore.save(), весь файловый слой
// (readVault/writeVaultAtomic/rotateBackups) - тот же приём, что в
// vaultStore.test.ts/LockScreen.test.ts: весь модуль tauriApi замокан, шов
// проверяется на границе с ним. crypto.ts/vaultFormat.ts НЕ замоканы - это
// настоящее шифрование/разбор контейнера, чтобы проверка "новый пароль
// реально работает, старый - нет" была настоящей, а не самоподтверждающейся.
vi.mock("../lib/tauriApi", () => ({
  readVault: vi.fn(),
  writeVaultAtomic: vi.fn(),
  listBackups: vi.fn(),
  rotateBackups: vi.fn(),
}));

import { readVault, writeVaultAtomic, listBackups, rotateBackups } from "../lib/tauriApi";
import { VaultStore } from "../lib/vaultStore";
import {
  changeMasterPassword,
  enableOrChangePin,
  disablePin,
  CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE,
  PASSWORD_CHANGE_SAVE_ERROR_MESSAGE,
  PIN_TOGGLE_PASSWORD_ERROR_MESSAGE,
  PIN_TOGGLE_MISMATCH_MESSAGE,
  PIN_TOGGLE_FORMAT_ERROR_MESSAGE,
} from "./Settings";

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

/** Живой стор + байты, "как будто уже лежат на диске" под тем же паролем -
 * общая обвязка для тестов ниже (диск и живой стор должны совпадать по
 * содержимому и паролю, ровно как в реальном открытом приложении). */
async function openVaultOnDisk(password: string): Promise<{ store: VaultStore; diskBytes: Uint8Array }> {
  const store = new VaultStore();
  await store.createNewVault(password, 1000);
  store.addItem({ type: "login", title: "GitHub", tags: [], fields: [{ name: "user", value: "octo", secret: false }] });
  const diskBytes = await store.toBytes();
  return { store, diskBytes };
}

describe("changeMasterPassword: успешная смена (критерий - открывается новым паролем, не старым)", () => {
  it("returns a new store whose freshly-written bytes decrypt with the new password and not with the old one", async () => {
    const { store, diskBytes } = await openVaultOnDisk("old password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "old password",
      newPassword: "new password",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");

    // Байты, реально записанные в vault.dat (не в backups/) этим вызовом.
    const mainWrite = writeVaultAtomicMock.mock.calls.find(([path]) => path === "D:/vault/vault.dat");
    expect(mainWrite).toBeDefined();
    const writtenBytes = mainWrite![1];

    const reopenedWithNewPassword = new VaultStore();
    await expect(reopenedWithNewPassword.loadFromBytes(writtenBytes, "new password")).resolves.toBeUndefined();
    expect(reopenedWithNewPassword.search("")).toMatchObject([{ title: "GitHub" }]);

    const reopenedWithOldPassword = new VaultStore();
    await expect(reopenedWithOldPassword.loadFromBytes(writtenBytes, "old password")).rejects.toThrow();

    // Возвращённый стор уже юзабелен под новым паролем, с теми же данными.
    expect(result.store.search("")).toMatchObject([{ title: "GitHub" }]);
  });

  it("preserves unsaved in-memory edits that were never written to disk (priority 1: data isn't lost)", async () => {
    const { store, diskBytes } = await openVaultOnDisk("old password");
    // diskBytes отражают состояние ДО добавления второй записи - это и есть
    // несохранённая правка в живом сторе на момент смены пароля.
    store.addItem({ type: "note", title: "Unsaved note", tags: [], fields: [] });
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "old password",
      newPassword: "new password",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");
    const titles = result.store.search("").map((i) => i.title);
    expect(titles).toEqual(expect.arrayContaining(["GitHub", "Unsaved note"]));
  });
});

describe("changeMasterPassword: бэкап текущей (старой) версии перед изменениями (R101.1)", () => {
  it("backs up the OLD-password file to backups/ before writing the new one, in that order", async () => {
    const { store, diskBytes } = await openVaultOnDisk("old password");
    readVaultMock.mockResolvedValue(diskBytes);

    await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "old password",
      newPassword: "new password",
    });

    const backupCallIndex = writeVaultAtomicMock.mock.calls.findIndex(([path]) =>
      /vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/.test(path),
    );
    expect(backupCallIndex).toBeGreaterThanOrEqual(0);
    // Содержимое бэкапа - байты, которые вернул readVault (старая версия на
    // старом пароле), не что-то новое.
    expect(writeVaultAtomicMock.mock.calls[backupCallIndex][1]).toBe(diskBytes);

    const mainWriteIndex = writeVaultAtomicMock.mock.calls.findIndex(([path]) => path === "D:/vault/vault.dat");
    const backupOrder = writeVaultAtomicMock.mock.invocationCallOrder[backupCallIndex];
    const mainOrder = writeVaultAtomicMock.mock.invocationCallOrder[mainWriteIndex];
    expect(backupOrder).toBeLessThan(mainOrder);
  });
});

describe("changeMasterPassword: неверный текущий пароль", () => {
  it("rejects without writing anything to disk when currentPassword is wrong", async () => {
    const { store, diskBytes } = await openVaultOnDisk("right password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "wrong password",
      newPassword: "new password",
    });

    expect(result).toEqual({ ok: false, message: CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE });
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });
});

describe("changeMasterPassword: симулированное прерывание перешифровки (аналогично тесту атомарности из тикета 01)", () => {
  it("does not leave vault.dat unreadable when the write of the new version is interrupted", async () => {
    const { store, diskBytes } = await openVaultOnDisk("old password");
    readVaultMock.mockResolvedValue(diskBytes);

    // Симулируем прерывание РОВНО на записи целевого vault.dat - бэкап
    // старой версии (ещё старый пароль) должен успеть пройти раньше, эта
    // же самая запись имитирует "процесс остановился между шагами 1 и 2"
    // из write_vault_atomic (Rust-тест ticket 01): для файловой системы это
    // неотличимо от того, что переименование во время атомарной записи так
    // и не случилось - целевой файл остаётся тем, чем был.
    writeVaultAtomicMock.mockImplementation(async (path: string) => {
      if (path === "D:/vault/vault.dat") {
        throw new Error("simulated interruption: process died mid-write");
      }
    });

    const result = await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "old password",
      newPassword: "new password",
    });

    // Операция честно отказывает - не "ok:true" при незаписанных данных.
    expect(result).toEqual({ ok: false, message: PASSWORD_CHANGE_SAVE_ERROR_MESSAGE });

    // Но безопасная копия версии на старом пароле уже успела уйти в
    // backups/ до попытки записи в целевой файл - её вызов зафиксирован и
    // отдельен от (упавшего) вызова на "D:/vault/vault.dat".
    const backupWrite = writeVaultAtomicMock.mock.calls.find(([path]) =>
      /vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/.test(path),
    );
    expect(backupWrite).toBeDefined();
    expect(backupWrite![1]).toBe(diskBytes);

    // Ротация после прерванной записи не должна была случиться - save()
    // бросает раньше, чем до неё доходит очередь.
    expect(rotateBackupsMock).not.toHaveBeenCalled();

    // Переданный извне живой store не тронут - его собственные данные и
    // пароль по-прежнему рабочие (можно попробовать ещё раз).
    expect(store.search("")).toMatchObject([{ title: "GitHub" }]);
  });
});

describe("changeMasterPassword: инвалидация PIN после смены пароля (фича PIN-кода)", () => {
  it("clears an existing PIN wrap and lockout in vault.settings.json after a successful password change", async () => {
    const { store, diskBytes } = await openVaultOnDisk("old password");
    const settingsBytes = new TextEncoder().encode(
      JSON.stringify({
        autoLockTimeoutMs: 300_000,
        lastVaultPath: null,
        pin: { salt: "c2FsdA==", iterations: 600_000, iv: "aXY=", wrappedKey: "d2s=" },
        pinLockout: { failedAttempts: 2, lockedUntil: null },
      }),
    );
    readVaultMock.mockImplementation(async (path: string) =>
      path === "D:/vault/vault.settings.json" ? settingsBytes : diskBytes,
    );

    const result = await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "old password",
      newPassword: "new password",
    });

    expect(result.ok).toBe(true);

    const settingsWrite = writeVaultAtomicMock.mock.calls.find(([path]) => path === "D:/vault/vault.settings.json");
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(new TextDecoder().decode(settingsWrite![1]));
    expect(written).not.toHaveProperty("pin");
    expect(written).not.toHaveProperty("pinLockout");
    // Остальные поля настроек не задеты этим сбросом.
    expect(written.autoLockTimeoutMs).toBe(300_000);
  });

  it("does not touch vault.settings.json when the password change itself fails", async () => {
    const { store, diskBytes } = await openVaultOnDisk("right password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await changeMasterPassword({
      store,
      vaultPath: "D:/vault/vault.dat",
      currentPassword: "wrong password",
      newPassword: "new password",
    });

    expect(result.ok).toBe(false);
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });
});

describe("enableOrChangePin", () => {
  it("rejects a malformed PIN without touching the disk at all", async () => {
    const result = await enableOrChangePin({
      vaultPath: "D:/vault/vault.dat",
      masterPassword: "pw",
      pin: "12",
      pinConfirm: "12",
    });

    expect(result).toEqual({ ok: false, message: PIN_TOGGLE_FORMAT_ERROR_MESSAGE });
    expect(readVaultMock).not.toHaveBeenCalled();
  });

  it("rejects a PIN / confirm mismatch without touching the disk at all", async () => {
    const result = await enableOrChangePin({
      vaultPath: "D:/vault/vault.dat",
      masterPassword: "pw",
      pin: "1234",
      pinConfirm: "4321",
    });

    expect(result).toEqual({ ok: false, message: PIN_TOGGLE_MISMATCH_MESSAGE });
    expect(readVaultMock).not.toHaveBeenCalled();
  });

  it("rejects a wrong master password and writes nothing", async () => {
    const { diskBytes } = await openVaultOnDisk("right password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await enableOrChangePin({
      vaultPath: "D:/vault/vault.dat",
      masterPassword: "wrong password",
      pin: "1234",
      pinConfirm: "1234",
    });

    expect(result).toEqual({ ok: false, message: PIN_TOGGLE_PASSWORD_ERROR_MESSAGE });
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });

  it("on success, writes a PinWrap and a zeroed pinLockout to vault.settings.json", async () => {
    const { diskBytes } = await openVaultOnDisk("correct password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await enableOrChangePin({
      vaultPath: "D:/vault/vault.dat",
      masterPassword: "correct password",
      pin: "1234",
      pinConfirm: "1234",
    });

    expect(result).toEqual({ ok: true });
    const settingsWrite = writeVaultAtomicMock.mock.calls.find(([path]) => path === "D:/vault/vault.settings.json");
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(new TextDecoder().decode(settingsWrite![1]));
    expect(typeof written.pin.salt).toBe("string");
    expect(typeof written.pin.iv).toBe("string");
    expect(typeof written.pin.wrappedKey).toBe("string");
    expect(written.pin.iterations).toBeGreaterThanOrEqual(600_000);
    expect(written.pinLockout).toEqual({ failedAttempts: 0, lockedUntil: null });
  });
});

describe("disablePin", () => {
  it("rejects a wrong master password and writes nothing", async () => {
    const { diskBytes } = await openVaultOnDisk("right password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await disablePin({ vaultPath: "D:/vault/vault.dat", masterPassword: "wrong password" });

    expect(result).toEqual({ ok: false, message: PIN_TOGGLE_PASSWORD_ERROR_MESSAGE });
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });

  it("on success, clears pin/pinLockout in vault.settings.json", async () => {
    const { diskBytes } = await openVaultOnDisk("correct password");
    readVaultMock.mockResolvedValue(diskBytes);

    const result = await disablePin({ vaultPath: "D:/vault/vault.dat", masterPassword: "correct password" });

    expect(result).toEqual({ ok: true });
    const settingsWrite = writeVaultAtomicMock.mock.calls.find(([path]) => path === "D:/vault/vault.settings.json");
    expect(settingsWrite).toBeDefined();
    const written = JSON.parse(new TextDecoder().decode(settingsWrite![1]));
    expect(written).not.toHaveProperty("pin");
    expect(written).not.toHaveProperty("pinLockout");
  });
});
