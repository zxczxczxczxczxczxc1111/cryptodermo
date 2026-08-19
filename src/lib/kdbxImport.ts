/**
 * Импорт из формата KDBX (KeePass 2) - обратная сторона моста, который
 * `kdbxExport.ts` открыл наружу. Смысл именно в переезде В cryptodermo из
 * KeePassXC / KeePassium / Strongbox / KeePassDX, а не в возврате нашего же
 * экспорта.
 *
 * ТОЧНОГО ROUND-TRIP С НАШИМ ЭКСПОРТОМ НЕ БЫВАЕТ, и обещать его нельзя.
 * Причина в самом экспорте: `classifyKdbxFields` раскладывает наши поля по
 * стандартным слотам KDBX ЭВРИСТИКОЙ (первое секретное не-TOTP становится
 * `Password`, первое похожее на адрес - `URL`, первое оставшееся несекретное
 * - `UserName`), и оригинальные имена полей при этом теряются: поле «Почта»
 * уезжает в `UserName` и возвращается «Логином». Это цена совместимости с
 * чужим форматом, у которого фиксированные слоты, а не наш свободный набор
 * полей.
 *
 * ARGON2 (решение пользователя 19.08.2026). Современные клиенты по умолчанию
 * пишут KDBX4 с Argon2, а `kdbxweb` его намеренно не реализует и требует
 * подключить свою реализацию (`CryptoEngine.setArgon2Impl`). Без неё импорт
 * был бы бесполезен на большинстве реальных файлов, поэтому добавлена
 * зависимость `hash-wasm` (R31 - согласовано отдельно).
 *
 * Почему `hash-wasm`, а не `argon2-browser` из примера в документации
 * `kdbxweb`: второй грузит отдельный файл `.wasm` рядом со сборкой, что в
 * упакованном Tauri-приложении означает возню с путями к ресурсам; у
 * `hash-wasm` WebAssembly вшит в сам JS (проверено фактом: в пакете нет ни
 * одного файла `.wasm`), то есть грузить нечего.
 *
 * Единицы измерения проверены ПО ИСХОДНИКАМ `kdbxweb`, не по документации:
 * `encryptArgon2` зовёт реализацию как `argon2(key, salt, memory / 1024,
 * ...)`, то есть память приходит уже в кибибайтах - ровно то, что ждёт
 * `memorySize` у `hash-wasm`. Версия бывает 0x13 и 0x10; `hash-wasm`
 * реализует только текущую 0x13 (v1.3), поэтому 0x10 отклоняется явной
 * ошибкой, а не молча считает не тот хеш.
 */

import * as kdbxweb from "kdbxweb";
import { argon2d, argon2i, argon2id } from "hash-wasm";
import type { Attachment, ItemField, NewItemInput } from "./vaultStore";
import { bytesToBase64 } from "./base64";
import { CSV_LOGIN_FIELD_NAME, CSV_PASSWORD_FIELD_NAME, CSV_URL_FIELD_NAME } from "./importExport";
import { TOTP_FIELD_NAME } from "./totp";

/** Один текст на все отказы разбора - неверный пароль и повреждённый файл
 * криптографически не различимы, тот же принцип, что у `DecryptError`/
 * `FormatError` в остальном проекте. Неподдерживаемый вариант формата
 * выделен отдельно: это единственный случай, где человек может что-то
 * осмысленно сделать (пересохранить файл в другом формате). */
export class KdbxImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KdbxImportError";
  }
}

export const KDBX_IMPORT_FAILED_MESSAGE =
  "Не удалось открыть файл: неверный пароль или файл повреждён.";

export const KDBX_UNSUPPORTED_KDF_MESSAGE =
  "Файл использует устаревшую версию Argon2 (0x10), которую приложение не поддерживает. Откройте базу в KeePass и пересохраните её.";

/** Версия Argon2, которую умеет `hash-wasm` (v1.3). Значение из заголовка
 * KDBX, см. `encryptArgon2` в исходниках `kdbxweb`. */
const ARGON2_VERSION_13 = 0x13;

/** Типы Argon2 в терминах KDBX: 0 - Argon2d (по умолчанию у KeePass),
 * 1 - Argon2i, 2 - Argon2id. */
const ARGON2_TYPE_D = 0;
const ARGON2_TYPE_ID = 2;

let argon2Registered = false;

