import { describe, expect, it } from "vitest";
import {
  resolveInitialVaultPath,
  screenForSidebarId,
  sidebarIdForScreen,
  formatRelativeTime,
  importCancelTarget,
} from "./App";
import type { Item } from "./lib/vaultStore";

// Швы, названные тикетом 12 явно ("определение vaultPath на первом
// запуске", "переключение активного раздела") - остальная сборка App.tsx
// (bootstrap-эффекты, useAutoLock-обвязка, реальный invoke() через Tauri)
// не рендерится в автотесте: в проекте нет jsdom/@testing-library/react
// (тот же прецедент, что и в LockScreen.test.ts/useAutoLock.test.ts) -
// проверено чтением кода, см. CONCERNS в отчёте по тикету.

describe("resolveInitialVaultPath (D03, interfaces.md)", () => {
  it("uses lastVaultPath from vault.settings.json when a returning user already has one", () => {
    expect(
      resolveInitialVaultPath("D:\\MyVault\\vault.dat", "C:\\Program Files\\Vault\\vault.dat"),
    ).toBe("D:\\MyVault\\vault.dat");
  });

  it("falls back to the exe-directory default on the very first launch ever (no lastVaultPath yet)", () => {
    expect(resolveInitialVaultPath(null, "C:\\Program Files\\Vault\\vault.dat")).toBe(
      "C:\\Program Files\\Vault\\vault.dat",
    );
  });

  it("treats a blank string the same as absent - falls back to the default rather than pointing at nothing", () => {
    expect(resolveInitialVaultPath("   ", "C:\\Program Files\\Vault\\vault.dat")).toBe(
      "C:\\Program Files\\Vault\\vault.dat",
    );
  });
});

describe("screenForSidebarId (переключение активного раздела через AppShell.onSidebarItemSelect)", () => {
  it("maps the settings sidebar item to the settings screen", () => {
    expect(screenForSidebarId("settings")).toEqual({ kind: "settings" });
  });

  it("maps the importExport sidebar item to the import/export screen", () => {
    expect(screenForSidebarId("importExport")).toEqual({ kind: "importExport" });
  });

  it("falls back to the list screen for the list id and for any unrecognized id", () => {
    expect(screenForSidebarId("list")).toEqual({ kind: "list" });
    expect(screenForSidebarId("something-unexpected")).toEqual({ kind: "list" });
  });
});

describe("sidebarIdForScreen (обратное направление - какой пункт сайдбара подсвечен)", () => {
  it("highlights the list item while the editor is open - it has no sidebar item of its own", () => {
    expect(sidebarIdForScreen({ kind: "editor", itemId: "existing-item-id" })).toBe("list");
    expect(sidebarIdForScreen({ kind: "editor", itemId: null })).toBe("list");
  });

  it("highlights the matching item for list/settings/importExport", () => {
    expect(sidebarIdForScreen({ kind: "list" })).toBe("list");
    expect(sidebarIdForScreen({ kind: "settings" })).toBe("settings");
    expect(sidebarIdForScreen({ kind: "importExport" })).toBe("importExport");
  });
});

// Ожидаемые строки ниже - разобраны вручную по веткам formatRelativeTime
// (< минуты / < часа / < суток / < месяца / < года / иначе), не получены
// вызовом самой функции - иначе тест был бы согласен с кодом под тестом по
// построению и не нашёл бы ошибку в собственных границах веток.
describe("formatRelativeTime (колонка «Недавние»)", () => {
  const NOW = new Date("2026-01-10T12:00:00.000Z").getTime();

  it("says 'только что' under a minute ago", () => {
    const iso = new Date(NOW - 30_000).toISOString(); // 30 секунд назад
    expect(formatRelativeTime(iso, NOW)).toBe("только что");
  });

  it("says '<N> мин назад' under an hour ago", () => {
    const iso = new Date(NOW - 5 * 60_000).toISOString(); // 5 минут назад
    expect(formatRelativeTime(iso, NOW)).toBe("5 мин назад");
  });

  it("says '<N> ч назад' under a day ago", () => {
    const iso = new Date(NOW - 3 * 60 * 60_000).toISOString(); // 3 часа назад
    expect(formatRelativeTime(iso, NOW)).toBe("3 ч назад");
  });

  it("says '<N> дн назад' under a month ago", () => {
    const iso = new Date(NOW - 5 * 24 * 60 * 60_000).toISOString(); // 5 дней назад
    expect(formatRelativeTime(iso, NOW)).toBe("5 дн назад");
  });

  it("says '<N> мес назад' under a year ago", () => {
    const iso = new Date(NOW - 60 * 24 * 60 * 60_000).toISOString(); // 60 дней назад = 2 месяца
    expect(formatRelativeTime(iso, NOW)).toBe("2 мес назад");
  });

  it("says '<N> г назад' a year or more ago", () => {
    const iso = new Date(NOW - 400 * 24 * 60 * 60_000).toISOString(); // 400 дней назад = 1 год
    expect(formatRelativeTime(iso, NOW)).toBe("1 г назад");
  });
});

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

// Шов, найденный ревью: ImportExportPanel.confirmImport() вызывает
// store.replaceAllItems() СИНХРОННО, до того как R28 вообще становится
// известно persistAfterImport - "Отмена" на модалке R28-после-импорта
// обязана вернуть store к состоянию ДО импорта, не просто спрятать диалог
// (см. rollbackPendingImport в App.tsx).
describe("importCancelTarget (откат store при «Отмена» на R28-после-импорта)", () => {
  it("returns the captured pre-import snapshot when one was recorded", () => {
    const snapshot = [makeItem({ id: "a" }), makeItem({ id: "b" })];
    expect(importCancelTarget(snapshot)).toBe(snapshot);
  });

  it("falls back to an empty collection in the defensive case where no snapshot was captured", () => {
    expect(importCancelTarget(null)).toEqual([]);
  });
});
