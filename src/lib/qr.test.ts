import { describe, it, expect } from "vitest";
import {
  buildQrMatrix,
  qrSvgPath,
  qrByteLength,
  QrTooLongError,
  QR_MAX_INPUT_BYTES,
  QR_QUIET_ZONE,
} from "./qr";

describe("buildQrMatrix", () => {
  it("возвращает квадратную матрицу допустимого стандартом размера", () => {
    const matrix = buildQrMatrix("Xk9#mQ2$vL8pR4wZ");
    // Версии QR идут 21, 25, 29 ... - размер всегда 17 + 4 * версия.
    expect((matrix.size - 17) % 4).toBe(0);
    expect(matrix.size).toBeGreaterThanOrEqual(21);
    expect(matrix.modules.length).toBe(matrix.size);
    expect(matrix.modules.every((row) => row.length === matrix.size)).toBe(true);
  });

  it("рисует три поисковых узора по углам", () => {
    // Самая дешёвая проверка того, что перед нами именно QR, а не любая другая
    // матрица нулей и единиц: три угла из четырёх заняты квадратом 7x7,
    // отделённым светлой полосой.
    const { size, modules } = buildQrMatrix("test");
    const finderCorners: Array<[number, number]> = [
      [0, 0],
      [0, size - 7],
      [size - 7, 0],
    ];
    for (const [top, left] of finderCorners) {
      expect(modules[top][left]).toBe(true);
      expect(modules[top + 6][left + 6]).toBe(true);
      // Внутреннее кольцо светлое, сердцевина снова тёмная.
      expect(modules[top + 1][left + 1]).toBe(false);
      expect(modules[top + 3][left + 3]).toBe(true);
    }
    // Четвёртый угол поисковым узором быть не должен - иначе код нельзя было
    // бы сориентировать.
    expect(modules[size - 1][size - 1]).toBe(false);
  });

  it("даёт один и тот же код для одной и той же строки", () => {
    // Маска выбирается по данным, без случайности: код не должен «дрожать»
    // между открытиями окна.
    expect(buildQrMatrix("одно и то же")).toEqual(buildQrMatrix("одно и то же"));
  });

  it("кодирует кириллицу как UTF-8, а не обрезанием байтов", () => {
    // Без своей перекодировки библиотека взяла бы младший байт каждого
    // символа, и «Пароль» превратился бы в мусор. Проверяем через длину: две
    // строки одинаковой длины в символах, но разной в байтах, обязаны занять
    // разное место, а значит дать разные матрицы.
    expect(qrByteLength("Пароль")).toBe(12);
    expect(qrByteLength("Parol!")).toBe(6);
    const cyrillic = buildQrMatrix("Пароль");
    const latin = buildQrMatrix("Parol!");
    expect(cyrillic).not.toEqual(latin);
  });

  it("считает эмодзи и суррогатные пары целиком", () => {
    expect(qrByteLength("🔐")).toBe(4);
    expect(() => buildQrMatrix("🔐 пароль")).not.toThrow();
  });

  it("отказывается кодировать слишком длинное значение отдельной ошибкой", () => {
    // Без этой проверки наружу вылетала бы внутренняя ошибка библиотеки с
    // английским текстом - прямо в обработчик клика.
    const tooLong = "a".repeat(QR_MAX_INPUT_BYTES + 1);
    expect(() => buildQrMatrix(tooLong)).toThrow(QrTooLongError);
    expect(() => buildQrMatrix("a".repeat(QR_MAX_INPUT_BYTES))).not.toThrow();
  });
});

describe("qrSvgPath", () => {
  it("оставляет поля со всех сторон", () => {
    const matrix = buildQrMatrix("test");
    const svg = qrSvgPath(matrix);
    expect(svg.viewBox).toBe(`0 0 ${matrix.size + QR_QUIET_ZONE * 2} ${matrix.size + QR_QUIET_ZONE * 2}`);
    // Первый нарисованный модуль не может оказаться в самом углу поля -
    // иначе полей нет, и камера не найдёт границу кода.
    expect(svg.path.startsWith("M0 0")).toBe(false);
  });

  it("склеивает соседние тёмные модули строки в один отрезок", () => {
    // Ради этого путь и собирается вручную: 41x41 - это 1681 модуль, каждый
    // отдельным прямоугольником означал бы столько же узлов DOM.
    const solidRow: boolean[][] = [[true, true, true], [false, false, false], [false, false, false]];
    const svg = qrSvgPath({ size: 3, modules: solidRow }, 0);
    expect(svg.path).toBe("M0 0h3v1h-3z");
  });

  it("не рисует ничего для пустой матрицы", () => {
    const svg = qrSvgPath({ size: 2, modules: [[false, false], [false, false]] }, 1);
    expect(svg.path).toBe("");
    expect(svg.viewBox).toBe("0 0 4 4");
  });
});
