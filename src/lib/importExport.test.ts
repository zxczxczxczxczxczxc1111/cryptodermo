import { describe, expect, it } from "vitest";
import { VaultStore, type Item, type NewItemInput } from "./vaultStore";
import {
  CsvImportError,
  ImportValidationError,
  buildCsvImportConfirmationMessage,
  buildExportFilename,
  buildManualCopyFilename,
  buildReplaceConfirmationMessage,
  parseCsvPasswordImport,
  parseImportFile,
  serializeExport,
  splitCsvImportDuplicates,
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

describe("parseCsvPasswordImport: экспорт паролей Chrome/Google (19.08.2026)", () => {
  it("разбирает обычный файл в записи с полями Сайт/Логин/Пароль", () => {
    const csv =
      "name,url,username,password,note\n" +
      "gmail,https://mail.google.com/,me@gmail.com,s3cr3t,рабочая почта\n";
    const items = parseCsvPasswordImport(csv);
    expect(items).toHaveLength(1);
    expect(items[0]).toEqual({
      type: "login",
      title: "gmail",
      fields: [
        { name: "Сайт", value: "https://mail.google.com/", secret: false },
        { name: "Логин", value: "me@gmail.com", secret: false },
        { name: "Пароль", value: "s3cr3t", secret: true },
      ],
      note: "рабочая почта",
    } satisfies NewItemInput);
  });

  it("снимает ведущий BOM, который Chrome кладёт в свой экспорт", () => {
    const csv = "﻿name,url,username,password,note\nsite,https://a.example/,u,p,\n";
    expect(() => parseCsvPasswordImport(csv)).not.toThrow();
    expect(parseCsvPasswordImport(csv)[0].title).toBe("site");
  });

  it("понимает кавычки CSV: запятая и перевод строки внутри поля note", () => {
    const csv =
      'name,url,username,password,note\n' +
      'shop,https://shop.example/,u,p,"заметка, с запятой\nи второй строкой"\n';
    const items = parseCsvPasswordImport(csv);
    expect(items[0].note).toBe("заметка, с запятой\nи второй строкой");
  });

  it("пропускает колонку url, если она пустая - без пустого поля Сайт", () => {
    const csv = "name,url,username,password,note\nnote-only,,,p,\n";
    const items = parseCsvPasswordImport(csv);
    expect(items[0].fields?.map((f) => f.name)).toEqual(["Логин", "Пароль"]);
  });

  it("работает без колонки note - она необязательна", () => {
    const csv = "name,url,username,password\nsite,https://a.example/,u,p\n";
    expect(() => parseCsvPasswordImport(csv)).not.toThrow();
    expect(parseCsvPasswordImport(csv)[0].note).toBe("");
  });

  it("порядок колонок берётся из заголовка, а не жёстко зашит", () => {
    const csv = "password,name,username,url\np,site,u,https://a.example/\n";
    const items = parseCsvPasswordImport(csv);
    expect(items[0].title).toBe("site");
    expect(items[0].fields?.find((f) => f.secret)?.value).toBe("p");
  });

  it("подставляет название по умолчанию, если name и url оба пустые", () => {
    const csv = "name,url,username,password\n,,u,p\n";
    expect(parseCsvPasswordImport(csv)[0].title).toBe("Импортированная запись 1");
  });

  it("бросает CsvImportError на пустом файле", () => {
    expect(() => parseCsvPasswordImport("")).toThrow(CsvImportError);
  });

  it("бросает CsvImportError, если в заголовке нет обязательных колонок", () => {
    expect(() => parseCsvPasswordImport("foo,bar\n1,2\n")).toThrow(CsvImportError);
  });
});

describe("splitCsvImportDuplicates: сверка с уже существующими записями (19.08.2026)", () => {
  const existing: Item[] = [
    {
      ...VALID_ITEM,
      id: "existing-1",
      title: "GitHub",
      fields: [
        { name: "Сайт", value: "https://github.com/", secret: false },
        { name: "Логин", value: "octocat", secret: false },
        { name: "Пароль", value: "old", secret: true },
      ],
    },
  ];

  it("считает дубликатом совпадение по названию без учёта регистра", () => {
    const candidates: NewItemInput[] = [{ type: "login", title: "github", fields: [], note: "" }];
    const { toAdd, duplicateCount } = splitCsvImportDuplicates(candidates, existing);
    expect(toAdd).toHaveLength(0);
    expect(duplicateCount).toBe(1);
  });

  it("считает дубликатом совпадение по адресу сайта даже при другом названии", () => {
    const candidates: NewItemInput[] = [
      {
        type: "login",
        title: "Совсем другое название",
        fields: [{ name: "Сайт", value: "https://github.com/", secret: false }],
        note: "",
      },
    ];
    const { toAdd, duplicateCount } = splitCsvImportDuplicates(candidates, existing);
    expect(toAdd).toHaveLength(0);
    expect(duplicateCount).toBe(1);
  });

  it("не считает дубликатом действительно новую запись", () => {
    const candidates: NewItemInput[] = [
      { type: "login", title: "Совсем новый сервис", fields: [], note: "" },
    ];
    const { toAdd, duplicateCount } = splitCsvImportDuplicates(candidates, existing);
    expect(toAdd).toEqual(candidates);
    expect(duplicateCount).toBe(0);
  });
});

describe("buildCsvImportConfirmationMessage: текст подтверждения CSV-импорта (19.08.2026)", () => {
  it("без дубликатов - только число добавляемых", () => {
    expect(buildCsvImportConfirmationMessage(5, 0)).toBe("Добавить 5 записей из файла?");
  });

  it("с дубликатами - вторая фраза про пропуск", () => {
    expect(buildCsvImportConfirmationMessage(5, 2)).toBe(
      "Добавить 5 записей из файла? Ещё 2 похожи на уже существующие записи и будут пропущены.",
    );
  });
});