/**
 * Подключить Argon2 к `kdbxweb`. Идемпотентно: библиотека держит реализацию
 * в модульной переменной, повторная регистрация просто перезапишет ту же
 * функцию, но лишней работы делать незачем.
 */
export function ensureArgon2(): void {
  if (argon2Registered) return;
  argon2Registered = true;
  kdbxweb.CryptoEngine.setArgon2Impl(
    async (password, salt, memory, iterations, length, parallelism, type, version) => {
      if (version !== ARGON2_VERSION_13) {
        throw new KdbxImportError(KDBX_UNSUPPORTED_KDF_MESSAGE);
      }
      const options = {
        password: new Uint8Array(password),
        salt: new Uint8Array(salt),
        iterations,
        parallelism,
        memorySize: memory,
        hashLength: length,
        outputType: "binary" as const,
      };
      const hash =
        type === ARGON2_TYPE_D
          ? await argon2d(options)
          : type === ARGON2_TYPE_ID
            ? await argon2id(options)
            : await argon2i(options);
      return hash;
    },
  );
}

/** Значение поля KDBX - либо обычная строка, либо защищённое значение. */
type KdbxFieldValue = string | { getText(): string };

function fieldText(value: KdbxFieldValue | undefined): string {
  if (value === undefined) return "";
  return typeof value === "string" ? value : value.getText();
}

function isProtected(value: KdbxFieldValue | undefined): boolean {
  return typeof value === "object" && value !== null && typeof value.getText === "function";
}

/** Стандартные слоты KDBX, которые раскладываются по своим местам, а не
 * попадают в список произвольных полей. */
const STANDARD_FIELDS = new Set(["Title", "Notes", "UserName", "Password", "URL", "otp"]);

/**
 * Одна запись KeePass -> наша запись. Чистая функция над уже прочитанными
 * значениями (не над объектом `kdbxweb`), чтобы её можно было проверить
 * тестом без сборки настоящего файла - тот же приём, что и в остальном
 * проекте.
 *
 * `type` выводится по содержимому: есть пароль - это `login`, нет ни одного
 * поля вовсе - `note` (в KeePass так выглядят обычные заметки), иначе
 * `other`. Угадывание грубое намеренно: тип у нас влияет только на подпись и
 * на набор предзаполненных полей при создании, а не на хранение.
 */
export function kdbxEntryToItem(entry: {
  fields: Map<string, KdbxFieldValue>;
  tags?: string[];
  groupName?: string;
  attachments?: Attachment[];
}): NewItemInput {
  const fields: ItemField[] = [];

  const username = fieldText(entry.fields.get("UserName"));
  if (username !== "") {
    fields.push({ name: CSV_LOGIN_FIELD_NAME, value: username, secret: false });
  }

  const password = fieldText(entry.fields.get("Password"));
  if (password !== "") {
    fields.push({ name: CSV_PASSWORD_FIELD_NAME, value: password, secret: true });
  }

  const url = fieldText(entry.fields.get("URL"));
  if (url !== "") {
    fields.push({ name: CSV_URL_FIELD_NAME, value: url, secret: false });
  }

  const otp = fieldText(entry.fields.get("otp"));
  if (otp !== "") {
    fields.push({ name: TOTP_FIELD_NAME, value: otp, secret: true });
  }

  for (const [name, value] of entry.fields) {
    if (STANDARD_FIELDS.has(name)) continue;
    const text = fieldText(value);
    if (text === "") continue;
    fields.push({ name, value: text, secret: isProtected(value) });
  }

  // Теги берутся из `entry.tags` - именно туда их кладёт наш экспорт. Имя
  // группы добавляется тегом только если оно осмысленное: корневая группа
  // называется именем базы и тегом быть не должна.
  const tags = [...(entry.tags ?? [])];
  const groupName = entry.groupName?.trim() ?? "";
  if (groupName !== "" && !tags.some((t) => t.toLowerCase() === groupName.toLowerCase())) {
    tags.push(groupName);
  }

  return {
    type: password !== "" ? "login" : fields.length === 0 ? "note" : "other",
    title: fieldText(entry.fields.get("Title")),
    tags,
    fields,
    note: fieldText(entry.fields.get("Notes")),
    attachments: entry.attachments ?? [],
  };
}

/** Расширение файла -> MIME-тип. Та же маленькая копия, что в `Editor.tsx`:
 * KDBX хранит у вложения только имя и байты, тип приходится угадывать. */
