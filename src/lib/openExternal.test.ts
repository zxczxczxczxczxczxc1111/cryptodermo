import { describe, it, expect } from "vitest";
import { isOpenableUrl } from "./openExternal";

describe("isOpenableUrl", () => {
  it("принимает обычные веб-адреса", () => {
    expect(isOpenableUrl("https://github.com")).toBe(true);
    expect(isOpenableUrl("http://example.com/path?a=1")).toBe(true);
    expect(isOpenableUrl("  https://example.com  ")).toBe(true);
  });

  it("ОТКАЗЫВАЕТ всему, кроме http и https", () => {
    // Это не формальность: в поле записи лежит произвольная строка, а системный
    // обработчик умеет открывать file: и всё, что зарегистрировано в Windows
    // под свою схему. Отдать её системе значит позволить содержимому базы
    // запускать посторонние программы.
    expect(isOpenableUrl("file:///C:/Windows/System32/cmd.exe")).toBe(false);
    expect(isOpenableUrl("javascript:alert(1)")).toBe(false);
    expect(isOpenableUrl("ms-settings:")).toBe(false);
    expect(isOpenableUrl("steam://run/730")).toBe(false);
  });

  it("не принимает за адрес обычный текст поля", () => {
    expect(isOpenableUrl("Xk9#mQ2$vL8pR4wZ")).toBe(false);
    expect(isOpenableUrl("github.com")).toBe(false);
    expect(isOpenableUrl("")).toBe(false);
  });
});
