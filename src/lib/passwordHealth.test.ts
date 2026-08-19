import { describe, expect, it } from "vitest";
import {
  analyzePasswordHealth,
  itemPasswordIssues,
  itemsWithPasswordIssue,
  NO_PASSWORD_ISSUES,
} from "./passwordHealth";
import type { Item } from "./vaultStore";

function makeItem(id: string, fields: { name: string; value: string; secret: boolean }[]): Item {
  return {
    id,
    type: "login",
    title: id,
    tags: [],
    fields,
    note: "",
    attachments: [],
    createdAt: "2026-08-19T00:00:00.000Z",
    updatedAt: "2026-08-19T00:00:00.000Z",
  };
}

describe("analyzePasswordHealth", () => {
  it("пустая база - оба счётчика нулевые", () => {
    expect(analyzePasswordHealth([])).toEqual({ weakCount: 0, reusedCount: 0 });
  });

  it("считает только секретные поля с именем «Пароль», без учёта регистра", () => {
    const items = [
      makeItem("1", [
        { name: "Пароль", value: "123456", secret: true }, // слабый
        { name: "CVC", value: "123", secret: true }, // не пароль - не считается
        { name: "пароль", value: "correcthorsebatterystaple123!", secret: true }, // регистр не важен
        { name: "Пароль", value: "site.com", secret: false }, // не secret - не считается
      ]),
    ];
    const result = analyzePasswordHealth(items);
    expect(result.weakCount).toBe(1);
  });

  it("повторяющийся пароль между двумя записями - считает обе, не одну", () => {
    const items = [
      makeItem("1", [{ name: "Пароль", value: "Tr0ub4dor&3xyzQW", secret: true }]),
      makeItem("2", [{ name: "Пароль", value: "Tr0ub4dor&3xyzQW", secret: true }]),
      makeItem("3", [{ name: "Пароль", value: "Ax7!Bz9@Cq2#Dm5$", secret: true }]),
    ];
    const result = analyzePasswordHealth(items);
    expect(result.reusedCount).toBe(2);
  });

  it("три записи с одним и тем же паролем - все три считаются повторяющимися", () => {
    const items = [
      makeItem("1", [{ name: "Пароль", value: "Tr0ub4dor&3xyzQW", secret: true }]),
      makeItem("2", [{ name: "Пароль", value: "Tr0ub4dor&3xyzQW", secret: true }]),
      makeItem("3", [{ name: "Пароль", value: "Tr0ub4dor&3xyzQW", secret: true }]),
    ];
    expect(analyzePasswordHealth(items).reusedCount).toBe(3);
  });

  it("без повторов - reusedCount нулевой", () => {
    const items = [
      makeItem("1", [{ name: "Пароль", value: "Tr0ub4dor&3xyzQW", secret: true }]),
      makeItem("2", [{ name: "Пароль", value: "Ax7!Bz9@Cq2#Dm5$", secret: true }]),
    ];
    expect(analyzePasswordHealth(items).reusedCount).toBe(0);
  });

  it("аккаунты внутри одной записи (group) считаются наравне с отдельными записями", () => {
    const items = [
      makeItem("1", [
        { name: "Пароль", value: "one-and-only-Value9!", secret: true },
        { name: "Пароль", value: "one-and-only-Value9!", secret: true },
      ]),
    ];
    expect(analyzePasswordHealth(items).reusedCount).toBe(2);
  });

  it("пустое значение поля «Пароль» не считается ни слабым, ни повторяющимся", () => {
    const items = [
      makeItem("1", [{ name: "Пароль", value: "", secret: true }]),
      makeItem("2", [{ name: "Пароль", value: "", secret: true }]),
    ];
    expect(analyzePasswordHealth(items)).toEqual({ weakCount: 0, reusedCount: 0 });
  });
});

