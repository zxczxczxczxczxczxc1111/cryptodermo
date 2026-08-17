import { beforeEach, describe, expect, it, vi } from "vitest";
import { isSecretFieldStale, hasStaleSecretField, formatDeleteConfirmMessage } from "./RecordCard";
import { VaultStore, ItemCountDecreasedError, type Item } from "../lib/vaultStore";

// RecordCard.tsx вызывает store.save() (кнопка "Удалить запись", живой
// прогон 2026-08-17) - тот же приём мокирования файлового слоя, что и в
// vaultStore.test.ts (весь ../lib/tauriApi замокан, реальный Tauri IPC в
// тестах на Node недоступен).
vi.mock("../lib/tauriApi", () => ({
  readVault: vi.fn(),
  writeVaultAtomic: vi.fn(),
  listBackups: vi.fn(),
  rotateBackups: vi.fn(),
}));

import { readVault, writeVaultAtomic, listBackups, rotateBackups } from "../lib/tauriApi";

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

// Проверяет только чистую логику "возраст секретного поля" (spec.md §8,
// один из разделов спецификации, приложенных к тикету) - не рендер
// компонента (нет jsdom/@testing-library/react в проекте, добавлять ради
// одного тикета - новая зависимость без отдельного вопроса, R31). Это не
// весь компонент "на всякий случай" - конкретный именованный шов из
// спецификации: "у секретного поля записи (secret: true) пароль не
// менялся больше года... точка на самой записи в списке и на поле в
// карточке. Возраст считается по дате последнего изменения этого поля:
// если поле хотя бы раз попадало в history, берётся дата последней записи
// history, иначе - updatedAt".

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "1",
    type: "login",
    title: "Test",
    tags: [],
    fields: [],
    note: "",
    attachments: [],
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("isSecretFieldStale", () => {
  it("is true when the field (via updatedAt fallback, no history) last changed about two years ago", () => {
    const item = makeItem({
      updatedAt: "2024-01-01T00:00:00.000Z",
      fields: [{ name: "password", value: "x", secret: true }],
    });
    expect(isSecretFieldStale(item, "password", new Date("2026-08-16T00:00:00.000Z"))).toBe(true);
  });

  it("is false when the field changed about a month ago", () => {
    const item = makeItem({
      updatedAt: "2026-07-16T00:00:00.000Z",
      fields: [{ name: "password", value: "x", secret: true }],
    });
    expect(isSecretFieldStale(item, "password", new Date("2026-08-16T00:00:00.000Z"))).toBe(false);
  });

  it("uses the latest history entry that touched this specific field, not the record's own updatedAt", () => {
    // item.updatedAt is recent (some OTHER field of the same record changed
    // later), but THIS field's own last change sits in `history`, about two
    // years back - spec.md §8 says the age is per-field, not per-record.
    const item = makeItem({
      updatedAt: "2026-08-01T00:00:00.000Z",
      fields: [{ name: "password", value: "current", secret: true }],
      history: [{ fields: [{ name: "password", value: "old" }], changedAt: "2024-01-01T00:00:00.000Z" }],
    });
    expect(isSecretFieldStale(item, "password", new Date("2026-08-16T00:00:00.000Z"))).toBe(true);
  });
});

describe("hasStaleSecretField", () => {
  const now = new Date("2026-08-16T00:00:00.000Z");

  it("is true when at least one secret field is stale, even if another secret field is fresh", () => {
    const item = makeItem({
      fields: [
        { name: "old-password", value: "x", secret: true },
        { name: "new-password", value: "y", secret: true },
      ],
      history: [{ fields: [{ name: "new-password", value: "z" }], changedAt: "2026-08-01T00:00:00.000Z" }],
      updatedAt: "2024-01-01T00:00:00.000Z", // фолбэк для old-password, у которого нет своей истории
    });
    expect(hasStaleSecretField(item, now)).toBe(true);
  });

  it("is false when every secret field is fresh", () => {
    const item = makeItem({
      updatedAt: "2026-08-01T00:00:00.000Z",
      fields: [{ name: "password", value: "x", secret: true }],
    });
    expect(hasStaleSecretField(item, now)).toBe(false);
  });

  it("ignores non-secret fields even if they are very old - the status is defined only for secret:true", () => {
    const item = makeItem({
      updatedAt: "2020-01-01T00:00:00.000Z",
      fields: [{ name: "username", value: "old-but-not-secret", secret: false }],
    });
    expect(hasStaleSecretField(item, now)).toBe(false);
  });
});

