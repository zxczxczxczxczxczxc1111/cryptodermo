import { describe, expect, it, vi } from "vitest";
import { generatePassword, NoCharsetSelectedError } from "./PasswordGenerator";

// Швы из spec.md §10 / тикета 08 (R49): длина и состав генерируемого
// пароля, источник случайности. Сам компонент (панель с чекбоксами) не
// покрыт автотестами - в проекте нет jsdom/@testing-library (см.
// package.json), рендер и клики проверить юнит-тестом нечем; это
// сознательное ограничение среды, а не пропуск. Тестируется чистая функция
// генерации - публичный, специально вынесенный ради тестируемости швов.

describe("generatePassword: длина и состав (R49)", () => {
  it("возвращает пароль запрошенной длины из строчных букв, если выбран только этот набор", () => {
    const password = generatePassword({
      length: 20,
      lowercase: true,
      uppercase: false,
      digits: false,
      symbols: false,
    });

    expect(password).toHaveLength(20);
    expect(password).toMatch(/^[a-z]+$/);
  });

  it("при нескольких выбранных наборах использует только их символы, ни одного лишнего", () => {
    const password = generatePassword({
      length: 40,
      lowercase: true,
      uppercase: true,
      digits: true,
      symbols: false,
    });

    expect(password).toHaveLength(40);
    expect(password).toMatch(/^[a-zA-Z0-9]+$/);
    // "состав" - не более трёх допустимых классов символов, включая
    // спецсимволы (не выбраны) быть не должно ни у одного символа строки.
    expect(password).not.toMatch(/[^a-zA-Z0-9]/);
  });

  it("бросает NoCharsetSelectedError, если не выбран ни один набор символов", () => {
    expect(() =>
      generatePassword({ length: 10, lowercase: false, uppercase: false, digits: false, symbols: false }),
    ).toThrow(NoCharsetSelectedError);
  });

  it("бросает ошибку на нулевой/отрицательной/нецелой длине", () => {
    const validOptions = { lowercase: true, uppercase: false, digits: false, symbols: false };
    expect(() => generatePassword({ ...validOptions, length: 0 })).toThrow();
    expect(() => generatePassword({ ...validOptions, length: -5 })).toThrow();
    expect(() => generatePassword({ ...validOptions, length: 3.5 })).toThrow();
  });

  it("использует crypto.getRandomValues как источник случайности, не Math.random (пароли - чувствительные данные)", () => {
    const getRandomValuesSpy = vi.spyOn(crypto, "getRandomValues");
    const mathRandomSpy = vi.spyOn(Math, "random");

    generatePassword({ length: 16, lowercase: true, uppercase: true, digits: true, symbols: true });

    expect(getRandomValuesSpy).toHaveBeenCalled();
    expect(mathRandomSpy).not.toHaveBeenCalled();

    getRandomValuesSpy.mockRestore();
    mathRandomSpy.mockRestore();
  });
});