// Уровень записи (19.08.2026). Числа выше считают ПОЛЯ и остаются как были -
// эти функции отвечают на другой вопрос: в каких записях проблема, чтобы
// поставить значок и открыть список именно этих записей.
describe("itemPasswordIssues", () => {
  const pass = (value: string) => ({ name: "Пароль", value, secret: true });

  it("слабый пароль помечает запись, надёжный - нет", () => {
    const weak = makeItem("a", [pass("password")]);
    const strong = makeItem("b", [pass("Tr0ub4dor&3xyzQW")]);
    const all = [weak, strong];
    expect(itemPasswordIssues(weak, all).weak).toBe(true);
    expect(itemPasswordIssues(strong, all).weak).toBe(false);
  });

  it("запись с тремя слабыми паролями помечается ОДИН раз", () => {
    // Ровно то, чем уровень записи отличается от чисел: weakCount тут даст 3.
    const many = makeItem("a", [pass("password"), pass("qwerty"), pass("123456")]);
    const all = [many];
    expect(itemPasswordIssues(many, all).weak).toBe(true);
    expect(analyzePasswordHealth(all).weakCount).toBe(3);
  });

  it("повтор между разными записями помечает обе", () => {
    const a = makeItem("a", [pass("Tr0ub4dor&3xyzQW")]);
    const b = makeItem("b", [pass("Tr0ub4dor&3xyzQW")]);
    const all = [a, b];
    expect(itemPasswordIssues(a, all).reused).toBe(true);
    expect(itemPasswordIssues(b, all).reused).toBe(true);
  });

  it("повтор внутри одной записи (аккаунты) тоже считается повтором", () => {
    // Согласовано с уже принятым решением для чисел, см. тест выше про group.
    const one = makeItem("a", [pass("Tr0ub4dor&3xyzQW"), pass("Tr0ub4dor&3xyzQW")]);
    expect(itemPasswordIssues(one, [one]).reused).toBe(true);
  });

  it("уникальный пароль повтором не считается", () => {
    const a = makeItem("a", [pass("Tr0ub4dor&3xyzQW")]);
    const b = makeItem("b", [pass("Xk9-mQ2-vL8pR4wZ")]);
    expect(itemPasswordIssues(a, [a, b]).reused).toBe(false);
  });

  it("запись без полей «Пароль» не имеет проблем вовсе", () => {
    const note = makeItem("a", [{ name: "Текст", value: "password", secret: false }]);
    expect(itemPasswordIssues(note, [note])).toEqual(NO_PASSWORD_ISSUES);
  });

  it("пустое значение пароля не считается проблемой", () => {
    const empty = makeItem("a", [pass("")]);
    expect(itemPasswordIssues(empty, [empty])).toEqual(NO_PASSWORD_ISSUES);
  });

  it("утечка приходит снаружи набором значений, из базы не выводится", () => {
    const leaked = makeItem("a", [pass("Tr0ub4dor&3xyzQW")]);
    const clean = makeItem("b", [pass("Xk9-mQ2-vL8pR4wZ")]);
    const all = [leaked, clean];
    // Без набора - никаких утечек, даже у слабых.
    expect(itemPasswordIssues(leaked, all).breached).toBe(false);
    const breached = new Set(["Tr0ub4dor&3xyzQW"]);
    expect(itemPasswordIssues(leaked, all, breached).breached).toBe(true);
    expect(itemPasswordIssues(clean, all, breached).breached).toBe(false);
  });
});

describe("itemsWithPasswordIssue", () => {
  const pass = (value: string) => ({ name: "Пароль", value, secret: true });

  it("отдаёт записи с проблемой, каждую по одному разу", () => {
    const a = makeItem("a", [pass("password"), pass("qwerty")]);
    const b = makeItem("b", [pass("Tr0ub4dor&3xyzQW")]);
    const all = [a, b];
    const weak = itemsWithPasswordIssue(all, "weak");
    expect(weak.map((i) => i.id)).toEqual(["a"]);
  });

  it("пустой результат, когда проблем нет", () => {
    const a = makeItem("a", [pass("Tr0ub4dor&3xyzQW")]);
    expect(itemsWithPasswordIssue([a], "weak")).toEqual([]);
  });
});