// Живой прогон (2026-08-17): в интерфейсе не было способа удалить запись
// целиком - только удаление отдельного вложения (handleDeleteAttachment,
// уже существовал). RecordCard.tsx получил кнопку "Удалить запись" в шапке
// + модалку подтверждения (handleDeleteItem). Компонентный рендер клика по
// кнопке здесь не протестировать (нет jsdom - см. комментарий в шапке этого
// файла), поэтому проверяется (а) точный текст подтверждения
// (formatDeleteConfirmMessage, тот же приём вынесения текста модалки в
// чистую функцию, что и formatCountDecreaseMessage в Editor.tsx) и (б) сама
// последовательность вызовов VaultStore, которую использует
// handleDeleteItem: store.deleteItem(id), затем
// store.save(path, { allowCountDecrease: true }).
describe("Удаление записи целиком (живой прогон 2026-08-17)", () => {
  it("formatDeleteConfirmMessage содержит точное название записи и предупреждение о необратимости", () => {
    expect(formatDeleteConfirmMessage("GitHub")).toBe("Удалить запись «GitHub»? Действие нельзя отменить.");
  });

  it("запись без названия получает тот же запасной текст, что и список (List.tsx: '(без названия)')", () => {
    expect(formatDeleteConfirmMessage("")).toBe("Удалить запись «(без названия)»? Действие нельзя отменить.");
  });

  // Второй аргумент save() ниже - НЕ то, что буквально просил бриф ("await
  // store.save(vaultPath)" без опций): осознанное отступление, задокументи-
  // ровано в handleDeleteItem (RecordCard.tsx). Удаление ОДНОЙ записи всегда
  // уменьшает store.items.length относительно loadedCount (выставляется при
  // последней успешной loadFromBytes/save - R28, vaultStore.ts), поэтому
  // голый save() без allowCountDecrease бросал бы ItemCountDecreasedError на
  // КАЖДОЕ удаление записи - см. vaultStore.test.ts, describe "VaultStore:
  // save() refuses a silent item-count decrease (R28)". Модалка
  // подтверждения ("Действие нельзя отменить") - и есть то самое явное
  // согласие пользователя на уменьшение числа записей; второй диалог R28
  // поверх неё был бы избыточным повтором одного и того же решения.
  it("store.deleteItem + store.save(path, { allowCountDecrease: true }) реально убирает запись без ItemCountDecreasedError - именно эта последовательность используется обработчиком кнопки в RecordCard.tsx", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));

    const seed = new VaultStore();
    await seed.createNewVault("pw", 1000);
    const keep = seed.addItem({ type: "note", title: "keep", tags: [], fields: [] });
    const toDelete = seed.addItem({ type: "note", title: "delete me", tags: [], fields: [] });

    const store = new VaultStore();
    await store.loadFromBytes(await seed.toBytes(), "pw"); // выставляет loadedCount = 2 (R28)

    store.deleteItem(toDelete.id);
    await expect(store.save("D:/vault/vault.dat", { allowCountDecrease: true })).resolves.toBeUndefined();

    const remaining = store.search("");
    expect(remaining.map((i: Item) => i.id)).toEqual([keep.id]);
    expect(writeVaultAtomicMock).toHaveBeenCalled();
  });

  it("документирует, почему allowCountDecrease обязателен: то же самое удаление БЕЗ него бросает ItemCountDecreasedError (guard against silently reverting to the literal `store.save(vaultPath)` from the brief)", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));

    const seed = new VaultStore();
    await seed.createNewVault("pw", 1000);
    const only = seed.addItem({ type: "note", title: "solo", tags: [], fields: [] });

    const store = new VaultStore();
    await store.loadFromBytes(await seed.toBytes(), "pw");

    store.deleteItem(only.id);
    await expect(store.save("D:/vault/vault.dat")).rejects.toThrow(ItemCountDecreasedError);
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });
});
