import { describe, expect, it } from "vitest";
import { importCancelTarget } from "./useImportRollback";
import type { Item } from "../lib/vaultStore";

function makeItem(overrides: Partial<Item> = {}): Item {
  return {
    id: "1",
    type: "login",
    title: "Test",
    tags: [],
    fields: [],
    note: "",
    attachments: [],
    createdAt: "2020-01-01T00:00:00.000Z",
    updatedAt: "2020-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// Шов, найденный ревью (перенесено из App.test.ts вместе с самой функцией,
// тикет 13): ImportExportPanel.confirmImport() вызывает
// store.replaceAllItems() СИНХРОННО, до того как R28 вообще становится
// известно persistAfterImport - "Отмена" на модалке R28-после-импорта
// обязана вернуть store к состоянию ДО импорта, не просто спрятать диалог
// (см. rollbackPendingImport в useImportRollback.ts).
describe("importCancelTarget (откат store при «Отмена» на R28-после-импорта)", () => {
  it("returns the captured pre-import snapshot when one was recorded", () => {
    const snapshot = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    expect(importCancelTarget(snapshot)).toBe(snapshot);
  });

  it("falls back to an empty collection in the defensive case where no snapshot was captured", () => {
    expect(importCancelTarget(null)).toEqual([]);
  });
});
