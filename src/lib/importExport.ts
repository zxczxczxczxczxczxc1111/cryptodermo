/**
 * Ручной бэкап и импорт/экспорт (тикет 10, R99/R100/R100.1, spec.md §12).
 *
 * Этот модуль держит только ЧИСТУЮ логику этого шва - разбор/валидацию
 * файла импорта, сериализацию экспорта, имена файлов по умолчанию и текст
 * двойного подтверждения. Ничего не читает и не пишет на диск и не знает
 * про `@tauri-apps/plugin-dialog` - системные диалоги и запись байт через
 * `tauriApi.ts` (`writeVaultAtomic`/`readVault`) делает
 * `ImportExportPanel.tsx`, этот файл он только вызывает. Такое разделение
 * даёт то же самое, что уже сделано в `PasswordGenerator.tsx` (см. его
 * комментарий) - проект без jsdom/@testing-library не может смонтировать
 * компонент в тесте, поэтому автотестами покрывается именно эта чистая
 * часть, а не рендер/клики.
 */

import type { Attachment, Item, ItemField, ItemHistoryEntry, ItemType } from "./vaultStore";

/** Файл импорта не является валидным экспортом Vault: не JSON, не массив,
 * либо у одной из записей неверный тип/отсутствует обязательное поле.
 * Единый тип ошибки для всех причин отказа - вызывающему коду (UI) не нужно
 * различать, что именно сломано, только показать одно понятное сообщение
 * (R85) и не трогать `VaultStore` (R100.1: отказ целиком, без частичного
 * применения - см. `parseImportFile` ниже: функция либо возвращает полный
 * валидный массив, либо бросает, третьего не дано, частичный результат
 * структурно невозможен).
 */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

const VALID_ITEM_TYPES: ReadonlySet<string> = new Set<ItemType>(["login", "note", "card", "key", "other"]);

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string") {
    throw new ImportValidationError(`${path}: expected a string`);
  }
  return value;
}

function requireNumber(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ImportValidationError(`${path}: expected a number`);
  }
  return value;
}

function requireBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") {
    throw new ImportValidationError(`${path}: expected a boolean`);
  }
  return value;
}

function requireObject(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ImportValidationError(`${path}: expected an object`);
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new ImportValidationError(`${path}: expected an array`);
  }
  return value;
}

function validateStringArray(value: unknown, path: string): string[] {
  return requireArray(value, path).map((entry, i) => requireString(entry, `${path}[${i}]`));
}

function validateField(value: unknown, path: string): ItemField {
  const obj = requireObject(value, path);
  return {
    name: requireString(obj.name, `${path}.name`),
    value: requireString(obj.value, `${path}.value`),
    secret: requireBoolean(obj.secret, `${path}.secret`),
  };
}

function validateAttachment(value: unknown, path: string): Attachment {
  const obj = requireObject(value, path);
  return {
    id: requireString(obj.id, `${path}.id`),
    name: requireString(obj.name, `${path}.name`),
    mimeType: requireString(obj.mimeType, `${path}.mimeType`),
    size: requireNumber(obj.size, `${path}.size`),
    data: requireString(obj.data, `${path}.data`),
  };
}

function validateHistoryEntry(value: unknown, path: string): ItemHistoryEntry {
  const obj = requireObject(value, path);
  const fields = requireArray(obj.fields, `${path}.fields`).map((entry, i) => {
    const fieldObj = requireObject(entry, `${path}.fields[${i}]`);
    return {
      name: requireString(fieldObj.name, `${path}.fields[${i}].name`),
      value: requireString(fieldObj.value, `${path}.fields[${i}].value`),
    };
  });
  return { fields, changedAt: requireString(obj.changedAt, `${path}.changedAt`) };
}

/** Разобрать и проверить одну запись. Бросает `ImportValidationError` с
 * путём до первого несовпавшего поля (`items[2].fields[0].secret: expected
 * a boolean` и т.п.) - это техническое сообщение для лога/отчёта, конечный
 * текст для пользователя формирует `ImportExportPanel.tsx` по R85 (что
 * случилось - "файл повреждён или не в нужном формате", без пересказа пути
 * до поля). */
