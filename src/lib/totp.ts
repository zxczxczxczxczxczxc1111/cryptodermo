/**
 * Одноразовые коды двухфакторной аутентификации (TOTP, RFC 6238).
 *
 * Зачем в менеджере паролей: без этого вход выглядит как «сюда за паролем, в
 * телефон за кодом». Если код живёт рядом с паролем, телефон из цепочки
 * выпадает совсем.
 *
 * КАК ЭТО РАБОТАЕТ И ПОЧЕМУ НЕ КОНФЛИКТУЕТ С ТЕЛЕФОНОМ. Код никуда не
 * передаётся и нигде не хранится. Есть общий секрет, выданный сайтом при
 * включении двухфакторки; из него и текущего времени считается число, которое
 * сайт считает у себя точно так же и сравнивает. Секрет можно скопировать в
 * сколько угодно приложений, и все они будут показывать одинаковые цифры -
 * поэтому Google Authenticator на телефоне и эта программа рядом друг другу не
 * мешают, как два одинаковых ключа от одной двери.
 *
 * ЧЕГО ЭТО СТОИТ. Пароль и второй фактор в одном хранилище - это полтора
 * фактора, а не два: кто вскрыл базу, получил и то и другое. Для большинства
 * сайтов приемлемо, для главной почты и банка код лучше оставить только на
 * телефоне. Решение осознанное, принято пользователем 17.08.2026.
 *
 * ФОРМАТ ХРАНЕНИЯ. Секрет лежит обычным секретным полем записи, значением
 * которого является ссылка `otpauth://`. Формат `vault.dat`, `FORMAT.md` и
 * аварийный дешифратор при этом не меняются вовсе - приложение просто узнаёт
 * префикс. Это самая дешёвая из возможных реализаций: правка формата тянет за
 * собой независимый парсер и тест кросс-совместимости.
 *
 * Реализация опирается только на `crypto.subtle` (HMAC-SHA1), внешних
 * зависимостей нет. Проверено на всех шести эталонных векторах RFC 6238.
 */

/** Значение поля, которое приложение трактует как секрет двухфакторки. */
export const OTPAUTH_PREFIX = "otpauth://";

/** Шаг времени по умолчанию, секунды (RFC 6238 рекомендует 30). */
export const DEFAULT_PERIOD = 30;

/** Длина кода по умолчанию. */
export const DEFAULT_DIGITS = 6;

export type TotpAlgorithm = "SHA-1" | "SHA-256" | "SHA-512";

export interface TotpParams {
  /** Секрет в сыром виде (уже раскодированный из base32). */
  secret: Uint8Array;
  digits: number;
  period: number;
  algorithm: TotpAlgorithm;
  /** Имя записи у поставщика (`issuer:account`) - только для показа. */
  label: string | null;
  issuer: string | null;
}

/** Значение поля не является ссылкой `otpauth://` или разобрать её не вышло. */
export class TotpParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TotpParseError";
  }
}

/** Похоже ли значение поля на секрет двухфакторки. Дешёвая проверка для
 * решения «рисовать ли живой код», без полного разбора. */
export function looksLikeTotp(value: string): boolean {
  return value.trim().toLowerCase().startsWith(OTPAUTH_PREFIX);
}

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/**
 * Раскодировать base32 (RFC 4648) - в этом виде секреты и печатают на сайтах.
 *
 * Пробелы и дефисы выбрасываются: сайты разбивают ключ на группы по четыре
 * символа для читаемости, и человек копирует его прямо так. Дополняющие `=`
 * тоже: они ничего не значат для длины результата.
 */
