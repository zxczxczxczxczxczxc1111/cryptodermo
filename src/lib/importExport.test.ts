import { describe, expect, it } from "vitest";
import { VaultStore, type Item } from "./vaultStore";
import {
  ImportValidationError,
  buildExportFilename,
  buildManualCopyFilename,
  buildReplaceConfirmationMessage,
  parseImportFile,
  serializeExport,
} from "./importExport";

// Швы из тикета 10 (R99/R100/R100.1, spec.md §12): разбор/валидация файла
// импорта, сериализация экспорта, имя файла по умолчанию с датой, текст
// двойного подтверждения. Сам компонент (диалоги, запись на диск) не
// покрыт автотестами по той же причине, что и PasswordGenerator/Editor -
// в проекте нет jsdom/@testing-library (см. их тестовые файлы), рендер и
// клики проверить юнит-тестом нечем.

const VALID_ITEM: Item = {
  id: "11111111-1111-1111-1111-111111111111",
  type: "login",
  title: "Пример",
  tags: ["work"],
  fields: [{ name: "пароль", value: "secret-value", secret: true }],
  note: "заметка",
  attachments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-02T00:00:00.000Z",
};

describe("parseImportFile: валидный файл (R100)", () => {
  it("разбирает JSON-массив валидных записей без искажений", () => {
    const text = JSON.stringify([VALID_ITEM]);
    expect(parseImportFile(text)).toEqual([VALID_ITEM]);
  });

  it("принимает пустой массив (файл экспорта пустой базы)", () => {
    expect(parseImportFile("[]")).toEqual([]);
  });
});

describe("parseImportFile: отказ целиком на некорректном файле (R100.1)", () => {
  it("бросает ImportValidationError на сломанном JSON", () => {
    expect(() => parseImportFile("{ this is not json")).toThrow(ImportValidationError);
  });

  it("бросает ImportValidationError, если верхний уровень - не массив", () => {
    expect(() => parseImportFile(JSON.stringify({ items: [VALID_ITEM] }))).toThrow(ImportValidationError);
  });

  it("бросает ImportValidationError, если у записи отсутствует обязательное поле", () => {
    const broken = { ...VALID_ITEM } as Partial<Item>;
    delete broken.title;
    expect(() => parseImportFile(JSON.stringify([broken]))).toThrow(ImportValidationError);
  });

  it("бросает ImportValidationError на неизвестном значении type", () => {
    const broken = { ...VALID_ITEM, type: "bogus" };
    expect(() => parseImportFile(JSON.stringify([broken]))).toThrow(ImportValidationError);
  });

  it("бросает ImportValidationError, если у поля записи secret не boolean", () => {
    const broken = { ...VALID_ITEM, fields: [{ name: "x", value: "y", secret: "yes" }] };
    expect(() => parseImportFile(JSON.stringify([broken]))).toThrow(ImportValidationError);
  });

  it("не возвращает частичный результат: первая невалидная запись останавливает разбор всего файла", () => {
    const broken = { ...VALID_ITEM } as Partial<Item>;
    delete broken.title;
    // Первая запись валидна, вторая - нет. Частичного успеха ("вернуть
    // только первую") быть не должно - весь вызов должен бросить.
    expect(() => parseImportFile(JSON.stringify([VALID_ITEM, broken]))).toThrow(ImportValidationError);
  });
});

describe("serializeExport: читаемый JSON (R100)", () => {
  it("производит форматированный (с отступами) JSON, разбираемый обратно в тот же массив", () => {
    const json = serializeExport([VALID_ITEM]);
    // "читается обычным текстовым редактором" (критерий приёмки тикета 10) -
    // многострочный, с отступами, не одна нечитаемая строка.
    expect(json).toContain("\n");
    expect(json).toContain("  ");
    expect(JSON.parse(json)).toEqual([VALID_ITEM]);
  });
});

describe("buildManualCopyFilename / buildExportFilename: дата в имени (R99/R100)", () => {
  it("включает дату и время в имя копии базы, отдельным префиксом от автоматических бэкапов", () => {
    const date = new Date(2026, 7, 16, 14, 5, 9); // 16 августа 2026, 14:05:09 (месяц с 0)
    const name = buildManualCopyFilename(date);
    expect(name).toBe("vault-copy-2026-08-16-140509.dat");
    // Не должно совпадать с шаблоном автоматических бэкапов ротации
    // (`vault-YYYY-MM-DD-HHmmss.dat` без "-copy-") - иначе попадёт в их
    // подсчёт лимита 20 штук, а тикет прямо требует обратного.
    expect(name).not.toMatch(/^vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/);
  });

  it("включает дату и время в имя файла экспорта", () => {
    const date = new Date(2026, 0, 3, 9, 0, 1); // 3 января 2026, 09:00:01
    expect(buildExportFilename(date)).toBe("vault-export-2026-01-03-090001.json");
  });
});

describe("buildReplaceConfirmationMessage: текст двойного подтверждения (R100)", () => {
  it("совпадает дословно с текстом из брифа/spec.md §12", () => {
    expect(buildReplaceConfirmationMessage(5, 3)).toBe("Заменить 5 записей текущей базы на 3 из файла?");
  });
});

describe("parseImportFile + VaultStore.replaceAllItems: реальное применение импорта (R100)", () => {
  it("заменяет коллекцию стора записями из файла один-в-один, включая id/createdAt/history - не через addItem", async () => {
    // Настоящий VaultStore (не мок) - это тот самый метод, который вызывает
    // ImportExportPanel.tsx после второго подтверждения (см. `confirmImport`
    // в компоненте). Итерации PBKDF2 занижены до 1000 ради скорости теста -
    // тот же приём, что и в vaultStore.test.ts, безопасность деривации не
    // относится к этому шву.
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    store.addItem({ type: "note", title: "Старая запись, которую должен вытеснить импорт" });
    expect(store.search("").length).toBe(1);

    const secondId = "22222222-2222-2222-2222-222222222222";
    const importedFromFile: Item[] = [
      VALID_ITEM,
      {
        ...VALID_ITEM,
        id: secondId,
        title: "Вторая запись файла",
        history: [{ fields: [{ name: "пароль", value: "old-secret" }], changedAt: "2026-01-01T12:00:00.000Z" }],
      },
    ];

    const parsed = parseImportFile(JSON.stringify(importedFromFile));
    store.replaceAllItems(parsed);

    const result = store.search("");
    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id).sort()).toEqual([VALID_ITEM.id, secondId].sort());

    // id/createdAt/history сохранены как есть из файла, не перегенерированы -
    // ровно то, что отличает `replaceAllItems` от цикла `addItem` (который
    // дал бы новый id/createdAt и молча потерял бы history).
    const second = result.find((item) => item.id === secondId);
    expect(second?.createdAt).toBe(VALID_ITEM.createdAt);
    expect(second?.history).toEqual([
      { fields: [{ name: "пароль", value: "old-secret" }], changedAt: "2026-01-01T12:00:00.000Z" },
    ]);
    expect(store.isDirty()).toBe(true);
  });
});
