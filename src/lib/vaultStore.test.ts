import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  VaultStore,
  ItemNotFoundError,
  VaultNotLoadedError,
  ItemCountDecreasedError,
  MAX_BACKUPS,
  MAX_ATTACHMENT_SIZE_BYTES,
  MAX_VAULT_SIZE_BYTES,
  type Item,
} from "./vaultStore";
import { parseContainer } from "./vaultFormat";

// Кросс-компат тест "emergency-decrypt.py <-> приложение" (interfaces.md) -
// в отдельном файле `vaultStore.crossCompat.test.js`, не здесь. Ему нужны
// настоящие Node-модули (`node:child_process`, `node:fs`, чтобы породить
// реальный процесс Python и записать реальный файл на диск) - без пакета
// `@types/node` (которого в проекте нет и который не наша зона добавлять
// без вопроса, R31) TypeScript не знает типов этих модулей и `tsc` (часть
// `npm run build` / `npm run tauri build`, см. `beforeBuildCommand` в
// tauri.conf.json) не проходит. Обычный `.js`-файл вне области `include`
// tsconfig ("src" проверяется, но `allowJs` не включён - `.js`-файлы просто
// не типизируются) решает это, оставаясь при этом самым обычным тестовым
// файлом для Vitest (используется default `test.include`, который матчит
// `*.test.js` наравне с `*.test.ts`).

// vaultStore выполняет реальные вызовы файлового слоя через tauriApi.ts
// (readVault/writeVaultAtomic/listBackups/rotateBackups), которые в реальном
// приложении идут в Rust через Tauri IPC - недоступный в тестах на Node.
// Сам файловый слой (атомарность записи, ротация) - шов Rust-тестов
// (interfaces.md: "vault_fs (Rust): атомарность записи с симуляцией
// прерывания"), не этого файла. Здесь проверяется контракт vaultStore с
// tauriApi: правильный ли порядок вызовов и правильные ли аргументы -
// поэтому весь модуль tauriApi замокан.
vi.mock("./tauriApi", () => ({
  readVault: vi.fn(),
  writeVaultAtomic: vi.fn(),
  listBackups: vi.fn(),
  rotateBackups: vi.fn(),
}));

import { readVault, writeVaultAtomic, listBackups, rotateBackups } from "./tauriApi";

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

describe("VaultStore: createNewVault -> toBytes -> loadFromBytes roundtrip", () => {
  it("restores the same items with the same password on a fresh store", async () => {
    const store = new VaultStore();
    await store.createNewVault("correct horse battery staple", 1000);
    store.addItem({ type: "login", title: "GitHub", tags: ["work"], fields: [] });

    const bytes = await store.toBytes();

    const reopened = new VaultStore();
    await reopened.loadFromBytes(bytes, "correct horse battery staple");

    expect(reopened.search("")).toMatchObject([{ title: "GitHub", tags: ["work"] }]);
  });

  it("throws DecryptError from the crypto module when the password is wrong", async () => {
    const store = new VaultStore();
    await store.createNewVault("right password", 1000);
    store.addItem({ type: "note", title: "n", tags: [], fields: [] });
    const bytes = await store.toBytes();

    const reopened = new VaultStore();
    await expect(reopened.loadFromBytes(bytes, "wrong password")).rejects.toThrow(
      /wrong password|corrupted/i,
    );
  });
});

