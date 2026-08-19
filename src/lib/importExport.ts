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

import type { Attachment, Item, ItemField, ItemHistoryEntry, ItemType, NewItemInput } from "./vaultStore";

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

/**
 * Импорт паролей из CSV (19.08.2026) - совсем другая операция, чем «Импорт»
 * выше: тот ЗАМЕНЯЕТ всю базу файлом собственного экспорта Vault
 * (`replaceAllItems`), этот ДОБАВЛЯЕТ записи к уже существующим
 * (`store.addItem` в `ImportExportPanel.tsx`) из файла постороннего формата -
 * `name,url,username,password,note`, ровно то, что отдаёт экспорт паролей
 * Chrome/Google Password Manager. Формат `vault.dat` не меняется вовсе -
 * результат разбора такой же `Item`-подобный ввод, каким его сам пользователь
 * мог бы создать руками в редакторе.
 */
export class CsvImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvImportError";
  }
}

/** Имя поля, в которое попадает колонка `url` при импорте. Открывашка ссылки
 * в карточке записи (`isOpenableUrl` в `openExternal.ts`) работает по ВИДУ
 * значения, не по имени поля - специального служебного имени заводить не
 * нужно, это просто подпись для человека. */
export const CSV_URL_FIELD_NAME = "Сайт";
export const CSV_LOGIN_FIELD_NAME = "Логин";
export const CSV_PASSWORD_FIELD_NAME = "Пароль";

/**
 * Разобрать текст в строки таблицы (RFC 4180: поля в кавычках могут
 * содержать запятые, переводы строк и экранированные кавычки `""`).
 * Ручной разбор вместо библиотеки (R31 - новая зависимость отдельным
 * вопросом) - формат самого CSV простой и стабильный, `split(",")` был бы
 * недостаточен только из-за кавычек, которые Chrome ставит вокруг значений
 * с запятой внутри (например, в поле `note`).
 */
function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const len = text.length;

  while (i < len) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i++;
        continue;
      }
      field += c;
      i++;
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      i++;
      continue;
    }
    if (c === ",") {
      row.push(field);
      field = "";
      i++;
      continue;
    }
    if (c === "\r") {
      i++; // "\r\n" - сам перевод строки завершает строку по "\n" ниже
      continue;
    }
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i++;
      continue;
    }
    field += c;
    i++;
  }
  // Последняя строка файла может не заканчиваться переводом строки.
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  // Полностью пустые строки (пустая строка файла между записями) - не
  // данные, а разделитель визуального восприятия, пропускаем их здесь же,
  // чтобы дальше по коду не проверять этот случай отдельно.
  return rows.filter((r) => !(r.length === 1 && r[0].trim() === ""));
}

/**
 * Разобрать CSV-экспорт паролей Chrome/Google Password Manager в записи для
 * добавления в базу. Порядок колонок берётся из строки заголовка (первая
 * строка файла), а не жёстко зашит - так надёжнее переживёт мелкие различия
 * между версиями экспортёра, чем предположение "ровно этот порядок".
 *
 * `name`/`url`/`username`/`password` обязательны (без них это не похоже на
 * этот формат вообще - `CsvImportError` целиком, ничего не возвращается
 * частично, тот же принцип R100.1, что у `parseImportFile`). `note`
 * необязательна - часть реальных экспортов Chrome её не содержит.
 *
 * Ведущий BOM (Chrome кладёт его в начало CSV-экспорта) снимается явно, а не
 * в расчёте на поведение `TextDecoder` по умолчанию - здесь это не должно
 * зависеть от того, вызывающий код передал `ignoreBOM` или нет.
 */
