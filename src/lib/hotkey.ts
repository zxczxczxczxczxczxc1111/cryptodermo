/**
 * Разбор и показ сочетаний клавиш.
 *
 * Сочетание хранится в том виде, который понимает Tauri: части через плюс,
 * модификаторы первыми, например `CommandOrControl+Alt+C`. Показывается оно
 * иначе - «Ctrl + Alt + C», потому что `CommandOrControl` человеку ничего не
 * говорит.
 *
 * Функции чистые: сочетание собирается из события клавиатуры, а не читается из
 * DOM, поэтому и разбор, и проверка допустимости покрываются тестами.
 */

/** Модификаторы в том порядке, в каком их принято писать и читать. */
const MODIFIER_ORDER = ["CommandOrControl", "Alt", "Shift", "Super"] as const;

const DISPLAY_NAMES: Record<string, string> = {
  CommandOrControl: "Ctrl",
  Alt: "Alt",
  Shift: "Shift",
  Super: "Win",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  " ": "Пробел",
  Space: "Пробел",
};

/** Клавиши, которые сами по себе модификаторы и основной клавишей быть не
 * могут. */
const MODIFIER_KEYS = new Set(["Control", "Alt", "Shift", "Meta", "OS", "AltGraph"]);

export interface HotkeyEventLike {
  key: string;
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

/**
 * Собрать сочетание из нажатия. `null` - нажатие не годится.
 *
 * Требуется хотя бы один модификатор, и это не придирка: сочетание глобальное,
 * оно перехватывает клавишу во ВСЕЙ системе. Назначив просто «C», человек
 * лишится буквы «C» везде, включая набор текста в других программах.
 *
 * Одного Shift тоже мало по той же причине: Shift+буква это обычный ввод
 * заглавной.
 */
export function accelFromEvent(e: HotkeyEventLike): string | null {
  if (MODIFIER_KEYS.has(e.key)) return null;

  const mods: string[] = [];
  if (e.ctrlKey || e.metaKey) mods.push("CommandOrControl");
  if (e.altKey) mods.push("Alt");
  if (e.shiftKey) mods.push("Shift");

  const hasRealModifier = e.ctrlKey || e.metaKey || e.altKey;
  if (!hasRealModifier) return null;

  const key = normalizeKey(e);
  if (!key) return null;

  const ordered = MODIFIER_ORDER.filter((m) => mods.includes(m));
  return [...ordered, key].join("+");
}

/**
 * Имя основной клавиши в терминах Tauri.
 *
 * Берётся `code`, а не `key`: `key` зависит от раскладки и от модификаторов -
 * на русской раскладке та же клавиша даёт «с», а с Shift ещё и «С». Глобальное
 * сочетание должно работать одинаково независимо от того, на каком языке
 * человек сейчас печатает.
 */
function normalizeKey(e: HotkeyEventLike): string | null {
  const code = e.code;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (code === "Space") return "Space";
  if (code.startsWith("Arrow")) return code;
  if (["Home", "End", "PageUp", "PageDown", "Insert", "Delete", "Backquote"].includes(code)) {
    return code;
  }
  return null;
}

/** Человеческий вид: «Ctrl + Alt + C». */
export function formatAccel(accel: string): string {
  return accel
    .split("+")
    .map((part) => DISPLAY_NAMES[part] ?? part)
    .join(" + ");
}

/** Похоже ли на допустимое сочетание. Используется при чтении настроек: там
 * может лежать что угодно, включая правку файла руками. */
export function isValidAccel(accel: string): boolean {
  const parts = accel.split("+");
  if (parts.length < 2) return false;
  const key = parts[parts.length - 1];
  const mods = parts.slice(0, -1);
  if (mods.length === 0) return false;
  if (!mods.every((m) => (MODIFIER_ORDER as readonly string[]).includes(m))) return false;
  if (!mods.some((m) => m === "CommandOrControl" || m === "Alt" || m === "Super")) return false;
  return key.length > 0 && !(MODIFIER_ORDER as readonly string[]).includes(key);
}