function validateItem(value: unknown, index: number): Item {
  const path = `items[${index}]`;
  const obj = requireObject(value, path);

  const type = requireString(obj.type, `${path}.type`);
  if (!VALID_ITEM_TYPES.has(type)) {
    throw new ImportValidationError(
      `${path}.type: unknown item type "${type}" (expected one of login/note/card/key/other)`,
    );
  }

  const item: Item = {
    id: requireString(obj.id, `${path}.id`),
    type: type as ItemType,
    title: requireString(obj.title, `${path}.title`),
    tags: validateStringArray(obj.tags, `${path}.tags`),
    fields: requireArray(obj.fields, `${path}.fields`).map((entry, i) =>
      validateField(entry, `${path}.fields[${i}]`),
    ),
    note: requireString(obj.note, `${path}.note`),
    attachments: requireArray(obj.attachments, `${path}.attachments`).map((entry, i) =>
      validateAttachment(entry, `${path}.attachments[${i}]`),
    ),
    createdAt: requireString(obj.createdAt, `${path}.createdAt`),
    updatedAt: requireString(obj.updatedAt, `${path}.updatedAt`),
  };

  if (obj.history !== undefined) {
    item.history = requireArray(obj.history, `${path}.history`).map((entry, i) =>
      validateHistoryEntry(entry, `${path}.history[${i}]`),
    );
  }

  return item;
}

/**
 * Разобрать текст файла импорта в `Item[]` (R100). Бросает
 * `ImportValidationError` целиком на:
 * - невалидный JSON;
 * - JSON, чей верхний уровень не массив;
 * - любую запись массива с отсутствующим/неверно типизированным
 *   обязательным полем или неизвестным `type`.
 *
 * Ничего не применяется частично (R100.1): функция либо строит и
 * возвращает полностью валидный массив (каждый элемент прошёл
 * `validateItem`), либо не возвращает ничего, бросая на первом же
 * несовпадении - частичного успеха структурно не существует, вызывающему
 * коду (`ImportExportPanel.tsx`) нечего "откатывать" в `VaultStore`, потому
 * что до вызова `store`-мутации дело не доходит вообще.
 */
export function parseImportFile(text: string): Item[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ImportValidationError("Import file is not valid JSON");
  }
  const arr = requireArray(parsed, "root");
  return arr.map((entry, index) => validateItem(entry, index));
}

/**
 * Сериализовать записи в открытый (нешифрованный) JSON для экспорта (R100).
 * `null, 2` - с отступами, чтобы файл действительно читался в обычном
 * текстовом редакторе, а не превращался в одну нечитаемую строку (критерий
 * приёмки тикета 10 - "экспорт создаёт JSON, который открывается и
 * читается обычным текстовым редактором").
 */
export function serializeExport(items: Item[]): string {
  return JSON.stringify(items, null, 2);
}

/** `YYYY-MM-DD-HHmmss` из локального времени машины пользователя - тот же
 * формат и то же намеренное решение "локальное время, не UTC", что и у
 * `formatBackupTimestamp` в `vaultStore.ts` (см. его комментарий: копия
 * пользователя видит "недавние" файлы в порядке, совпадающем с часами на
 * этой же машине). Не импортируется оттуда - `formatBackupTimestamp` не
 * экспортирован из `vaultStore.ts`, и в проекте уже есть прецедент (тикет
 * 02/05: `base64ToBytes`/`bytesToBase64` продублированы в `crypto.ts`,
 * `vaultFormat.ts` и `vaultStore.ts` вместо общего приватного хелпера) -
 * каждый модуль держит свою маленькую копию таких утилит, не тянет чужие
 * приватные функции через границу модуля. */
function formatTimestampForFilename(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/**
 * Имя файла по умолчанию для «Сохранить копию» (R99) - с датой, как просит
 * бриф дословно. Префикс `vault-copy-` (не `vault-`) - намеренно другой,
 * чем у автоматических бэкапов ротации (`vault-<дата>.dat`,
 * `BACKUP_FILENAME_RE` в `vaultStore.ts`): если пользователь сохранит копию
 * прямо в каталог `backups/` через диалог выбора места, файл не должен
 * случайно совпасть с шаблоном имени автоматических бэкапов и попасть в их
 * подсчёт/фильтр (тикет прямо требует - "не считается в лимит 20 штук").
 */
export function buildManualCopyFilename(date: Date): string {
  return `vault-copy-${formatTimestampForFilename(date)}.dat`;
}

/** Имя файла по умолчанию для экспорта (R100) - тоже с датой, для
 * единообразия с «Сохранить копию» и чтобы несколько экспортов подряд не
 * затирали друг друга молча при сохранении в одну и ту же папку. */
export function buildExportFilename(date: Date): string {
  return `vault-export-${formatTimestampForFilename(date)}.json`;
}

/**
 * Текст второго подтверждения импорта (R100, дословно из брифа и
 * spec.md §12: «Заменить N записей текущей базы на M из файла?»). Первое
 * подтверждение - сам выбор файла в системном диалоге (spec.md §12: "выбор
 * файла - уже первое действие"), эта строка - второе, явное.
 */
export function buildReplaceConfirmationMessage(currentCount: number, importCount: number): string {
  return `Заменить ${currentCount} записей текущей базы на ${importCount} из файла?`;
}
