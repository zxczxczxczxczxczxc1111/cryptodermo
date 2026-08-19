import { describe, expect, it } from "vitest";
import * as kdbxweb from "kdbxweb";
import type { Item, ItemField } from "./vaultStore";
import { splitItemIntoKdbxEntries, classifyKdbxFields, buildKdbxFile, buildKdbxExportFilename } from "./kdbxExport";

const f = (name: string, value: string, secret = false, group?: string): ItemField =>
  group !== undefined ? { name, value, secret, group } : { name, value, secret };

const BASE_ITEM: Item = {
  id: "1",
  type: "login",
  title: "Example",
  tags: ["work"],
  fields: [],
  note: "заметка",
  attachments: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

describe("splitItemIntoKdbxEntries", () => {
  it("возвращает одну запись без изменений, если аккаунтов нет", () => {
    const item: Item = { ...BASE_ITEM, fields: [f("Логин", "u"), f("Пароль", "p", true)] };
    const result = splitItemIntoKdbxEntries(item);
    expect(result).toEqual([{ title: "Example", fields: item.fields, note: "заметка", tags: ["work"] }]);
  });

  it("разбивает запись с аккаунтами на несколько, называя каждую «название · аккаунт»", () => {
    const item: Item = {
      ...BASE_ITEM,
      fields: [
        f("Сайт", "https://gmail.com"),
        f("Логин", "a@gmail.com", false, "Личная"),
        f("Пароль", "pa", true, "Личная"),
        f("Логин", "b@gmail.com", false, "Рабочая"),
        f("Пароль", "pb", true, "Рабочая"),
      ],
    };
    const result = splitItemIntoKdbxEntries(item);
    expect(result.map((r) => r.title)).toEqual(["Example · Личная", "Example · Рабочая"]);
    // Поле вне аккаунтов (Сайт) должно попасть в обе производные записи.
    expect(result[0].fields.map((f) => f.name)).toEqual(["Логин", "Пароль", "Сайт"]);
    expect(result[1].fields.map((f) => f.name)).toEqual(["Логин", "Пароль", "Сайт"]);
  });
});

describe("classifyKdbxFields", () => {
  it("первое секретное не-TOTP поле - пароль, первое несекретное - логин", () => {
    const result = classifyKdbxFields([f("Логин", "user"), f("Пароль", "pass", true)]);
    expect(result.password).toBe("pass");
    expect(result.username).toBe("user");
    expect(result.url).toBeNull();
    expect(result.otp).toBeNull();
    expect(result.custom).toEqual([]);
  });

  it("поле, похожее на адрес сайта, идёт в URL, а не в custom или username", () => {
    const result = classifyKdbxFields([f("Сайт", "https://example.com"), f("Логин", "user")]);
    expect(result.url).toBe("https://example.com");
    expect(result.username).toBe("user");
  });

  it("поле с otpauth:// идёт в otp, а не путается с паролем", () => {
    const result = classifyKdbxFields([
      f("Пароль", "pass", true),
      f("Двухфакторка", "otpauth://totp/x?secret=ABC", true),
    ]);
    expect(result.password).toBe("pass");
    expect(result.otp).toBe("otpauth://totp/x?secret=ABC");
  });

  it("второе секретное поле и второе несекретное несекретное поле не теряются - уходят в custom", () => {
    const result = classifyKdbxFields([
      f("Пароль", "pass1", true),
      f("PIN карты", "9999", true),
      f("Логин", "user"),
      f("Комментарий", "просто текст"),
    ]);
    expect(result.custom).toEqual([
      { name: "PIN карты", value: "9999", secret: true },
      { name: "Комментарий", value: "просто текст", secret: false },
    ]);
  });

  it("каждое поле попадает ровно в одно место - ничего не дублируется", () => {
    const fields = [f("Сайт", "https://a.example"), f("Логин", "u"), f("Пароль", "p", true)];
    const result = classifyKdbxFields(fields);
    const totalClassified =
      (result.password !== null ? 1 : 0) +
      (result.username !== null ? 1 : 0) +
      (result.url !== null ? 1 : 0) +
      (result.otp !== null ? 1 : 0) +
      result.custom.length;
    expect(totalClassified).toBe(fields.length);
  });
});

describe("buildKdbxFile: настоящая сборка через kdbxweb, а не мок", () => {
  it("создаёт файл KDBX3 (AES-KDF, без Argon2), который открывается тем же паролем", async () => {
    const item: Item = {
      ...BASE_ITEM,
      fields: [f("Сайт", "https://example.com"), f("Логин", "user@example.com"), f("Пароль", "s3cr3t", true)],
    };
    const data = await buildKdbxFile([item], "master-password", "cryptodermo export");

    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("master-password"));
    const loaded = await kdbxweb.Kdbx.load(data, credentials);
    expect(loaded.versionMajor).toBe(3);

    const entry = loaded.getDefaultGroup().entries[0];
    expect(entry.fields.get("Title")).toBe("Example");
    expect(entry.fields.get("UserName")).toBe("user@example.com");
    expect((entry.fields.get("Password") as kdbxweb.ProtectedValue).getText()).toBe("s3cr3t");
    expect(entry.fields.get("URL")).toBe("https://example.com");
    expect(entry.fields.get("Notes")).toBe("заметка");
    expect(entry.tags).toEqual(["work"]);
  });

  it("не открывается неверным паролем - файл действительно зашифрован", async () => {
    const item: Item = { ...BASE_ITEM, fields: [f("Пароль", "s3cr3t", true)] };
    const data = await buildKdbxFile([item], "right-password", "db");

    const wrongCredentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("wrong-password"));
    await expect(kdbxweb.Kdbx.load(data, wrongCredentials)).rejects.toThrow();
  });

  it("переносит вложение как бинарник KeePass", async () => {
    const item: Item = {
      ...BASE_ITEM,
      fields: [f("Пароль", "p", true)],
      attachments: [{ id: "a1", name: "note.txt", mimeType: "text/plain", size: 5, data: btoa("hello") }],
    };
    const data = await buildKdbxFile([item], "pw", "db");
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("pw"));
    const loaded = await kdbxweb.Kdbx.load(data, credentials);
    const entry = loaded.getDefaultGroup().entries[0];
    // После загрузки `binaries.get` отдаёт `{ hash, value }`, а не сам
    // `ProtectedValue` напрямую (в отличие от момента до сохранения) -
    // проверено смоук-скриптом, не угадано по типам.
    const binary = entry.binaries.get("note.txt") as { value: kdbxweb.ProtectedValue };
    expect(new TextDecoder().decode(binary.value.getBinary())).toBe("hello");
  });

  it("многоаккаунтная запись даёт несколько записей KeePass, каждая со своим паролем", async () => {
    const item: Item = {
      ...BASE_ITEM,
      fields: [
        f("Логин", "a@gmail.com", false, "Личная"),
        f("Пароль", "pa", true, "Личная"),
        f("Логин", "b@gmail.com", false, "Рабочая"),
        f("Пароль", "pb", true, "Рабочая"),
      ],
    };
    const data = await buildKdbxFile([item], "pw", "db");
    const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString("pw"));
    const loaded = await kdbxweb.Kdbx.load(data, credentials);
    const entries = loaded.getDefaultGroup().entries;
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.fields.get("Title")).sort()).toEqual(["Example · Личная", "Example · Рабочая"]);
  });
});

describe("buildKdbxExportFilename: дата в имени файла", () => {
  it("включает дату и время, отдельным префиксом от остальных экспортов", () => {
    const date = new Date(2026, 7, 19, 14, 5, 9); // 19 августа 2026, 14:05:09
    expect(buildKdbxExportFilename(date)).toBe("cryptodermo-export-2026-08-19-140509.kdbx");
  });
});
