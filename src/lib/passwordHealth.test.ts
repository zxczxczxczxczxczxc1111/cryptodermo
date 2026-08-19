import { describe, expect, it } from "vitest";
import { analyzePasswordHealth } from "./passwordHealth";
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