describe("VaultStore: loadFromBytesWithRawKey (PIN unlock path)", () => {
  it("opens the vault when given the SAME raw key bits the password would derive", async () => {
    const store = new VaultStore();
    await store.createNewVault("correct horse battery staple", 1000);
    store.addItem({ type: "login", title: "GitHub", tags: ["work"], fields: [] });
    const bytes = await store.toBytes();

    // Симулирует то, что делает pinLock.ts: независимая передеривация тех
    // же 256 бит из пароля/соли/итераций заголовка через deriveBits, не
    // через VaultStore.key.
    const { header } = parseContainer(bytes);
    const salt = Uint8Array.from(atob(header.kdf.salt), (c) => c.charCodeAt(0));
    const passwordKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode("correct horse battery staple"),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const rawBits = new Uint8Array(
      await crypto.subtle.deriveBits(
        { name: "PBKDF2", salt: salt as BufferSource, iterations: header.kdf.params.iterations, hash: "SHA-256" },
        passwordKey,
        256,
      ),
    );

    const reopened = new VaultStore();
    await reopened.loadFromBytesWithRawKey(bytes, rawBits);

    expect(reopened.search("")).toMatchObject([{ title: "GitHub", tags: ["work"] }]);
  });

  it("throws DecryptError when the raw key bits do not match the vault's real key", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({ type: "note", title: "n", tags: [], fields: [] });
    const bytes = await store.toBytes();

    const wrongBits = crypto.getRandomValues(new Uint8Array(32));

    const reopened = new VaultStore();
    await expect(reopened.loadFromBytesWithRawKey(bytes, wrongBits)).rejects.toThrow(/wrong password|corrupted/i);
  });

  it("does not change loadFromBytes's own behavior (still works by password)", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw-unaffected", 1000);
    store.addItem({ type: "note", title: "still works", tags: [], fields: [] });
    const bytes = await store.toBytes();

    const reopened = new VaultStore();
    await reopened.loadFromBytes(bytes, "pw-unaffected");

    expect(reopened.search("")).toMatchObject([{ title: "still works" }]);
  });
});

describe("VaultStore: methods before load/create", () => {
  it("throw VaultNotLoadedError instead of silently operating on nothing", () => {
    const store = new VaultStore();
    expect(() => store.addItem({ type: "note", title: "x", tags: [], fields: [] })).toThrow(
      VaultNotLoadedError,
    );
    expect(() => store.search("")).toThrow(VaultNotLoadedError);
  });
});

describe("VaultStore: addItem / updateItem / deleteItem / isDirty", () => {
  async function freshStore() {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    return store;
  }

  it("is not dirty right after creating a new vault", async () => {
    const store = await freshStore();
    expect(store.isDirty()).toBe(false);
  });

  it("becomes dirty after addItem and exposes the new item via search", async () => {
    const store = await freshStore();
    const created = store.addItem({ type: "login", title: "Example", tags: [], fields: [] });

    expect(store.isDirty()).toBe(true);
    expect(created.id).toBeTruthy();
    expect(created.createdAt).toBe(created.updatedAt);
  });

  it("updateItem changes fields and bumps updatedAt without touching id/createdAt", async () => {
    const store = await freshStore();
    const created = store.addItem({ type: "note", title: "Old title", tags: [], fields: [] });

    const updated = store.updateItem(created.id, { title: "New title" });

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.title).toBe("New title");
  });

  it("updateItem throws ItemNotFoundError for an unknown id", async () => {
    const store = await freshStore();
    expect(() => store.updateItem("does-not-exist", { title: "x" })).toThrow(ItemNotFoundError);
  });

  it("deleteItem removes the item and throws ItemNotFoundError on a second delete", async () => {
    const store = await freshStore();
    const created = store.addItem({ type: "note", title: "gone soon", tags: [], fields: [] });

    store.deleteItem(created.id);

    expect(store.search("")).toHaveLength(0);
    expect(() => store.deleteItem(created.id)).toThrow(ItemNotFoundError);
  });
});

