/**
 * Формат файла базы (`vault-format` из interfaces.md): сериализация и разбор
 * контейнера `vault.dat`. Весь файл - это один текстовый UTF-8 JSON-документ:
 * открытый заголовок (версия формата, параметры KDF, алгоритм шифрования,
 * IV) плюс зашифрованное тело как base64-строка в том же объекте. Никакого
 * отдельного бинарного формата или ручного порядка байт вне JSON - точное
 * описание полей и кодировок в `FORMAT.md`, этот файл только (де)сериализует
 * то же самое.
 *
 * Модуль не знает про пароли и ключи (это `crypto.ts`) и не знает про модель
 * записей `Item[]` (это `vaultStore.ts`) - только заголовок и байты
 * шифротекста как есть.
 */

import { base64ToBytes, bytesToBase64 } from "./base64";

/** Текущая (единственная поддерживаемая) версия формата. */
const CURRENT_VERSION = 1;

/**
 * Открытый заголовок контейнера. Ровно то, что описано в spec.md §2 и
 * `FORMAT.md`, без поля `ct` - шифротекст (не часть заголовка) передаётся
 * и возвращается отдельным аргументом как байты (`Uint8Array`), декодирует
 * его из/в base64 сам этот модуль, вызывающему коду base64 для `ct` не
 * видно.
 *
 * `kdf.salt` и `iv` внутри самого заголовка - **base64-строки**, как они
 * буквально лежат в JSON-файле (см. `FORMAT.md` §2): это открытые
 * метаданные, не секрет, и `parseContainer`/`serializeContainer` их не
 * декодируют/кодируют - отдают и принимают как есть. Перевести их в сырые
 * байты для `crypto.ts` (`deriveKey`/`decrypt` ждут `Uint8Array`, не строку)
 * - забота вызывающего кода (`vaultStore.ts`), не этого модуля.
 */
export type VaultHeader = {
  /** Версия формата контейнера. Растёт при несовместимых изменениях. */
  v: number;
  kdf: {
    /** Алгоритм деривации ключа, например `"PBKDF2-SHA256"`. */
    alg: string;
    params: {
      /** Число итераций PBKDF2, использованное для этой конкретной базы. */
      iterations: number;
    };
    /** Соль KDF, base64 (стандартный алфавит, с паддингом). */
    salt: string;
  };
  /** Алгоритм шифрования тела, например `"AES-256-GCM"`. */
  cipher: string;
  /** IV шифрования, base64. IV не секрет - он живёт в открытом заголовке. */
  iv: string;
};

/**
 * Ошибка разбора контейнера: не JSON, не объект, отсутствует обязательное
 * поле или неизвестная версия формата (`v`). Отдельный тип на случай, если
 * вызывающему коду понадобится отличить "файл не наша база вообще" от
 * `DecryptError` из `crypto.ts` ("файл наш, но пароль неверный или тело
 * повреждено") - оба варианта в UI могут вести к одному тексту (R94.1), но
 * это решение уровня UI, не этого модуля.
 */
export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatError";
  }
}

/**
 * Собрать контейнер: заголовок плюс байты шифротекста -> байты файла
 * (UTF-8 JSON). Шифротекст кладётся в поле `ct` как base64-строка внутри
 * того же JSON-объекта, что и заголовок - весь файл целиком остаётся одним
 * читаемым текстовым документом (R27 - посторонний человек должен суметь
 * написать свой парсер, глядя только на `FORMAT.md`).
 */
export function serializeContainer(
  header: VaultHeader,
  ciphertext: Uint8Array,
): Uint8Array {
  const container = {
    v: header.v,
    kdf: header.kdf,
    cipher: header.cipher,
    iv: header.iv,
    ct: bytesToBase64(ciphertext),
  };
  return new TextEncoder().encode(JSON.stringify(container));
}

/** Прочитать обязательное строковое поле или бросить `FormatError`. */
function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new FormatError(`Invalid vault container: missing or malformed "${field}" field`);
  }
  return value;
}

/** Прочитать обязательное числовое поле или бросить `FormatError`. */
function requireNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new FormatError(`Invalid vault container: missing or malformed "${field}" field`);
  }
  return value;
}

/**
 * Разобрать байты файла обратно в заголовок и байты шифротекста. Бросает
 * `FormatError` с понятным текстом на любой файл, который не является
 * валидным контейнером этого формата - в том числе на неизвестную версию
 * `v`, а не пытается угадать структуру более новой/старой версии (R07 -
 * данные должны читаться через десять лет, а неизвестная версия должна
 * явно и понятно отказывать, а не тихо портить данные).
 */
export function parseContainer(bytes: Uint8Array): {
  header: VaultHeader;
  ciphertext: Uint8Array;
} {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new FormatError("Invalid vault container: not valid UTF-8 text");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new FormatError("Invalid vault container: not valid JSON");
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new FormatError("Invalid vault container: expected a JSON object");
  }
  const obj = raw as Record<string, unknown>;

  const v = requireNumber(obj.v, "v");
  if (v !== CURRENT_VERSION) {
    throw new FormatError(
      `Unsupported vault format version: ${v} (this build only supports version ${CURRENT_VERSION})`,
    );
  }

  if (typeof obj.kdf !== "object" || obj.kdf === null) {
    throw new FormatError('Invalid vault container: missing or malformed "kdf" field');
  }
  const kdfObj = obj.kdf as Record<string, unknown>;
  const alg = requireString(kdfObj.alg, "kdf.alg");
  const salt = requireString(kdfObj.salt, "kdf.salt");

  if (typeof kdfObj.params !== "object" || kdfObj.params === null) {
    throw new FormatError('Invalid vault container: missing or malformed "kdf.params" field');
  }
  const iterations = requireNumber(
    (kdfObj.params as Record<string, unknown>).iterations,
    "kdf.params.iterations",
  );

  const cipher = requireString(obj.cipher, "cipher");
  const iv = requireString(obj.iv, "iv");
  const ct = requireString(obj.ct, "ct");

  const header: VaultHeader = {
    v,
    kdf: { alg, params: { iterations }, salt },
    cipher,
    iv,
  };

  let ciphertext: Uint8Array;
  try {
    ciphertext = base64ToBytes(ct);
  } catch {
    throw new FormatError('Invalid vault container: malformed base64 in "ct" field');
  }

  return { header, ciphertext };
}