export function parseCsvPasswordImport(text: string): NewItemInput[] {
  const withoutBom = text.startsWith("﻿") ? text.slice(1) : text;
  const rows = parseCsvRows(withoutBom);
  if (rows.length === 0) {
    throw new CsvImportError("Файл пуст");
  }

  const header = rows[0].map((h) => h.trim().toLowerCase());
  const columnIndex = (name: string) => header.indexOf(name);
  const nameIdx = columnIndex("name");
  const urlIdx = columnIndex("url");
  const usernameIdx = columnIndex("username");
  const passwordIdx = columnIndex("password");
  const noteIdx = columnIndex("note");

  if (nameIdx === -1 || urlIdx === -1 || usernameIdx === -1 || passwordIdx === -1) {
    throw new CsvImportError(
      'Не похоже на экспорт паролей Chrome/Google: в заголовке файла нет колонок "name", "url", "username", "password"',
    );
  }

  const dataRows = rows.slice(1);
  return dataRows.map((cells, index) => {
    const cell = (colIdx: number) => (colIdx === -1 ? "" : (cells[colIdx] ?? "").trim());
    const name = cell(nameIdx);
    const url = cell(urlIdx);
    const username = cell(usernameIdx);
    const password = cell(passwordIdx);
    const note = cell(noteIdx);
    const title = name !== "" ? name : url !== "" ? url : `Импортированная запись ${index + 1}`;

    const fields: ItemField[] = [];
    if (url !== "") fields.push({ name: CSV_URL_FIELD_NAME, value: url, secret: false });
    fields.push({ name: CSV_LOGIN_FIELD_NAME, value: username, secret: false });
    fields.push({ name: CSV_PASSWORD_FIELD_NAME, value: password, secret: true });

    return { type: "login", title, fields, note } satisfies NewItemInput;
  });
}

/**
 * Отделить новые записи от похожих на уже существующие в базе (19.08.2026) -
 * молчаливое дублирование при повторном импорте того же файла (или его
 * пересечения с уже внесёнными вручную записями) не было бы замечено, пока
 * список не разросся бы вдвое.
 *
 * Совпадением считается ЛИБО название (без учёта регистра, целиком - не
 * похожесть), ЛИБО адрес сайта, если он есть у обеих сторон - сверка
 * поверхностная, не пытается угадывать "это тот же сервис", только ловит
 * буквальные повторы. Дубликаты не возвращаются вовсе - вызывающий код
 * (`ImportExportPanel.tsx`) показывает только их количество.
 */
export function splitCsvImportDuplicates(
  candidates: NewItemInput[],
  existing: Item[],
): { toAdd: NewItemInput[]; duplicateCount: number } {
  const norm = (s: string) => s.trim().toLowerCase();
  const existingTitles = new Set(existing.map((item) => norm(item.title)).filter((t) => t !== ""));
  const existingUrls = new Set(
    existing
      .flatMap((item) => item.fields.filter((f) => !f.secret).map((f) => norm(f.value)))
      .filter((v) => v !== ""),
  );

  const toAdd: NewItemInput[] = [];
  let duplicateCount = 0;
  for (const candidate of candidates) {
    const url = candidate.fields?.find((f) => f.name === CSV_URL_FIELD_NAME)?.value ?? "";
    const isDuplicate = existingTitles.has(norm(candidate.title)) || (url !== "" && existingUrls.has(norm(url)));
    if (isDuplicate) {
      duplicateCount++;
      continue;
    }
    toAdd.push(candidate);
  }
  return { toAdd, duplicateCount };
}

/**
 * Текст подтверждения перед добавлением CSV-импорта (тот же принцип, что у
 * `buildReplaceConfirmationMessage` - явное число, никаких "несколько
 * записей"). Дубликаты называются отдельной фразой, только если они есть -
 * пустая база или файл без пересечений не должны читать про "0 похожих".
 */
export function buildCsvImportConfirmationMessage(toAddCount: number, duplicateCount: number): string {
  const base = `Добавить ${toAddCount} записей из файла?`;
  if (duplicateCount === 0) return base;
  return `${base} Ещё ${duplicateCount} похожи на уже существующие записи и будут пропущены.`;
}
