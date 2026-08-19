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

/** Значения полей «Пароль» по всей базе. Экспортирована, чтобы проверка на
 * утечки (`breachCheck.ts`) считала ТУ ЖЕ вселенную паролей, что и слабые с
 * повторяющимися: три числа стоят в одном блоке настроек, и считай они разное,
 * это заметили бы сразу. */
export function collectPasswordValues(items: readonly Item[]): string[] {
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

/** Какие проблемы у паролей ОДНОЙ записи. Уровень записи, в отличие от
 * чисел выше: числа считают поля (запись с тремя слабыми паролями даёт 3),
 * а значок и переход к записям работают с записями (та же запись - одна).
 * Расхождение осознанное: «сколько паролей поменять» и «в скольких записях
 * это делать» - разные вопросы, и оба нужны. */
export type ItemPasswordIssues = {
  weak: boolean;
  reused: boolean;
  breached: boolean;
};

export const NO_PASSWORD_ISSUES: ItemPasswordIssues = { weak: false, reused: false, breached: false };

/** Пароли записи - те же правила отбора, что у `collectPasswordValues`. */
function itemPasswordValues(item: Item): string[] {
  return item.fields
    .filter((f) => f.secret && f.value !== "" && f.name.trim().toLowerCase() === PASSWORD_FIELD_NAME)
    .map((f) => f.value);
}

/**
 * Проблемы паролей записи.
 *
 * `breachedValues` - значения, которые проверка утечек нашла в чужих базах.
 * Приходят снаружи, а не считаются здесь: из базы «засвечен в утечке» не
 * выводится вовсе, это ответ стороннего сервиса. Передаётся набор ЗНАЧЕНИЙ,
 * а не идентификаторов записей, специально: поменял пароль - пометка
 * снимается сама, без устаревшего снимка.
 */
export type PasswordIssueChecker = (item: Item) => ItemPasswordIssues;

/**
 * Подготовить проверку один раз на всю базу, а не пересобирать её на каждую
 * запись: карта повторов строится по всей базе, а список виртуализирован и
 * спрашивает про каждую видимую строку - наивная реализация давала бы
 * квадрат на базе в тысячи записей.
 */
export function createPasswordIssueChecker(
  allItems: readonly Item[],
  breachedValues?: ReadonlySet<string>,
): PasswordIssueChecker {
  const occurrences = new Map<string, number>();
  for (const value of collectPasswordValues(allItems)) {
    occurrences.set(value, (occurrences.get(value) ?? 0) + 1);
  }

  return (item: Item): ItemPasswordIssues => {
    const values = itemPasswordValues(item);
    if (values.length === 0) return NO_PASSWORD_ISSUES;
    return {
      weak: values.some((v) => estimatePasswordStrength(v).level === "weak"),
      // Повтором считается значение, встречающееся в базе больше одного
      // раза - включая случай «два аккаунта одной записи делят пароль». Так
      // же это считают и числа выше, менять трактовку на полпути нельзя.
      reused: values.some((v) => (occurrences.get(v) ?? 0) > 1),
      breached: breachedValues ? values.some((v) => breachedValues.has(v)) : false,
    };
  };
}

/** Разовая проверка одной записи. Для списка использовать
 * `createPasswordIssueChecker`, иначе карта повторов пересобирается на
 * каждую строку. */
export function itemPasswordIssues(
  item: Item,
  allItems: readonly Item[],
  breachedValues?: ReadonlySet<string>,
): ItemPasswordIssues {
  return createPasswordIssueChecker(allItems, breachedValues)(item);
}

export function hasAnyPasswordIssue(issues: ItemPasswordIssues): boolean {
  return issues.weak || issues.reused || issues.breached;
}

/** Записи с заданной проблемой - для перехода из настроек к списку. */
export function itemsWithPasswordIssue(
  items: readonly Item[],
  kind: keyof ItemPasswordIssues,
  breachedValues?: ReadonlySet<string>,
): Item[] {
  const check = createPasswordIssueChecker(items, breachedValues);
  return items.filter((item) => check(item)[kind]);
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
