import { describe, it, expect } from "vitest";
import {
  compareVersions,
  isNewer,
  parseRelease,
  shouldCheckNow,
  UpdateCheckError,
  CHECK_INTERVAL_MS,
} from "./updateCheck";

describe("compareVersions", () => {
  it("сравнивает по частям, а не по строке", () => {
    // Строковое сравнение сказало бы, что 1.9.0 новее 1.10.0 - самая частая
    // ошибка в самодельных проверках версий.
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
    expect(compareVersions("1.9.0", "1.10.0")).toBe(-1);
  });

  it("считает недостающие части нулём", () => {
    expect(compareVersions("1.1", "1.1.0")).toBe(0);
    expect(compareVersions("2", "1.9.9")).toBe(1);
  });

  it("не падает на нечисловом хвосте", () => {
    expect(compareVersions("1.2.3-beta", "1.2.3")).toBe(0);
  });
});

describe("isNewer", () => {
  it("равные версии обновлением не считает", () => {
    expect(isNewer("1.0.0", "1.0.0")).toBe(false);
  });

  it("версия старше установленной обновлением не считается", () => {
    // Так бывает у собранного из исходников: локальная версия впереди
    // выложенной, и предлагать «обновиться» назад бессмысленно.
    expect(isNewer("1.0.0", "1.1.0")).toBe(false);
  });

  it("новее - значит есть что скачать", () => {
    expect(isNewer("1.1.0", "1.0.0")).toBe(true);
  });
});

describe("parseRelease", () => {
  it("снимает ведущую v с тега", () => {
    const r = parseRelease({ tag_name: "v1.2.0", html_url: "https://example.com/r" });
    expect(r.version).toBe("1.2.0");
    expect(r.url).toBe("https://example.com/r");
  });

  it("отказывается от ответа без версии или без ссылки", () => {
    // Молча вернуть пустую строку значит показать «доступна версия » и
    // отправить человека в никуда.
    expect(() => parseRelease({ html_url: "https://example.com" })).toThrow(UpdateCheckError);
    expect(() => parseRelease({ tag_name: "v1" })).toThrow(UpdateCheckError);
    expect(() => parseRelease(null)).toThrow(UpdateCheckError);
    expect(() => parseRelease("что-то не то")).toThrow(UpdateCheckError);
  });
});

describe("shouldCheckNow", () => {
  const now = new Date("2026-08-17T12:00:00.000Z");

  it("первый запуск - проверяем", () => {
    expect(shouldCheckNow(undefined, now)).toBe(true);
  });

  it("в пределах суток - не беспокоим", () => {
    const recent = new Date(now.getTime() - CHECK_INTERVAL_MS + 1000).toISOString();
    expect(shouldCheckNow(recent, now)).toBe(false);
  });

  it("через сутки - проверяем снова", () => {
    const old = new Date(now.getTime() - CHECK_INTERVAL_MS).toISOString();
    expect(shouldCheckNow(old, now)).toBe(true);
  });

  it("испорченная дата в настройках не блокирует проверку навсегда", () => {
    expect(shouldCheckNow("не дата", now)).toBe(true);
  });
});