const MIME_TYPES_BY_EXTENSION: Record<string, string> = {
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  pdf: "application/pdf",
  zip: "application/zip",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
};

function guessMimeType(filename: string): string {
  const idx = filename.lastIndexOf(".");
  const ext = idx === -1 ? "" : filename.slice(idx + 1).toLowerCase();
  return MIME_TYPES_BY_EXTENSION[ext] ?? "application/octet-stream";
}

export function attachmentFromKdbxBinary(name: string, bytes: Uint8Array): Attachment {
  return {
    id: crypto.randomUUID(),
    name,
    mimeType: guessMimeType(name),
    size: bytes.length,
    data: bytesToBase64(bytes),
  };
}

/**
 * Достать байты вложения. Форма значения у `kdbxweb` на ЧТЕНИИ разная в
 * зависимости от того, чем создан файл: `{ hash, value }`, сам
 * `ProtectedValue` или голый `ArrayBuffer` - поэтому разбираются все три, а
 * не одна «правильная» (найдено при экспорте: там после перезагрузки файла
 * значение приезжало как `{ hash, value }`, хотя записывалось как
 * `ProtectedValue`).
 */
export function kdbxBinaryToBytes(binary: unknown): Uint8Array | null {
  const hasGetBinary = (v: unknown): v is { getBinary(): Uint8Array } =>
    v !== null && typeof v === "object" && typeof (v as { getBinary?: unknown }).getBinary === "function";

  // `getBinary` проверяется ПЕРВЫМ и до распаковки обёртки: у самого
  // `ProtectedValue` есть собственное свойство `value` с ЗАШИФРОВАННЫМИ
  // байтами, и наивная распаковка «если есть value, возьми value» молча
  // отдала бы мусор вместо содержимого файла (поймано тестом, не глазами).
  if (hasGetBinary(binary)) return new Uint8Array(binary.getBinary());
  if (binary instanceof ArrayBuffer) return new Uint8Array(binary);
  if (binary instanceof Uint8Array) return binary;

  if (binary !== null && typeof binary === "object" && "value" in binary) {
    const inner = (binary as { value: unknown }).value;
    if (hasGetBinary(inner)) return new Uint8Array(inner.getBinary());
    if (inner instanceof ArrayBuffer) return new Uint8Array(inner);
    if (inner instanceof Uint8Array) return inner;
  }
  return null;
}

/**
 * Прочитать файл KDBX и превратить его записи в кандидатов на добавление.
 * Ничего не пишет в базу: как и CSV-импорт, отдаёт список наружу, а решение
 * добавлять принимает `ImportExportPanel.tsx` после подтверждения.
 *
 * Записи собираются из ВСЕХ групп рекурсивно: у KeePass дерево групп, а у нас
 * плоский список с тегами, поэтому вложенность превращается в имя ближайшей
 * группы, положенное тегом (глубже вложенность не воспроизводим - тегам
 * иерархия чужда).
 */
export async function parseKdbxFile(bytes: Uint8Array, password: string): Promise<NewItemInput[]> {
  ensureArgon2();

  const credentials = new kdbxweb.Credentials(kdbxweb.ProtectedValue.fromString(password));
  let db: kdbxweb.Kdbx;
  try {
    // `slice()` даёт отдельный ArrayBuffer нужной длины: у Uint8Array из
    // чтения файла буфер может быть длиннее самого представления.
    db = await kdbxweb.Kdbx.load(bytes.slice().buffer, credentials);
  } catch (err) {
    if (err instanceof KdbxImportError) throw err;
    throw new KdbxImportError(KDBX_IMPORT_FAILED_MESSAGE);
  }

  const items: NewItemInput[] = [];
  const rootGroup = db.getDefaultGroup();
  const rootUuid = rootGroup.uuid?.id;

  for (const entry of rootGroup.allEntries()) {
    const group = entry.parentGroup;
    // Корневая группа называется именем базы - тегом ей быть незачем.
    const groupName = group && group.uuid?.id !== rootUuid ? (group.name ?? "") : "";

    const attachments: Attachment[] = [];
    for (const [name, binary] of entry.binaries) {
      const data = kdbxBinaryToBytes(binary);
      if (data) attachments.push(attachmentFromKdbxBinary(name, data));
    }

    items.push(
      kdbxEntryToItem({
        fields: entry.fields as Map<string, KdbxFieldValue>,
        tags: entry.tags,
        groupName,
        attachments,
      }),
    );
  }

  return items;
}
