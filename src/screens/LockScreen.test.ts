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
  NETWORK_NODE_COUNT,
  SUCCESS_DISPERSE_MS,
  nodePositionAt,
  generateNodeSeeds,
  disperseProgress,
  disruptConnectionStrength,
  stepIntensity,
  isMotionAllowed,
  type NetworkNodeSeed,
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

describe("nodePositionAt (позиции узлов сети - R73)", () => {
  // Seed с "круглыми" частотами - на выбранных t угол w*t+phase попадает
  // ровно в 0/pi/2/pi точно, значения синуса известны без вычислений (0, 1,
  // 0, -1) - посчитано вручную по формуле из JSDoc функции, не получено
  // вызовом самой nodePositionAt.
  const seed: NetworkNodeSeed = {
    cx: 0.5,
    cy: 0.4,
    rx1: 0.1,
    ry1: 0.08,
    rx2: 0.02,
    ry2: 0.01,
    wx1: Math.PI / 2000,
    wy1: Math.PI / 2000,
    wx2: Math.PI / 1000,
    wy2: Math.PI / 1000,
    px1: 0,
    py1: Math.PI / 2,
    px2: Math.PI / 2,
    py2: 0,
  };

  it("at t=0 equals cx/cy plus the sine of each harmonic's own phase", () => {
    // x = 0.5 + 0.1*sin(0) + 0.02*sin(pi/2) = 0.5 + 0 + 0.02 = 0.52
    // y = 0.4 + 0.08*sin(pi/2) + 0.01*sin(0) = 0.4 + 0.08 + 0 = 0.48
    const pos = nodePositionAt(seed, 0);
    expect(pos.x).toBeCloseTo(0.52, 6);
    expect(pos.y).toBeCloseTo(0.48, 6);
  });

  it("at t=1000ms both harmonics land on clean angles (pi/2 and pi) and shift accordingly", () => {
    // wx1*1000=pi/2 (+px1=0) -> sin=1;  wx2*1000=pi (+px2=pi/2) -> sin(3pi/2)=-1
    // x = 0.5 + 0.1*1 + 0.02*(-1) = 0.58
    // wy1*1000=pi/2 (+py1=pi/2) -> sin(pi)=0;  wy2*1000=pi (+py2=0) -> sin(pi)=0
    // y = 0.4 + 0.08*0 + 0.01*0 = 0.4
    const pos = nodePositionAt(seed, 1000);
    expect(pos.x).toBeCloseTo(0.58, 6);
    expect(pos.y).toBeCloseTo(0.4, 6);
  });
});

describe("generateNodeSeeds (R80 - число узлов - именованная константа)", () => {
  it("creates exactly as many seeds as requested by NETWORK_NODE_COUNT", () => {
    expect(generateNodeSeeds(NETWORK_NODE_COUNT)).toHaveLength(NETWORK_NODE_COUNT);
  });

  it("is driven entirely by its count argument, not a hardcoded number", () => {
    // Критерий приёмки: "уменьшение константы видимо снижает нагрузку без
    // правки остальной логики" - это возможно только если сам генератор (и
    // через него весь перебор соединений в drawFrame) ничего не хардкодит.
    expect(generateNodeSeeds(5)).toHaveLength(5);
    expect(generateNodeSeeds(1)).toHaveLength(1);
  });
});

describe("disperseProgress (успешная разблокировка - R76, 400ms из спецификации §16)", () => {
  it("uses exactly 400ms, per the spec's literal wording", () => {
    expect(SUCCESS_DISPERSE_MS).toBe(400);
  });

  it("starts fully assembled and visible (spread 0, opacity 1)", () => {
    expect(disperseProgress(0, 400)).toEqual({ spread: 0, opacity: 1 });
  });

  it("ends fully dispersed and invisible (spread 1, opacity 0) exactly at the duration", () => {
    expect(disperseProgress(400, 400)).toEqual({ spread: 1, opacity: 0 });
  });

  it("does not extrapolate past the end state when a frame lands after the duration", () => {
    // rAF почти никогда не попадает ровно в 400ms - кадр на 600ms должен
    // выглядеть так же, как кадр ровно на 400ms, не "перелетать" дальше.
    expect(disperseProgress(600, 400)).toEqual({ spread: 1, opacity: 0 });
  });

  it("follows easeOutCubic/easeInCubic at the midpoint", () => {
    // t=0.5: spread = 1-(1-0.5)^3 = 1-0.125 = 0.875; opacity = 1-0.5^3 = 0.875
    expect(disperseProgress(200, 400)).toEqual({ spread: 0.875, opacity: 0.875 });
  });
});

describe("disruptConnectionStrength (неверный пароль - R77, сеть теряет связи и собирается заново)", () => {
  it("starts fully connected the instant the error fires", () => {
    expect(disruptConnectionStrength(0, 1000)).toBeCloseTo(1, 6);
  });

  it("drops to fully disconnected at the midpoint - 'теряет связи'", () => {
    // t=0.5 -> 1 - sin(pi/2) = 1 - 1 = 0
    expect(disruptConnectionStrength(500, 1000)).toBeCloseTo(0, 6);
  });

  it("is fully reconnected again by the end of the duration - 'собирается заново'", () => {
    // t=1 -> 1 - sin(pi) = 1 - 0 = 1
    expect(disruptConnectionStrength(1000, 1000)).toBeCloseTo(1, 6);
  });

  it("does not stay disconnected past the duration", () => {
    expect(disruptConnectionStrength(1500, 1000)).toBeCloseTo(1, 6);
  });
});

describe("stepIntensity (R75 - плавный переход скорости/плотности сети при busy)", () => {
  it("matches the textbook exponential smoothing formula at dt == smoothingMs", () => {
    // decay = e^-1 = 0.36787944117144233 (табличная константа, не вычислена
    // вызовом функции под тестом)
    // next = target + (current-target)*decay = 3 + (1-3)*0.36787944117144233
    //      = 3 - 0.73575888234288466 = 2.26424111765711534
    const next = stepIntensity(1, 3, 250, 250);
    expect(next).toBeCloseTo(2.264241, 6);
  });

  it("returns the current value unchanged when no time has passed", () => {
    expect(stepIntensity(0.42, 1, 0, 250)).toBeCloseTo(0.42, 9);
  });

  it("snaps instantly to the target when smoothing is disabled (smoothingMs <= 0)", () => {
    expect(stepIntensity(0, 1, 16, 0)).toBe(1);
  });
});

describe("isMotionAllowed (prefers-reduced-motion - R78)", () => {
  it("disallows animation when the media query matches (reduce)", () => {
    expect(isMotionAllowed(true)).toBe(false);
  });

  it("allows animation when the media query does not match", () => {
    expect(isMotionAllowed(false)).toBe(true);
  });

  it("defaults to allowing animation when the preference could not be read", () => {
    expect(isMotionAllowed(undefined)).toBe(true);
    expect(isMotionAllowed(null)).toBe(true);
  });
});