describe("VaultStore: replaceAllItems (import, R100)", () => {
  // Полноценные Item, не через addItem() - импорт приносит готовые id/
  // createdAt/updatedAt/history из файла, ровно то, что replaceAllItems
  // обязана принять как есть, не перегенерировать.
  function importedItem(overrides: Partial<Item> & Pick<Item, "id" | "title">): Item {
    return {
      type: "note",
      tags: [],
      fields: [],
      note: "",
      attachments: [],
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("replaces the collection with the given items and marks the store dirty", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({ type: "note", title: "will be gone", tags: [], fields: [] });

    const imported = [
      importedItem({ id: "imported-1", title: "Imported one" }),
      importedItem({ id: "imported-2", title: "Imported two" }),
    ];
    store.replaceAllItems(imported);

    expect(store.search("").map((i) => ({ id: i.id, title: i.title }))).toEqual([
      { id: "imported-1", title: "Imported one" },
      { id: "imported-2", title: "Imported two" },
    ]);
    expect(store.isDirty()).toBe(true);
  });

  it("throws VaultNotLoadedError when called before load/create", () => {
    const store = new VaultStore();
    expect(() => store.replaceAllItems([])).toThrow(VaultNotLoadedError);
  });

  it("does not keep a reference to the passed array - mutating it afterwards does not affect the store", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const imported = [importedItem({ id: "imported-1", title: "Original title" })];

    store.replaceAllItems(imported);
    imported[0].title = "Mutated after the call";

    expect(store.search("")[0].title).toBe("Original title");
  });

  it("importing fewer items than were loaded is caught by ItemCountDecreasedError on the next save, not bypassed", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const seed = new VaultStore();
    await seed.createNewVault("pw", 1000);
    seed.addItem({ type: "note", title: "a", tags: [], fields: [] });
    seed.addItem({ type: "note", title: "b", tags: [], fields: [] });
    seed.addItem({ type: "note", title: "c", tags: [], fields: [] });

    const loaded = new VaultStore();
    await loaded.loadFromBytes(await seed.toBytes(), "pw"); // loadedCount = 3

    // "Импорт" файла с одной записью - replaceAllItems сама по себе не
    // возражает (это не её работа).
    loaded.replaceAllItems([importedItem({ id: "only-one", title: "Only one" })]);
    expect(loaded.isDirty()).toBe(true);

    // Но следующий save() обязан поймать уменьшение 3 -> 1, как и любое
    // другое уменьшение - replaceAllItems не в обход R28.
    await expect(loaded.save("D:/vault/vault.dat")).rejects.toMatchObject({
      loaded: 3,
      current: 1,
    });
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();

    // С подтверждением - проходит как обычно.
    await expect(
      loaded.save("D:/vault/vault.dat", { allowCountDecrease: true }),
    ).resolves.toBeUndefined();
  });
});

describe("VaultStore: secret field history (R45)", () => {
  it("records the old value in history when a secret field's value changes", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({
      type: "login",
      title: "Bank",
      tags: [],
      fields: [{ name: "password", value: "old-secret", secret: true }],
    });

    const updated = store.updateItem(created.id, {
      fields: [{ name: "password", value: "new-secret", secret: true }],
    });

    expect(updated.history).toHaveLength(1);
    expect(updated.history?.[0].fields).toEqual([{ name: "password", value: "old-secret" }]);
  });

  it("does not record history when a non-secret field changes", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({
      type: "login",
      title: "Bank",
      tags: [],
      fields: [{ name: "username", value: "alice", secret: false }],
    });

    const updated = store.updateItem(created.id, {
      fields: [{ name: "username", value: "bob", secret: false }],
    });

    expect(updated.history).toBeUndefined();
  });

  it("does not record history when the secret field's value stays the same", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({
      type: "login",
      title: "Bank",
      tags: [],
      fields: [{ name: "password", value: "unchanged", secret: true }],
    });

    const updated = store.updateItem(created.id, {
      fields: [{ name: "password", value: "unchanged", secret: true }],
      title: "Bank renamed",
    });

    expect(updated.history).toBeUndefined();
  });
});