export function base32Decode(input: string): Uint8Array {
  const clean = input.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  if (clean === "") throw new TotpParseError("Пустой секрет");

  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const index = BASE32_ALPHABET.indexOf(ch);
    if (index === -1) throw new TotpParseError(`Недопустимый символ в секрете: «${ch}»`);
    buffer = (buffer << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Разобрать ссылку `otpauth://totp/Label?secret=...`.
 *
 * Поддерживается только `totp`. `hotp` (счётчик вместо времени) сознательно не
 * поддержан: он требует хранить и увеличивать счётчик при каждом показе, то
 * есть писать в базу на каждый взгляд на код, и встречается сегодня редко.
 */
export function parseOtpauth(uri: string): TotpParams {
  const trimmed = uri.trim();
  if (!looksLikeTotp(trimmed)) {
    throw new TotpParseError("Значение не является ссылкой otpauth://");
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new TotpParseError("Ссылку не удалось разобрать");
  }

  if (url.host.toLowerCase() !== "totp") {
    throw new TotpParseError(`Поддерживается только totp, а не «${url.host}»`);
  }

  const rawSecret = url.searchParams.get("secret");
  if (!rawSecret) throw new TotpParseError("В ссылке нет параметра secret");

  const digits = Number(url.searchParams.get("digits") ?? DEFAULT_DIGITS);
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) {
    throw new TotpParseError(`Недопустимая длина кода: ${digits}`);
  }

  const period = Number(url.searchParams.get("period") ?? DEFAULT_PERIOD);
  if (!Number.isInteger(period) || period <= 0) {
    throw new TotpParseError(`Недопустимый период: ${period}`);
  }

  const rawAlg = (url.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
  const algorithm: TotpAlgorithm =
    rawAlg === "SHA1" ? "SHA-1" : rawAlg === "SHA256" ? "SHA-256" : rawAlg === "SHA512" ? "SHA-512" : (() => {
      throw new TotpParseError(`Неизвестный алгоритм: ${rawAlg}`);
    })();

  const label = decodeURIComponent(url.pathname.replace(/^\//, "")) || null;
  const issuer = url.searchParams.get("issuer");

  return { secret: base32Decode(rawSecret), digits, period, algorithm, label, issuer };
}

/** Номер текущего временного шага - он же счётчик, который хешируется. */
export function counterFor(unixSeconds: number, period: number): number {
  return Math.floor(unixSeconds / period);
}

/** Сколько секунд текущий код ещё будет действителен. */
export function secondsRemaining(unixSeconds: number, period: number): number {
  return period - (Math.floor(unixSeconds) % period);
}

/** Счётчик как 8 байт big-endian - так его требует RFC 4226. */
function counterToBytes(counter: number): ArrayBuffer {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  return buffer;
}

/**
 * Посчитать код для заданного момента времени.
 *
 * `unixSeconds` параметром, а не `Date.now()` внутри - тот же принцип
 * тестируемости, что и у остального в проекте: без этого функцию нельзя было
 * бы проверить эталонными векторами.
 */
export async function totpCode(params: TotpParams, unixSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    params.secret as BufferSource,
    { name: "HMAC", hash: params.algorithm },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, counterToBytes(counterFor(unixSeconds, params.period))),
  );

  // Динамическая усечка (RFC 4226 §5.3): младшие четыре бита последнего байта
  // указывают, с какого места брать четыре байта результата. Это не
  // «оптимизация», а часть стандарта - без неё коды не совпадут с сервером.
  const offset = mac[mac.length - 1] & 0x0f;
  const binary =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];

  return String(binary % 10 ** params.digits).padStart(params.digits, "0");
}

/** Разбить код пополам для показа: «123 456» читается заметно легче, чем
 * «123456», а перенабирать его руками приходится часто. */
export function formatCodeForDisplay(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** Имя поля, которое заводит кнопка «Код двухфакторки». */
export const TOTP_FIELD_NAME = "Двухфакторка";

/**
 * Похоже ли на голый секрет base32, каким его печатают сайты рядом с QR.
 *
 * Порог в 16 символов не случаен: секреты короче встречаются только в
 * учебных примерах, а без нижней границы под определение попало бы любое
 * слово из букв A-Z, вроде «PASSWORD».
 */
export function looksLikeBase32Secret(value: string): boolean {
  const clean = value.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  return clean.length >= 16 && /^[A-Z2-7]+$/.test(clean);
}

/** Собрать ссылку из голого секрета - в базе хранится всегда ссылка, чтобы у
 * значения был один-единственный формат. */
export function buildOtpauthUri(secret: string, label: string): string {
  const clean = secret.replace(/[\s-]/g, "").replace(/=+$/, "").toUpperCase();
  const name = encodeURIComponent(label.trim() || "cryptodermo");
  return `${OTPAUTH_PREFIX}totp/${name}?secret=${clean}`;
}

/**
 * Привести введённое человеком к ссылке `otpauth://`.
 *
 * Принимает и то, и другое, потому что сайты дают то одно, то другое: одни
 * показывают QR и ссылку целиком, другие только строку вроде
 * «JBSW Y3DP EHPK 3PXP». Требовать от человека знать разницу - лишний повод
 * ошибиться там, где ошибка выглядит как «приложение показывает не те цифры».
 *
 * `null` означает «не понял»: вызывающий код должен сказать об этом вслух, а
 * не сохранить мусор, который потом молча не сойдётся с сайтом.
 */
export function normalizeTotpInput(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (looksLikeTotp(trimmed)) {
    try {
      parseOtpauth(trimmed);
      return trimmed;
    } catch {
      return null;
    }
  }
  if (!looksLikeBase32Secret(trimmed)) return null;
  const uri = buildOtpauthUri(trimmed, label);
  try {
    parseOtpauth(uri);
    return uri;
  } catch {
    return null;
  }
}
