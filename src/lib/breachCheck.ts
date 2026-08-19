/**
 * Проверка паролей на попадание в известные утечки (Have I Been Pwned).
 *
 * ВТОРОЕ И ПОСЛЕДНЕЕ МЕСТО В ПРИЛОЖЕНИИ, КОТОРОЕ ХОДИТ В СЕТЬ (первое -
 * `updateCheck.ts`). Правила те же: по умолчанию выключено, включается
 * галочкой в настройках, запускается кнопкой и никогда само.
 *
 * КАК УСТРОЕНО (k-anonymity). Считается SHA-1 пароля, наружу уходят только
 * ПЕРВЫЕ 5 шестнадцатеричных символов хеша, в ответ приходят все суффиксы
 * известных утёкших хешей с этим префиксом (обычно несколько сотен), и
 * сверка идёт локально. Ни пароль, ни его полный хеш машину не покидают.
 *
 * ЧТО ВСЁ-ТАКИ ВИДНО СНАРУЖИ, и это честно сказать в интерфейсе:
 * - количество запросов равно количеству УНИКАЛЬНЫХ паролей в базе;
 * - наблюдатель сети видит по имени узла сам факт обращения к
 *   `api.pwnedpasswords.com`, то есть что человек проверяет свои пароли;
 * - префикс из 5 символов сужает пространство примерно до одной миллионной
 *   от всех хешей - это не пароль, но и не ноль информации.
 *
 * SHA-1 здесь не выбор и не рекомендация: этого требует протокол сервиса.
 * Берётся из `crypto.subtle`, новой зависимости не нужно.
 *
 * ВАЖНАЯ ТОНКОСТЬ ОТВЕТА. Сервис умеет добивать ответ фальшивыми суффиксами
 * (заголовок `Add-Padding`), чтобы по размеру ответа нельзя было судить о
 * запросе. У таких строк счётчик равен нулю. Поэтому совпадением считается
 * только суффикс с ПОЛОЖИТЕЛЬНЫМ счётчиком - иначе появлялись бы ложные
 * «ваш пароль в утечке». Проверка счётчика нужна и без падинга: она ничего
 * не стоит и защищает от этой ошибки навсегда.
 */

const HIBP_RANGE_URL = "https://api.pwnedpasswords.com/range/";

/** Пауза между запросами: база может содержать десятки уникальных паролей, и
 * долбить чужой бесплатный сервис очередью без передышки невежливо. */
export const BREACH_REQUEST_DELAY_MS = 150;

export class BreachCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BreachCheckError";
  }
}

export const BREACH_NETWORK_FAILED_MESSAGE =
  "Не удалось связаться с сервисом проверки. Проверьте подключение к интернету и попробуйте снова.";

/** SHA-1 в верхнем регистре - формат, в котором работает HIBP. */
export async function sha1Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
}

/**
 * Разобрать ответ сервиса и узнать, сколько раз пароль встречался в утечках.
 * Формат ответа - строки `СУФФИКС:СЧЁТЧИК`.
 *
 * Ноль означает «не найден», и это же значение приходит у фальшивых строк
 * падинга - отдельного случая для них не нужно, достаточно не считать
 * совпадением нулевой счётчик.
 */
export function countFromRangeResponse(body: string, suffix: string): number {
  const target = suffix.toUpperCase();
  for (const line of body.split("\n")) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    if (line.slice(0, sep).trim().toUpperCase() !== target) continue;
    const count = Number.parseInt(line.slice(sep + 1).trim(), 10);
    return Number.isFinite(count) && count > 0 ? count : 0;
  }
  return 0;
}

/**
 * Проверить один пароль. Возвращает число утечек (0 - не найден).
 *
 * Заголовков к запросу не добавляется НИ ОДНОГО, и это осознанно: `Add-Padding`
 * у HIBP нестандартный, а нестандартный заголовок превращает простой запрос в
 * запрос с предварительным `OPTIONS`, и работоспособность начинает зависеть от
 * настроек чужого сервиса, которые мы не контролируем. Падинг защищает от
 * анализа размера ответа - угроза заметно более экзотическая, чем «функция
 * молча перестала работать у пользователя».
 */
export async function checkPasswordBreached(password: string, timeoutMs = 10_000): Promise<number> {
  const hash = await sha1Hex(password);
  const prefix = hash.slice(0, 5);
  const suffix = hash.slice(5);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${HIBP_RANGE_URL}${prefix}`, { signal: controller.signal });
    if (!response.ok) {
      throw new BreachCheckError(`Сервис ответил ${response.status}`);
    }
    return countFromRangeResponse(await response.text(), suffix);
  } catch (err) {
    if (err instanceof BreachCheckError) throw err;
    throw new BreachCheckError(BREACH_NETWORK_FAILED_MESSAGE);
  } finally {
    clearTimeout(timer);
  }
}

export type BreachCheckProgress = { done: number; total: number };

export type BreachCheckSummary = {
  /** Сколько РАЗНЫХ паролей нашлось в утечках. */
  breachedCount: number;
  /** Сколько уникальных паролей проверено всего. */
  checkedCount: number;
  /**
   * САМИ засвеченные значения - нужны, чтобы пометить проблемные записи
   * значком в списке и карточке. Значения, а не идентификаторы записей:
   * поменял пароль - пометка снимается сама, без устаревшего снимка.
   *
   * При прерывании (`shouldStop`) набор ЧАСТИЧНЫЙ и это нормально: пометить
   * то, что уже успели узнать, честнее, чем выбросить результат работы.
   * Полностью набор живёт до блокировки базы, вместе с расшифрованными
   * данными, и чистится там же.
   */
  breachedValues: Set<string>;
};

/**
 * Проверить набор паролей. На вход идут уже уникальные значения (группировка
 * - забота вызывающего кода, см. `collectPasswordValues` в
 * `passwordHealth.ts`): один и тот же пароль в пяти записях должен стоить
 * одного запроса, а не пяти.
 *
 * `shouldStop` спрашивается перед каждым запросом - проверка базы на полсотни
 * паролей идёт заметное время, и если за это время сработала автоблокировка,
 * цикл обязан прекратиться: иначе он продолжал бы держать значения паролей в
 * памяти уже после того, как база считается закрытой.
 */
export async function checkPasswordsBreached(
  uniquePasswords: readonly string[],
  options: {
    onProgress?: (progress: BreachCheckProgress) => void;
    shouldStop?: () => boolean;
    delayMs?: number;
  } = {},
): Promise<BreachCheckSummary> {
  const { onProgress, shouldStop, delayMs = BREACH_REQUEST_DELAY_MS } = options;
  const breachedValues = new Set<string>();
  let checkedCount = 0;

  for (const password of uniquePasswords) {
    if (shouldStop?.()) break;
    if (checkedCount > 0 && delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    const count = await checkPasswordBreached(password);
    if (count > 0) breachedValues.add(password);
    checkedCount++;
    onProgress?.({ done: checkedCount, total: uniquePasswords.length });
  }

  return { breachedCount: breachedValues.size, checkedCount, breachedValues };
}
