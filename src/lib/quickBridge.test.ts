import { describe, it, expect } from "vitest";
import { buildQuickRows } from "./quickBridge";

const f = (name: string, value: string, secret = false) => ({ name, value, secret });

describe("buildQuickRows", () => {
  it("делает по строке на каждый пароль записи", () => {
    // Две почты одного сервиса - обычное дело, и до этой правки копировалась
    // всегда первая пара без способа добраться до второй.
    const rows = buildQuickRows([
      {
        id: "1",
        type: "login",
        title: "protonmail",
        fields: [
          f("Почта 1", "a@proton.me"),
          f("Пароль 1", "aaa", true),
          f("Почта 2", "b@proton.me"),
          f("Пароль 2", "bbb", true),
        ],
      },
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.passwordField)).toEqual(["Пароль 1", "Пароль 2"]);
    expect(rows.map((r) => r.loginField)).toEqual(["Почта 1", "Почта 2"]);
  });

  it("уточняет имя поля только когда паролей несколько", () => {
    const one = buildQuickRows([
      { id: "1", type: "login", title: "X", fields: [f("Логин", "u"), f("Пароль", "p", true)] },
    ]);
    expect(one[0].detail).toBe("");
  });

  it("берёт логин ближайший СВЕРХУ, а не первый в записи", () => {
    const rows = buildQuickRows([
      {
        id: "1",
        type: "login",
        title: "X",
        fields: [f("Логин A", "a"), f("Пароль A", "pa", true), f("Логин B", "b"), f("Пароль B", "pb", true)],
      },
    ]);
    expect(rows[1].loginField).toBe("Логин B");
  });

  it("прячет заметки и ключи", () => {
    // Копировать одним нажатием у них нечего, а показать содержимое окно не
    // может: это строка поиска, а не просмотрщик.
    const rows = buildQuickRows([
      { id: "1", type: "note", title: "Заметка", fields: [f("Текст", "секрет", true)] },
      { id: "2", type: "key", title: "Ключ", fields: [f("Ключ", "-----BEGIN", true)] },
      { id: "3", type: "login", title: "Сайт", fields: [f("Пароль", "p", true)] },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Сайт"]);
  });

  it("пропускает записи без единого пароля", () => {
    const rows = buildQuickRows([
      { id: "1", type: "login", title: "Только логин", fields: [f("Логин", "u")] },
    ]);
    expect(rows).toEqual([]);
  });

  it("не считает секрет двухфакторки паролем, но отмечает его наличие", () => {
    const rows = buildQuickRows([
      {
        id: "1",
        type: "login",
        title: "X",
        fields: [f("Логин", "u"), f("Пароль", "p", true), f("2ФА", "otpauth://totp/X?secret=A", true)],
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].passwordField).toBe("Пароль");
    expect(rows[0].hasTotp).toBe(true);
  });
});
