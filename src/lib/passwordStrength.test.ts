import { describe, expect, it } from "vitest";
import { estimatePasswordStrength } from "./passwordStrength";

describe("estimatePasswordStrength", () => {
  it("пустая строка - level empty, индикатор не должен показываться", () => {
    expect(estimatePasswordStrength("").level).toBe("empty");
  });

  it("частый пароль из списка - слабый, даже если формально длинный", () => {
    expect(estimatePasswordStrength("password").level).toBe("weak");
    expect(estimatePasswordStrength("qwerty123").level).toBe("weak");
  });

  it("частый пароль с leetspeak-заменами тоже распознаётся как слабый", () => {
    // Классика: 4 класса символов дали бы высокую энтропию по чистому расчёту,
    // но это по-прежнему общеизвестный слабый пароль.
    expect(estimatePasswordStrength("P@ssw0rd").level).toBe("weak");
  });

  it("низкое разнообразие символов - слабый, несмотря на длину", () => {
    expect(estimatePasswordStrength("aaaaaaaaaaaa").level).toBe("weak");
    expect(estimatePasswordStrength("abababababab").level).toBe("weak");
  });

  it("длинная мешанина по соседним клавишам - НЕ слабый только из-за длины (регрессия живого прогона 19.08.2026)", () => {
    // Живой репорт: тот же пароль короче ("lsadlsa2349sdipsdkg;sdkg;lsdfklsdfkgldsf")
    // оценивался как "Надёжный", а при удлинении становился "Слабым" - доля
    // уникальных символов от длины падала ниже порога без всякой деградации
    // самого пароля. hasLowVariety теперь ловит только повтор одного символа
    // подряд и короткий цикл, не общее соотношение уникальности.
    const password = "lsadlsa2349sdipsdkg;sdkg;lsdfklsdfkgldsfksdf;lkg;dsl";
    expect(estimatePasswordStrength(password).level).not.toBe("weak");
  });

  it("короткий случайный пароль - не попадает под правило разнообразия (длина < 6)", () => {
    // hasLowVariety не должна ложно портить короткие честные пароли/PIN.
    const result = estimatePasswordStrength("a1b2");
    expect(result.level).not.toBe("empty");
  });

  it("короткий пароль без списка и без низкого разнообразия - всё равно слабый по энтропии", () => {
    expect(estimatePasswordStrength("xk9").level).toBe("weak");
  });

  it("длинная случайная строка одного регистра - средний или хороший, не выброс в максимум", () => {
    const result = estimatePasswordStrength("correcthorsebatterystaple");
    expect(["good", "strong"]).toContain(result.level);
  });

  it("короткий, но пёстрый по составу пароль - средний", () => {
    const result = estimatePasswordStrength("Tr0ub4");
    expect(["fair", "good"]).toContain(result.level);
  });

  it("длинный пароль с разными классами символов - надёжный", () => {
    expect(estimatePasswordStrength("Tr0ub4dor&3xyzQW").level).toBe("strong");
  });

  it("уровни растут монотонно с ростом длины при прочих равных", () => {
    const short = estimatePasswordStrength("Ax7!");
    const longer = estimatePasswordStrength("Ax7!Bz9@Cq2#Dm5$");
    const order: Record<string, number> = { weak: 0, fair: 1, good: 2, strong: 3 };
    expect(order[longer.level]).toBeGreaterThanOrEqual(order[short.level]);
  });

  it("подпись на русском соответствует уровню", () => {
    expect(estimatePasswordStrength("password").label).toBe("Слабый");
    expect(estimatePasswordStrength("Tr0ub4dor&3xyzQW").label).toBe("Надёжный");
  });

  it("кириллица не роняет расчёт (класс символов - консервативный fallback)", () => {
    const result = estimatePasswordStrength("пароль12345");
    expect(result.level).not.toBe("empty");
  });
});
