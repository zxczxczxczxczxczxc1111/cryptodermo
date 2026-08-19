import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import {
  ensureArgon2,
  kdbxEntryToItem,
  kdbxBinaryToBytes,
  attachmentFromKdbxBinary,
  parseKdbxFile,
  KdbxImportError,
} from "./kdbxImport";
import { buildKdbxFile } from "./kdbxExport";
import type { Item } from "./vaultStore";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "1",
    type: "login",
    title: "Test",
    tags: [],
    fields: [],
    note: "",
    attachments: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
    ...overrides,
  };
}

describe("kdbxEntryToItem", () => {
  it("раскладывает стандартные слоты KeePass по нашим полям", () => {
    const item = kdbxEntryToItem({
      fields: new Map<string, string>([
        ["Title", "GitHub"],
        ["UserName", "octocat"],
        ["Password", "s3cret"],
        ["URL", "https://github.com"],
        ["Notes", "рабочий аккаунт"],
      ]),
    });

    expect(item.title).toBe("GitHub");
    expect(item.note).toBe("рабочий аккаунт");
    expect(item.fields).toEqual([
      { name: "Логин", value: "octocat", secret: false },
      { name: "Пароль", value: "s3cret", secret: true },
      { name: "Сайт", value: "https://github.com", secret: false },
    ]);
  });

  it("поле otp приезжает полем двухфакторки и секретным", () => {
    const item = kdbxEntryToItem({
      fields: new Map<string, string>([
        ["Title", "X"],
        ["otp", "otpauth://totp/X?secret=GEZDGNBVGY3TQOJQ"],
      ]),
    });
    const totp = item.fields?.find((f) => f.name === "Двухфакторка");
    expect(totp?.secret).toBe(true);
    expect(totp?.value).toContain("otpauth://");
  });

  it("произвольные поля сохраняют своё имя, защищённые остаются секретными", () => {
    const item = kdbxEntryToItem({
      fields: new Map<string, kdbxweb.ProtectedValue | string>([
        ["Title", "Банк"],
        ["Кодовое слово", kdbxweb.ProtectedValue.fromString("ромашка")],
        ["Отделение", "12"],
      ]),
    });

    expect(item.fields).toContainEqual({ name: "Кодовое слово", value: "ромашка", secret: true });
    expect(item.fields).toContainEqual({ name: "Отделение", value: "12", secret: false });
  });

  it("пустые значения не превращаются в пустые поля", () => {
    const item = kdbxEntryToItem({
      fields: new Map<string, string>([
        ["Title", "X"],
        ["UserName", ""],
        ["Password", ""],
        ["Своё", ""],
      ]),
    });
    expect(item.fields).toEqual([]);
  });

  it("теги берутся из entry.tags, имя группы добавляется, дубль не задваивается", () => {
    const item = kdbxEntryToItem({
      fields: new Map<string, string>([["Title", "X"]]),
      tags: ["Работа", "Финансы"],
      groupName: "Личное",
    });
    expect(item.tags).toEqual(["Работа", "Финансы", "Личное"]);

    const noDupe = kdbxEntryToItem({
      fields: new Map<string, string>([["Title", "X"]]),
      tags: ["Работа"],
      groupName: "работа",
    });
    expect(noDupe.tags).toEqual(["Работа"]);
  });

  it("тип выводится по содержимому", () => {
    const withPassword = kdbxEntryToItem({
      fields: new Map([
        ["Title", "X"],
        ["Password", "p"],
      ]),
    });
    expect(withPassword.type).toBe("login");

    const emptyEntry = kdbxEntryToItem({ fields: new Map([["Title", "X"]]) });
    expect(emptyEntry.type).toBe("note");

    const otherEntry = kdbxEntryToItem({
      fields: new Map([
        ["Title", "X"],
        ["UserName", "u"],
      ]),
    });
    expect(otherEntry.type).toBe("other");
  });
});

describe("kdbxBinaryToBytes", () => {
  const bytes = new Uint8Array([1, 2, 3, 250]);

  // Три формы, потому что kdbxweb отдаёт разное в зависимости от того, чем
  // создан файл - разбираются все три, а не одна «правильная».
  it("понимает голый ArrayBuffer", () => {
    expect(kdbxBinaryToBytes(bytes.slice().buffer)).toEqual(bytes);
  });

  it("понимает ProtectedValue", () => {
    expect(kdbxBinaryToBytes(kdbxweb.ProtectedValue.fromBinary(bytes.slice()))).toEqual(bytes);
  });

  it("понимает обёртку { hash, value }", () => {
    const wrapped = { hash: "x", value: kdbxweb.ProtectedValue.fromBinary(bytes.slice()) };
    expect(kdbxBinaryToBytes(wrapped)).toEqual(bytes);
  });

  it("на неизвестной форме возвращает null, а не мусор", () => {
    expect(kdbxBinaryToBytes(42)).toBeNull();
  });
});

