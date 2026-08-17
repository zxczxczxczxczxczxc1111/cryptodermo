import { describe, it, expect } from "vitest";
import { accelFromEvent, formatAccel, isValidAccel, type HotkeyEventLike } from "./hotkey";

function ev(p: Partial<HotkeyEventLike>): HotkeyEventLike {
  return { key: "c", code: "KeyC", ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...p };
}

describe("accelFromEvent", () => {
  it("собирает сочетание в порядке модификаторов", () => {
    expect(accelFromEvent(ev({ ctrlKey: true, altKey: true }))).toBe("CommandOrControl+Alt+C");
    expect(accelFromEvent(ev({ ctrlKey: true, shiftKey: true }))).toBe("CommandOrControl+Shift+C");
  });

  it("ТРЕБУЕТ модификатор: сочетание глобальное", () => {
    // Назначив просто «C», человек лишится этой буквы во всей системе, включая
    // набор текста в других программах.
    expect(accelFromEvent(ev({}))).toBeNull();
    // Shift+буква это обычная заглавная, а не сочетание.
    expect(accelFromEvent(ev({ shiftKey: true }))).toBeNull();
  });

  it("не принимает сам модификатор за основную клавишу", () => {
    expect(accelFromEvent(ev({ key: "Control", code: "ControlLeft", ctrlKey: true }))).toBeNull();
    expect(accelFromEvent(ev({ key: "Alt", code: "AltLeft", altKey: true }))).toBeNull();
  });

  it("берёт клавишу по коду, а не по символу - раскладка не должна влиять", () => {
    // На русской раскладке та же физическая клавиша даёт «с», и сочетание,
    // записанное символом, перестало бы работать при переключении языка.
    expect(accelFromEvent(ev({ key: "с", code: "KeyC", ctrlKey: true, altKey: true }))).toBe(
      "CommandOrControl+Alt+C",
    );
  });

  it("понимает цифры, функциональные клавиши, стрелки и пробел", () => {
    expect(accelFromEvent(ev({ code: "Digit5", ctrlKey: true, altKey: true }))).toBe("CommandOrControl+Alt+5");
    expect(accelFromEvent(ev({ code: "F9", ctrlKey: true }))).toBe("CommandOrControl+F9");
    expect(accelFromEvent(ev({ code: "Space", ctrlKey: true, altKey: true }))).toBe("CommandOrControl+Alt+Space");
    expect(accelFromEvent(ev({ code: "ArrowUp", ctrlKey: true, altKey: true }))).toBe("CommandOrControl+Alt+ArrowUp");
  });

  it("отказывает на клавишах, которые нельзя назначить", () => {
    expect(accelFromEvent(ev({ code: "Tab", key: "Tab", ctrlKey: true }))).toBeNull();
    expect(accelFromEvent(ev({ code: "Escape", key: "Escape", ctrlKey: true }))).toBeNull();
  });
});

describe("formatAccel", () => {
  it("показывает человеку понятные имена", () => {
    expect(formatAccel("CommandOrControl+Alt+C")).toBe("Ctrl + Alt + C");
    expect(formatAccel("CommandOrControl+Alt+Space")).toBe("Ctrl + Alt + Пробел");
  });
});

describe("isValidAccel", () => {
  it("принимает нормальные сочетания", () => {
    expect(isValidAccel("CommandOrControl+Alt+C")).toBe(true);
    expect(isValidAccel("Alt+F9")).toBe(true);
  });

  it("отказывает тому, что могло попасть в файл настроек руками", () => {
    expect(isValidAccel("C")).toBe(false);
    expect(isValidAccel("Shift+C")).toBe(false);
    expect(isValidAccel("Ctrl+C")).toBe(false);
    expect(isValidAccel("CommandOrControl+Alt")).toBe(false);
    expect(isValidAccel("")).toBe(false);
  });
});
