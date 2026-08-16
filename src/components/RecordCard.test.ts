import { describe, expect, it } from "vitest";
import { isSecretFieldStale, hasStaleSecretField } from "./RecordCard";
import type { Item } from "../lib/vaultStore";

// Проверяет только чистую логику "возраст секретного поля" (spec.md §8,
// один из разделов спецификации, приложенных к тикету) - не рендер
// компонента (нет jsdom/@testing-library/react в проекте, добавлять ради
// одного тикета - новая зависимость без отдельного вопроса, R31). Это не
// весь компонент "на всякий случай" - конкретный именованный шов из
// спецификации: "у секретного поля записи (secret: true) пароль не
// менялся больше года... точка на самой записи в списке и на поле в
// карточке. Возраст считается по дате последнего изменения этого поля:
// если поле хотя бы раз попадало в history, берётся дата последней записи
// history, иначе - updatedAt".

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

describe("isSecretFieldStale", () => {
  it("is true when the field (via updatedAt fallback, no history) last changed about two years ago", () => {
    const item = makeItem({
      updatedAt: "2024-01-01T00:00:00.000Z",
      fields: [{ name: "password", value: "x", secret: true }],
    });
    expect(isSecretFieldStale(item, "password", new Date("2026-08-16T00:00:00.000Z"))).toBe(true);
  });

  it("is false when the field changed about a month ago", () => {
    const item = makeItem({
      updatedAt: "2026-07-16T00:00:00.000Z",
      fields: [{ name: "password", value: "x", secret: true }],
    });
    expect(isSecretFieldStale(item, "password", new Date("2026-08-16T00:00:00.000Z"))).toBe(false);
  });

  it("uses the latest history entry that touched this specific field, not the record's own updatedAt", () => {
    // item.updatedAt is recent (some OTHER field of the same record changed
    // later), but THIS field's own last change sits in `history`, about two
    // years back - spec.md §8 says the age is per-field, not per-record.
    const item = makeItem({
      updatedAt: "2026-08-01T00:00:00.000Z",
      fields: [{ name: "password", value: "current", secret: true }],
      history: [{ fields: [{ name: "password", value: "old" }], changedAt: "2024-01-01T00:00:00.000Z" }],
    });
    expect(isSecretFieldStale(item, "password", new Date("2026-08-16T00:00:00.000Z"))).toBe(true);
  });
});

describe("hasStaleSecretField", () => {
  const now = new Date("2026-08-16T00:00:00.000Z");

  it("is true when at least one secret field is stale, even if another secret field is fresh", () => {
    const item = makeItem({
      fields: [
        { name: "old-password", value: "x", secret: true },
        { name: "new-password", value: "y", secret: true },
      ],
      history: [{ fields: [{ name: "new-password", value: "z" }], changedAt: "2026-08-01T00:00:00.000Z" }],
      updatedAt: "2024-01-01T00:00:00.000Z", // фолбэк для old-password, у которого нет своей истории
    });
    expect(hasStaleSecretField(item, now)).toBe(true);
  });

  it("is false when every secret field is fresh", () => {
    const item = makeItem({
      updatedAt: "2026-08-01T00:00:00.000Z",
      fields: [{ name: "password", value: "x", secret: true }],
    });
    expect(hasStaleSecretField(item, now)).toBe(false);
  });

  it("ignores non-secret fields even if they are very old - the status is defined only for secret:true", () => {
    const item = makeItem({
      updatedAt: "2020-01-01T00:00:00.000Z",
      fields: [{ name: "username", value: "old-but-not-secret", secret: false }],
    });
    expect(hasStaleSecretField(item, now)).toBe(false);
  });
});