describe("attachmentFromKdbxBinary", () => {
  it("угадывает тип по расширению и считает размер", () => {
    const att = attachmentFromKdbxBinary("скан.pdf", new Uint8Array([1, 2, 3]));
    expect(att.mimeType).toBe("application/pdf");
    expect(att.size).toBe(3);
    expect(att.name).toBe("скан.pdf");
  });

  it("неизвестное расширение получает универсальный тип, а не пустой", () => {
    expect(attachmentFromKdbxBinary("файл.qqq", new Uint8Array()).mimeType).toBe(
      "application/octet-stream",
    );
  });
});

describe("parseKdbxFile (через настоящий kdbxweb)", () => {
  it("читает файл, собранный нашим же экспортом", async () => {
    const source = [
      makeItem({
        id: "a",
        title: "Binance",
        tags: ["Криптовалюта"],
        note: "заметка",
        fields: [
          { name: "Логин", value: "me@example.com", secret: false },
          { name: "Пароль", value: "Xk9#mQ2$vL8pR4wZ", secret: true },
          { name: "Сайт", value: "https://binance.com", secret: false },
        ],
      }),
    ];
    const file = await buildKdbxFile(source, "файловый-пароль", "cryptodermo");
    const items = await parseKdbxFile(new Uint8Array(file), "файловый-пароль");

    expect(items).toHaveLength(1);
    expect(items[0].title).toBe("Binance");
    expect(items[0].note).toBe("заметка");
    expect(items[0].tags).toEqual(["Криптовалюта"]);
    expect(items[0].fields).toContainEqual({
      name: "Пароль",
      value: "Xk9#mQ2$vL8pR4wZ",
      secret: true,
    });
    expect(items[0].fields).toContainEqual({
      name: "Сайт",
      value: "https://binance.com",
      secret: false,
    });
  });

  it("вложения переносятся побайтово", async () => {
    const payload = new Uint8Array([0, 1, 127, 128, 255]);
    const source = [
      makeItem({
        title: "С файлом",
        attachments: [
          {
            id: "att-1",
            name: "данные.bin",
            mimeType: "application/octet-stream",
            size: payload.length,
            data: btoa(String.fromCharCode(...payload)),
          },
        ],
      }),
    ];
    const file = await buildKdbxFile(source, "пароль", "cryptodermo");
    const items = await parseKdbxFile(new Uint8Array(file), "пароль");

    expect(items[0].attachments).toHaveLength(1);
    expect(items[0].attachments?.[0].name).toBe("данные.bin");
    expect(items[0].attachments?.[0].data).toBe(btoa(String.fromCharCode(...payload)));
  });

  it("неверный пароль даёт KdbxImportError, а не падение библиотеки наружу", async () => {
    const file = await buildKdbxFile([makeItem()], "правильный", "cryptodermo");
    await expect(parseKdbxFile(new Uint8Array(file), "неправильный")).rejects.toBeInstanceOf(
      KdbxImportError,
    );
  });

  it("мусор вместо файла тоже даёт KdbxImportError", async () => {
    await expect(
      parseKdbxFile(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), "пароль"),
    ).rejects.toBeInstanceOf(KdbxImportError);
  });
});

// Главная причина, по которой вообще добавлена зависимость hash-wasm:
// современные клиенты (KeePassXC, KeePassium) по умолчанию пишут KDBX4 с
// Argon2, и без реализации kdbxweb такой файл не откроет. Файл здесь
// собирается настоящим kdbxweb в KDBX4/Argon2d и читается обратно - то есть
// проверяется именно связка «наша реализация Argon2 + чужой формат».
describe("KDBX4 с Argon2", () => {
  it("файл в KDBX4 с Argon2d читается", async () => {
    ensureArgon2();
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("пароль4"));
    const db = kdbxweb.Kdbx.create(credentials, "argon2-база");
    db.setVersion(4);
    db.setKdf(kdbxweb.Consts.KdfId.Argon2d);
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", "Из KeePassXC");
    entry.fields.set("UserName", "user4");
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("пароль-в-argon2"));
    const file = await db.save();

    const items = await parseKdbxFile(new Uint8Array(file), "пароль4");
    const found = items.find((i) => i.title === "Из KeePassXC");
    expect(found).toBeDefined();
    expect(found?.fields).toContainEqual({ name: "Логин", value: "user4", secret: false });
    expect(found?.fields).toContainEqual({ name: "Пароль", value: "пароль-в-argon2", secret: true });
  }, 30_000);

  it("файл в KDBX4 с Argon2id тоже читается", async () => {
    ensureArgon2();
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("пароль4id"));
    const db = kdbxweb.Kdbx.create(credentials, "argon2id-база");
    db.setVersion(4);
    db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
    const entry = db.createEntry(db.getDefaultGroup());
    entry.fields.set("Title", "Argon2id");
    entry.fields.set("Password", kdbxweb.ProtectedValue.fromString("p"));
    const file = await db.save();

    const items = await parseKdbxFile(new Uint8Array(file), "пароль4id");
    expect(items.find((i) => i.title === "Argon2id")).toBeDefined();
  }, 30_000);
});