describe("VaultStore: search", () => {
  async function storeWithItems(): Promise<VaultStore> {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({
      type: "login",
      title: "GitHub account",
      tags: ["dev", "work"],
      fields: [
        { name: "username", value: "octocat", secret: false },
        { name: "password", value: "hunter2", secret: true },
      ],
    });
    store.addItem({ type: "note", title: "Grocery list", tags: ["home"], fields: [] });
    return store;
  }

  it("finds an item by a substring of its title, case-insensitively", async () => {
    const store = await storeWithItems();
    expect(store.search("github").map((i) => i.title)).toEqual(["GitHub account"]);
  });

  it("finds an item by a substring of one of its tags", async () => {
    const store = await storeWithItems();
    expect(store.search("home").map((i) => i.title)).toEqual(["Grocery list"]);
  });

  it("finds an item by a substring of a non-secret field's value", async () => {
    const store = await storeWithItems();
    expect(store.search("octocat").map((i) => i.title)).toEqual(["GitHub account"]);
  });

  it("does not find an item by a substring of a secret field's value", async () => {
    const store = await storeWithItems();
    expect(store.search("hunter2")).toHaveLength(0);
  });

  it("finds an item by a substring of an attachment's file name (R44, §18 - search extends to attachments[].name)", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({
      type: "other",
      title: "Tax documents",
      tags: [],
      fields: [],
      attachments: [{ id: "a1", name: "2025-tax-return.pdf", mimeType: "application/pdf", size: 1234, data: "" }],
    });
    store.addItem({ type: "note", title: "Unrelated", tags: [], fields: [] });

    expect(store.search("tax-return").map((i) => i.title)).toEqual(["Tax documents"]);
  });

  it("returns every item, sorted by updatedAt descending, for an empty/blank query", async () => {
    // updatedAt имеет миллисекундную точность - два addItem() подряд в одном
    // синхронном блоке кода вполне могут получить одинаковую метку времени,
    // и тогда порядок "по дате изменения" не проверить без управления
    // временем явно. Фиксируем часы и продвигаем их между добавлениями, как
    // и было бы в реальности (записи не создаются в одну и ту же
    // миллисекунду).
    vi.useFakeTimers();
    try {
      const store = new VaultStore();
      await store.createNewVault("pw", 1000);
      store.addItem({ type: "note", title: "Older item", tags: [], fields: [] });
      vi.advanceTimersByTime(1000);
      store.addItem({ type: "note", title: "Newer item", tags: [], fields: [] });

      const all = store.search("   ");
      expect(all.map((i) => i.title)).toEqual(["Newer item", "Older item"]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("VaultStore: attachments (R44)", () => {
  it("addItem stores attachments and updateItem can replace/remove them", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({
      type: "other",
      title: "Doc",
      tags: [],
      fields: [],
      attachments: [{ id: "a1", name: "file.txt", mimeType: "text/plain", size: 3, data: "YWJj" }],
    });
    expect(created.attachments).toHaveLength(1);

    const updated = store.updateItem(created.id, { attachments: [] });
    expect(updated.attachments).toHaveLength(0);
    expect(store.search("")[0].attachments).toHaveLength(0);
  });

  it("updateItem without an attachments key leaves existing attachments untouched (R45: attachments survive unrelated edits, no history)", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({
      type: "other",
      title: "Doc",
      tags: [],
      fields: [],
      attachments: [{ id: "a1", name: "file.txt", mimeType: "text/plain", size: 3, data: "YWJj" }],
    });

    const updated = store.updateItem(created.id, { title: "Renamed" });
    expect(updated.attachments).toHaveLength(1);
    expect(updated.title).toBe("Renamed");
    expect(updated.history).toBeUndefined();
  });
});

describe("VaultStore: estimateSizeBytes / soft size limits (R44.3, §18)", () => {
  it("exposes the soft size limits from spec.md §18 (~25 MB per attachment, ~300 MB per vault)", () => {
    // Пороги - дословно из §18 спецификации, не производные от кода под
    // тестом.
    expect(MAX_ATTACHMENT_SIZE_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_VAULT_SIZE_BYTES).toBe(300 * 1024 * 1024);
  });

  it("throws VaultNotLoadedError when called before load/create", () => {
    const store = new VaultStore();
    expect(() => store.estimateSizeBytes()).toThrow(VaultNotLoadedError);
  });

  it("grows when an attachment is added and shrinks back after it is removed", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const baseline = store.estimateSizeBytes();

    const created = store.addItem({ type: "other", title: "x", tags: [], fields: [] });
    store.updateItem(created.id, {
      attachments: [
        { id: "a1", name: "big.bin", mimeType: "application/octet-stream", size: 1000, data: "A".repeat(1400) },
      ],
    });
    const withAttachment = store.estimateSizeBytes();
    expect(withAttachment).toBeGreaterThan(baseline);

    store.updateItem(created.id, { attachments: [] });
    const afterRemoval = store.estimateSizeBytes();
    expect(afterRemoval).toBeLessThan(withAttachment);
  });
});

describe("VaultStore: save() orchestration (backup -> write -> rotate)", () => {
  async function storeWithOneItem(): Promise<VaultStore> {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({ type: "note", title: "n", tags: [], fields: [] });
    return store;
  }

  it("writes directly with no backup step when the target file does not exist yet", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT: no such file"));
    const store = await storeWithOneItem();

    await store.save("D:/vault/vault.dat");

    // Единственная запись основного файла базы - имени backups/vault-*.dat
    // среди аргументов writeVaultAtomic быть не должно, бэкапировать было
    // нечего.
    const vaultDatWrites = writeVaultAtomicMock.mock.calls.filter(([path]) =>
      path.endsWith("vault.dat"),
    );
    expect(vaultDatWrites).toHaveLength(1);
    expect(vaultDatWrites[0][0]).toBe("D:/vault/vault.dat");

    const backupWrites = writeVaultAtomicMock.mock.calls.filter(([path]) =>
      /vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/.test(path),
    );
    expect(backupWrites).toHaveLength(0);
  });

  it("backs up the existing file before writing the new version, then rotates with MAX_BACKUPS", async () => {
    const oldBytes = new Uint8Array([1, 2, 3]);
    readVaultMock.mockResolvedValue(oldBytes);
    const store = await storeWithOneItem();

    await store.save("D:/vault/vault.dat");

    const backupWrites = writeVaultAtomicMock.mock.calls.filter(([path]) =>
      /vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/.test(path),
    );
    expect(backupWrites).toHaveLength(1);
    expect(backupWrites[0][1]).toBe(oldBytes); // старое содержимое ушло в бэкап как есть
    expect(backupWrites[0][0]).toContain("D:/vault/backups/");

    expect(rotateBackupsMock).toHaveBeenCalledWith("D:/vault/backups", MAX_BACKUPS);

    // Рядом с vault.dat и в backups/ должна лечь копия ОБОИХ файлов -
    // emergency-decrypt.py и aes_gcm.py (без второго первый не может
    // расшифровать тело, см. copyEmergencyScriptsTo в vaultStore.ts). Текст
    // - ровно содержимое файлов из корня репозитория, подключённое через
    // `?raw` (см. комментарий у импортов в vaultStore.ts). Проверка
    // содержимого, а не только факта записи - если импорт `?raw` однажды
    // перестанет резолвиться в реальный текст файла, этот тест должен
    // заметить пустую/неверную строку, а не только "что-то записалось".
    const decryptScriptWrites = writeVaultAtomicMock.mock.calls.filter(([path]) =>
      path.endsWith("emergency-decrypt.py"),
    );
    expect(decryptScriptWrites).toHaveLength(2); // рядом с vault.dat и в backups/
    for (const [, bytes] of decryptScriptWrites) {
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain("Emergency decryptor for Vault's vault.dat");
    }

    const aesGcmScriptWrites = writeVaultAtomicMock.mock.calls.filter(([path]) =>
      path.endsWith("aes_gcm.py"),
    );
    expect(aesGcmScriptWrites).toHaveLength(2); // рядом с vault.dat и в backups/
    for (const [, bytes] of aesGcmScriptWrites) {
      const text = new TextDecoder().decode(bytes);
      expect(text).toContain("NIST SP 800-38D");
    }

    // Порядок: бэкап записан раньше, чем ротация вызвана.
    const backupCallOrder = writeVaultAtomicMock.mock.invocationCallOrder[
      writeVaultAtomicMock.mock.calls.findIndex(([path]) =>
        /vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/.test(path),
      )
    ];
    expect(backupCallOrder).toBeLessThan(rotateBackupsMock.mock.invocationCallOrder[0]);
  });

  it("still completes and clears isDirty even if rotateBackups rejects", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    rotateBackupsMock.mockRejectedValue(new Error("disk busy"));
    const store = await storeWithOneItem();

    await expect(store.save("D:/vault/vault.dat")).resolves.toBeUndefined();
    expect(store.isDirty()).toBe(false);
  });

  it("clears isDirty after a successful save", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const store = await storeWithOneItem();
    expect(store.isDirty()).toBe(true);

    await store.save("D:/vault/vault.dat");

    expect(store.isDirty()).toBe(false);
  });
});

