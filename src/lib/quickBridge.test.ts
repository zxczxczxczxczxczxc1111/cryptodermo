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

  it("уточняет строку ЗНАЧЕНИЕМ логина, а не именем поля", () => {
    // Имя поля бесполезно: две почты одного сервиса давали «maj · Пароль» и
    // «maj · Пароль», по которым выбрать невозможно.
    const rows = buildQuickRows([
      {
        id: "1",
        title: "gmail",
        fields: [
          f("Почта", "a@gmail.com"),
          f("Пароль", "aaa", true),
          f("Почта", "b@gmail.com"),
          f("Пароль", "bbb", true),
        ],
      },
    ]);
    expect(rows.map((r) => r.detail)).toEqual(["a@gmail.com", "b@gmail.com"]);
  });

  it("без логина не пишет бессмысленное «Пароль» у единственной пары", () => {
    const one = buildQuickRows([{ id: "1", title: "X", fields: [f("Пароль", "p", true)] }]);
    expect(one[0].detail).toBe("");
  });

  it("берёт логин ближайший СВЕРХУ, а не первый в записи", () => {
    const rows = buildQuickRows([
      {
        id: "1",
        title: "X",
        fields: [f("Логин A", "a"), f("Пароль A", "pa", true), f("Логин B", "b"), f("Пароль B", "pb", true)],
      },
    ]);
    expect(rows[1].loginField).toBe("Логин B");
  });

  it("показывает запись, только если в ней есть заполненный пароль", () => {
    // Признак - наличие пароля, а НЕ тип записи: человек волен хранить пароль
    // в записи любого типа, а запись без пароля в окне, которое умеет только
    // копировать, бесполезна независимо от типа.
    const rows = buildQuickRows([
      { id: "1", title: "Только логин", fields: [f("Логин", "u")] },
      { id: "2", title: "Пустой пароль", fields: [f("Пароль", "   ", true)] },
      { id: "3", title: "Без полей", fields: [] },
      { id: "4", title: "Заметка с паролем", fields: [f("Пароль от архива", "p", true)] },
    ]);
    expect(rows.map((r) => r.title)).toEqual(["Заметка с паролем"]);
  });

  it("не считает секрет двухфакторки паролем, но отмечает его наличие", () => {
    const rows = buildQuickRows([
      {
        id: "1",
        title: "X",
        fields: [f("Логин", "u"), f("Пароль", "p", true), f("2ФА", "otpauth://totp/X?secret=A", true)],
      },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].passwordField).toBe("Пароль");
    expect(rows[0].hasTotp).toBe(true);
  });
});
