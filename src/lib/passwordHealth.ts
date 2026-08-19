/**
 * Проверка базы на слабые/повторяющиеся пароли (тикет 12). Чистая функция
 * над `Item[]`, без побочных эффектов - экран (`Settings.tsx`) только читает
 * результат как два числа среди прочих фактов о базе ("Состояние базы"), тем
 * же пассивным способом, что и остальные ("Записей", "Резервная копия").
 *
 * Условие пользователя дословно: "без спама и прочих навязчивых оповещений" -
 * поэтому здесь нет уведомлений/тостов/бейджей, только число, на которое
 * смотрят, когда сами решили посмотреть (R87 того же духа, что и остальной
 * экран настроек).
 *
 * Область проверки - та же, что у индикатора силы пароля в редакторе (см.
 * `isPasswordField` в `Editor.tsx`): секретные поля с именем "Пароль", не
 * любое секретное поле подряд. CVC/ключ и т.п. - секретные, но не пароли,
 * оценка силы/повтора для них бессмысленна и создала бы шум именно там, где
 * пользователь просил его не создавать.
 */

import type { Item } from "./vaultStore";
import { estimatePasswordStrength } from "./passwordStrength";

const PASSWORD_FIELD_NAME = "пароль";

export type PasswordHealthSummary = {
  /** Сколько полей "Пароль" в базе оценены как слабые. */
  weakCount: number;
  /** Сколько полей "Пароль" делят значение хотя бы с одним другим полем
   * "Пароль" в базе (считаются все участники повтора, не только "лишние"
   * копии - это ближе к вопросу "сколько записей нужно поменять"). */
  reusedCount: number;
};

function collectPasswordValues(items: readonly Item[]): string[] {
  const values: string[] = [];
  for (const item of items) {
    for (const field of item.fields) {
      if (field.secret && field.value !== "" && field.name.trim().toLowerCase() === PASSWORD_FIELD_NAME) {
        values.push(field.value);
      }
    }
  }
  return values;
}

export function analyzePasswordHealth(items: readonly Item[]): PasswordHealthSummary {
  const values = collectPasswordValues(items);

  const weakCount = values.filter((value) => estimatePasswordStrength(value).level === "weak").length;

  const occurrences = new Map<string, number>();
  for (const value of values) {
    occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
  }
  let reusedCount = 0;
  for (const count of occurrences.values()) {
    if (count > 1) reusedCount += count;
  }

  return { weakCount, reusedCount };
}