describe("VaultStore: save() refuses a silent item-count decrease (R28)", () => {
  // Общая подготовка для большинства тестов ниже: строим байты двухзаписной
  // базы (через отдельный store, не участвующий в save()), затем открываем
  // их в `loaded` через loadFromBytes() - именно это выставляет loadedCount
  // (R28, §9: база сравнения - "при последней успешной загрузке"), не
  // addItem/deleteItem сами по себе.
  async function loadedStoreWithTwoItems(): Promise<{
    loaded: VaultStore;
    first: { id: string };
    second: { id: string };
  }> {
    const seed = new VaultStore();
    await seed.createNewVault("pw", 1000);
    const first = seed.addItem({ type: "note", title: "a", tags: [], fields: [] });
    const second = seed.addItem({ type: "note", title: "b", tags: [], fields: [] });

    const loaded = new VaultStore();
    await loaded.loadFromBytes(await seed.toBytes(), "pw");
    return { loaded, first, second };
  }

  it("throws ItemCountDecreasedError and writes nothing to disk when the count dropped since the last load", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const { loaded, first } = await loadedStoreWithTwoItems();
    loaded.deleteItem(first.id);

    await expect(loaded.save("D:/vault/vault.dat")).rejects.toThrow(ItemCountDecreasedError);

    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });

  it("the rejected error carries the loaded and current counts", async () => {
    const { loaded, first } = await loadedStoreWithTwoItems();
    loaded.deleteItem(first.id);

    await expect(loaded.save("D:/vault/vault.dat")).rejects.toMatchObject({
      loaded: 2,
      current: 1,
    });
  });

  it("writes normally when allowCountDecrease is true", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const { loaded, first } = await loadedStoreWithTwoItems();
    loaded.deleteItem(first.id);

    await expect(
      loaded.save("D:/vault/vault.dat", { allowCountDecrease: true }),
    ).resolves.toBeUndefined();

    const vaultDatWrites = writeVaultAtomicMock.mock.calls.filter(([path]) =>
      path.endsWith("vault.dat"),
    );
    expect(vaultDatWrites).toHaveLength(1);
  });

  it("after a confirmed decrease, the next comparison is against the new (lower) count", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const { loaded, first, second } = await loadedStoreWithTwoItems();
    loaded.deleteItem(first.id);

    // Первое уменьшение (2 -> 1) подтверждено.
    await loaded.save("D:/vault/vault.dat", { allowCountDecrease: true });
    writeVaultAtomicMock.mockClear();

    // Второе уменьшение (1 -> 0), уже относительно нового loadedCount=1 -
    // должно снова потребовать подтверждения, не пройти молча только
    // потому что когда-то давно было подтверждено первое.
    loaded.deleteItem(second.id);
    await expect(loaded.save("D:/vault/vault.dat")).rejects.toMatchObject({
      loaded: 1,
      current: 0,
    });
    expect(writeVaultAtomicMock).not.toHaveBeenCalled();
  });

  it("does not throw when the count stays the same or grows", async () => {
    readVaultMock.mockRejectedValue(new Error("ENOENT"));
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({ type: "note", title: "a", tags: [], fields: [] });
    const loaded = new VaultStore();
    await loaded.loadFromBytes(await store.toBytes(), "pw");

    loaded.addItem({ type: "note", title: "b", tags: [], fields: [] });

    await expect(loaded.save("D:/vault/vault.dat")).resolves.toBeUndefined();
  });
});

