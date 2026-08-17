import { describe, it, expect } from "vitest";
import {
  previewSupportHint,
  previewUnavailableReason,
  previewKindFor,
  imageDataUrl,
  decodeTextPreview,
  truncateForPreview,
  PREVIEW_MAX_BYTES,
} from "./attachmentPreview";

describe("previewKindFor", () => {
  it("разрешает растровые картинки", () => {
    expect(previewKindFor("image/png", 1000)).toBe("image");
    expect(previewKindFor("image/jpeg", 1000)).toBe("image");
    expect(previewKindFor("image/webp", 1000)).toBe("image");
  });

  it("ЗАПРЕЩАЕТ svg, даже если браузер его нарисовал бы", () => {
    // Осознанное решение, а не недосмотр: гарантия безопасности касается
    // только тега <img>, и первая же замена его на <object> открыла бы
    // исполнение чужого кода внутри приложения с паролями в памяти.
    expect(previewKindFor("image/svg+xml", 1000)).toBe("none");
  });

  it("разрешает простой текст и запрещает размеченный", () => {
    expect(previewKindFor("text/plain", 1000)).toBe("text");
    expect(previewKindFor("application/json", 1000)).toBe("text");
    expect(previewKindFor("text/html", 1000)).toBe("none");
    expect(previewKindFor("application/xml", 1000)).toBe("none");
  });

  it("запрещает pdf и неизвестные типы", () => {
    expect(previewKindFor("application/pdf", 1000)).toBe("none");
    expect(previewKindFor("application/octet-stream", 1000)).toBe("none");
    expect(previewKindFor("", 1000)).toBe("none");
  });

  it("не разбирает параметры типа как часть имени", () => {
    // Без очистки "text/plain; charset=utf-8" не совпал бы со списком, и
    // предпросмотр молча не работал бы для половины текстовых файлов.
    expect(previewKindFor("text/plain; charset=utf-8", 1000)).toBe("text");
    expect(previewKindFor("IMAGE/PNG", 1000)).toBe("image");
  });

  it("отказывает слишком большим файлам независимо от типа", () => {
    expect(previewKindFor("image/png", PREVIEW_MAX_BYTES + 1)).toBe("none");
    expect(previewKindFor("text/plain", PREVIEW_MAX_BYTES + 1)).toBe("none");
    expect(previewKindFor("image/png", PREVIEW_MAX_BYTES)).toBe("image");
  });
});

describe("imageDataUrl", () => {
  it("собирает data-URL и отбрасывает параметры типа", () => {
    expect(imageDataUrl("image/png", "QUJD")).toBe("data:image/png;base64,QUJD");
    expect(imageDataUrl("image/png; charset=binary", "QUJD")).toBe("data:image/png;base64,QUJD");
  });
});

describe("decodeTextPreview", () => {
  it("раскодирует корректный utf-8, включая кириллицу", () => {
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode("Привет, мир")));
    expect(decodeTextPreview(base64)).toBe("Привет, мир");
  });

  it("возвращает null на двоичных данных вместо мусора", () => {
    // Файл с расширением .txt вполне может оказаться двоичным. Показать
    // гирлянду символов подстановки хуже, чем не показать ничего.
    const binary = btoa(String.fromCharCode(0xff, 0xfe, 0xfd, 0x00));
    expect(decodeTextPreview(binary)).toBeNull();
  });

  it("возвращает null на битом base64", () => {
    expect(decodeTextPreview("не base64 вовсе!!!")).toBeNull();
  });
});

describe("truncateForPreview", () => {
  it("не трогает короткий текст", () => {
    expect(truncateForPreview("коротко", 100)).toBe("коротко");
  });

  it("обрезает по границе слова, а не посередине", () => {
    const result = truncateForPreview("один два три четыре пять", 12);
    expect(result.endsWith("…")).toBe(true);
    expect(result).not.toContain("чет…");
  });

  it("режет жёстко, если слово одно и длинное", () => {
    // Иначе от строки без пробелов не осталось бы ничего.
    const result = truncateForPreview("а".repeat(50), 10);
    expect(result).toBe("а".repeat(10) + "…");
  });
});

describe("previewSupportHint", () => {
  it("подставляет реальный предел размера и не разрастается в перечень", () => {
    const hint = previewSupportHint(25 * 1024 * 1024);
    expect(hint).toContain("25 МБ");
    // Длинный список форматов у кнопки не читают, а место занимает.
    expect(hint.length).toBeLessThan(140);
  });
});

describe("previewUnavailableReason", () => {
  it("молчит там, где предпросмотр есть", () => {
    expect(previewUnavailableReason("image/png", 1000)).toBeNull();
    expect(previewUnavailableReason("text/plain", 1000)).toBeNull();
  });

  it("называет причиной размер, если формат подходящий", () => {
    const reason = previewUnavailableReason("image/png", PREVIEW_MAX_BYTES + 1);
    expect(reason).toContain("Слишком большой");
  });

  it("называет причиной формат, если он не подошёл бы и маленьким", () => {
    // Если файл и большой, и неподходящего формата - честнее назвать формат:
    // размер уменьшить можно, формат нет.
    const reason = previewUnavailableReason("application/zip", PREVIEW_MAX_BYTES + 1);
    expect(reason).not.toContain("Слишком большой");
  });

  it("отличает запрещённое от неподдерживаемого", () => {
    // Иначе осознанный запрет выглядит как недоделка.
    expect(previewUnavailableReason("image/svg+xml", 1000)).toContain("безопасност");
    expect(previewUnavailableReason("application/pdf", 1000)).toContain("безопасност");
    expect(previewUnavailableReason("application/zip", 1000)).not.toContain("безопасност");
  });
});