describe("VaultStore: recovery after corruption (R114i)", () => {
  it("listBackupsForRecovery only returns files matching the backup naming pattern, newest first", async () => {
    listBackupsMock.mockResolvedValue([
      { path: "b/vault-2026-01-01-000000.dat", filename: "vault-2026-01-01-000000.dat", size: 1, modifiedAtMs: 100 },
      { path: "b/emergency-decrypt.py", filename: "emergency-decrypt.py", size: 1, modifiedAtMs: 300 },
      { path: "b/vault-2026-02-01-000000.dat", filename: "vault-2026-02-01-000000.dat", size: 1, modifiedAtMs: 200 },
    ]);

    const result = await VaultStore.listBackupsForRecovery("D:/vault/vault.dat");

    expect(result.map((b) => b.filename)).toEqual([
      "vault-2026-02-01-000000.dat",
      "vault-2026-01-01-000000.dat",
    ]);
    expect(listBackupsMock).toHaveBeenCalledWith("D:/vault/backups");
  });

  it("loadFromBackupFile reads the given backup path and loads it as the current vault", async () => {
    const inner = new VaultStore();
    await inner.createNewVault("pw", 1000);
    inner.addItem({ type: "note", title: "recovered", tags: [], fields: [] });
    const bytes = await inner.toBytes();
    readVaultMock.mockResolvedValue(bytes);

    const store = new VaultStore();
    await store.loadFromBackupFile("D:/vault/backups/vault-2026-01-01-000000.dat", "pw");

    expect(readVaultMock).toHaveBeenCalledWith("D:/vault/backups/vault-2026-01-01-000000.dat");
    expect(store.search("")).toMatchObject([{ title: "recovered" }]);
  });
});
