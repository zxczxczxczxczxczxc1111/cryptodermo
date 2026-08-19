/**
 * Хранилище расшифрованной коллекции записей (`vault-store` из interfaces.md).
 *
 * Единственное место в приложении, которое держит `Item[]` в открытом виде в
 * памяти и знает, как превратить их в байты `vault.dat` и обратно. Не знает
 * про UI (экраны строят тикеты 06/07) и не занимается собственно шифрованием
 * или разбором контейнера - это `crypto.ts` и `vaultFormat.ts`, этот модуль
 * только использует их публичные сигнатуры.
 *
 * Один экземпляр `VaultStore` живёт на всё время работы с одной базой:
 * сначала `new VaultStore()` (пустое, ничего не загружено), затем ровно один
 * раз `createNewVault()` (новая база) или `loadFromBytes()` (открыть
 * существующую) - после этого доступны `addItem`/`updateItem`/`deleteItem`/
 * `search`/`isDirty`/`toBytes`/`save`. Повторный вызов `loadFromBytes()` на
 * уже загруженном сторе допустим и используется путём восстановления после
 * повреждения (R114i, см. `loadFromBackupFile` ниже) - он просто заменяет
 * текущее состояние.
 */

import { deriveKey, encrypt, decrypt, DEFAULT_ITERATIONS } from "./crypto";
import { base64ToBytes, bytesToBase64 } from "./base64";
import {
  serializeContainer,
  parseContainer,
  FormatError,
  type VaultHeader,
} from "./vaultFormat";
import {
  readVault,
  writeVaultAtomic,
  listBackups,
  rotateBackups,
  type BackupInfo,
} from "./tauriApi";

// Текст скрипта аварийного дешифратора, его обязательного соседа
// `aes_gcm.py` (собственная реализация AES/GCM на чистом Python, без
// которой emergency-decrypt.py не может расшифровать тело - см. импорт в
// начале emergency-decrypt.py) и батника-обёртки `emergency-decrypt.bat`
// (для тех, кто не хочет открывать командную строку - сам не расшифровывает
// ничего, только находит Python и зовёт emergency-decrypt.py) берётся из
// самих файлов в корне репозитория через собственную возможность Vite
// (суффикс `?raw` даёт содержимое файла как строку на этапе сборки - см.
// `vite/client.d.ts`, `declare module '*?raw'`). Это не новая зависимость
// (Vite уже в проекте) и не дублирование кода вручную: копии, которые
// ложатся рядом с `vault.dat` и в `backups/` (см. `save()` ниже),
// гарантированно совпадают с реальными файлами из репозитория, потому что
// это буквально те же файлы, а не переписанные вручную строки, которые
// могли бы разойтись с оригиналом при следующем изменении скриптов. Все три
// файла нужны вместе - копия `emergency-decrypt.py` без `aes_gcm.py` рядом
// бесполезна (первый откажет с понятной ошибкой), а `.bat` без обоих ничего
// не находит, поэтому пишутся все три разом, никогда по отдельности.
import emergencyScriptSource from "../../emergency-decrypt.py?raw";
import aesGcmScriptSource from "../../aes_gcm.py?raw";
import emergencyBatSource from "../../emergency-decrypt.bat?raw";

/** Тип записи (R43). */
export type ItemType = "login" | "note" | "card" | "key" | "other";

/** Одно поле записи. `secret: true` - значение прячется по умолчанию в UI и
 * никогда не попадает в индекс поиска (см. `search()` ниже). */
export type ItemField = {
  name: string;
  value: string;
  secret: boolean;
  /**
   * Аккаунт внутри записи (17.08.2026).
   *
   * В одной записи часто живут несколько учёток одного сервиса: три почты
   * gmail, у каждой свой логин, пароль и код двухфакторки. Поля с одинаковым
   * `group` образуют один блок, поля без `group` относятся ко всей записи.
   *
   * Необязательное, как и `pinned`: старые базы его не содержат, и отсутствие
   * читается как «поле общее». Миграции не нужно.
   */
  group?: string;
};

/** Вложение файла (R44, §18 спецификации). Само UI прикрепления файлов
 * строит тикет 11 - здесь только форма поля, зарезервированная в модели. */
export type Attachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  /** Содержимое файла, base64. */
  data: string;
};

/** Один снимок истории изменения секретных полей (R45). Снимок хранит
 * СТАРЫЕ значения полей, которые изменились - не полную копию записи. */
export type ItemHistoryEntry = {
  fields: { name: string; value: string }[];
  changedAt: string; // ISO8601
};

/** Модель записи - см. spec.md §3, дословно повторено в FORMAT.md §6. */
export type Item = {
  id: string;
  type: ItemType;
  title: string;
  tags: string[];
  fields: ItemField[];
  note: string;
  attachments: Attachment[];
  createdAt: string; // ISO8601
  updatedAt: string; // ISO8601
  history?: ItemHistoryEntry[];
  /**
   * Запись закреплена наверху списка (17.08.2026).
   *
   * Поле НЕобязательное, и это существенно: базы, созданные до появления
   * избранного, его не содержат, а разбор не строгий - отсутствие читается как
   * «не закреплена». Поэтому миграции не нужно, старый файл открывается новой
   * версией и наоборот.
   */
  pinned?: boolean;
};

/** Данные для создания новой записи - всё, что не может выставить сам
 * вызывающий код (`id`, `createdAt`, `updatedAt`, `history`), генерирует
 * `addItem`. */
export type NewItemInput = {
  type: ItemType;
  title: string;
  tags?: string[];
  fields?: ItemField[];
  note?: string;
  attachments?: Attachment[];
  pinned?: boolean;
};

/** Поля записи, которые можно изменить через `updateItem` - `id`, `createdAt`
 * и `history` вычисляются/сохраняются самим стором, снаружи не задаются. */
export type ItemPatch = Partial<{
  type: ItemType;
  title: string;
  tags: string[];
  fields: ItemField[];
  note: string;
  attachments: Attachment[];
}>;

/** Сравнение для порядка в списке - см. комментарий у `search`. */
function compareForList(a: Item, b: Item): number {
  const pinDiff = Number(b.pinned ?? false) - Number(a.pinned ?? false);
  if (pinDiff !== 0) return pinDiff;
  return b.updatedAt.localeCompare(a.updatedAt);
}

/** Запись с данным `id` не найдена в текущей коллекции. */
export class ItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Item not found: ${id}`);
    this.name = "ItemNotFoundError";
  }
}

/** Метод стора вызван до `loadFromBytes`/`createNewVault` - в сторе ещё нет
 * ни ключа, ни коллекции, работать не с чем. */
export class VaultNotLoadedError extends Error {
  constructor() {
    super("VaultStore: no vault loaded - call loadFromBytes() or createNewVault() first");
    this.name = "VaultNotLoadedError";
  }
}

/**
 * R28: число записей уменьшилось относительно последней успешной загрузки
 * (`loadFromBytes`/`createNewVault`, включая повторный вызов при
 * восстановлении из бэкапа) - `save()` отказывается писать на диск, не
 * спросив явного подтверждения (`opts.allowCountDecrease`), чтобы случайное
 * массовое удаление (или баг где-то выше по стеку) не могло молча
 * перезаписать боевой файл усечённой коллекцией. UI (диалог «было N,
 * стало M», тикет 06/07/08 - не этот модуль) читает `loaded`/`current` для
 * текста диалога и, если пользователь подтвердил, вызывает `save()` ещё раз
 * с `{ allowCountDecrease: true }`.
 */
export class ItemCountDecreasedError extends Error {
  /** Число записей на момент последней успешной загрузки. */
  readonly loaded: number;
  /** Текущее число записей в сторе (то, что попыталось сохраниться). */
  readonly current: number;

  constructor(loaded: number, current: number) {
    super(
      `Item count decreased since last load: was ${loaded}, now ${current} - ` +
        `call save() again with { allowCountDecrease: true } to confirm`,
    );
    this.name = "ItemCountDecreasedError";
    this.loaded = loaded;
    this.current = current;
  }
}

/** Сколько последних резервных копий хранится (R23, R46, дословно из
 * брифа - "последние N штук (20)"). */
export const MAX_BACKUPS = 20;

/** Мягкий предел размера ОДНОГО вложения (R44.3, §18 спецификации) -
 * "мягкий, не жёсткий": превышение только предупреждает в интерфейсе
 * (`Editor.tsx`, `buildAttachmentSizeWarning`), никогда не блокирует
 * `addItem`/`updateItem`/`save()` - приоритет 1 ("данные не теряются")
 * выше приоритета 4 ("удобство"), дословно из §18. Стартовая константа, не
 * факт из брифа - craft-решение этого тикета, вынесено отдельной
 * именованной константой, чтобы её было легко подвинуть, если окажется
 * неудобной на практике (тот же приём, что и `MAX_BACKUPS` выше). */
export const MAX_ATTACHMENT_SIZE_BYTES = 25 * 1024 * 1024; // ~25 МБ

/** Мягкий предел суммарного (примерного, см. `estimateSizeBytes` ниже)
 * размера ТЕЛА базы (R44.3, §18) - тот же принцип и то же происхождение,
 * что у `MAX_ATTACHMENT_SIZE_BYTES` выше. */
export const MAX_VAULT_SIZE_BYTES = 300 * 1024 * 1024; // ~300 МБ

/**
 * Поверхностная проверка формы одной записи после расшифровки (19.08.2026,
 * найдено внешним ревью): `Array.isArray(parsed)` в `applyDecryptedVault`
 * уже гарантирует, что тело - массив, но не гарантирует, что КАЖДЫЙ элемент
 * похож на `Item`. Расшифровка, прошедшая тег AES-GCM, аутентична (байты не
 * подменены), так что это не защита от атакующего - это защита от бага
 * прошлой версии приложения, который мог бы записать что-то не той формы:
 * лучше явный `FormatError` сейчас, чем `TypeError` где-то внутри `search()`
 * или `RecordCard.tsx` при первом обращении к `fields`.
 *
 * Намеренно ПОВЕРХНОСТНАЯ - не полная схема `Item`: проверяются только два
 * поля, без которых стор реально падает (`id` как ключ операций,
 * `fields` как массив, по которому итерируются все экраны). Остальные поля
 * (`title`, `tags`, `note` и т.д.) при отсутствии дают пустую строку/массив
 * через `??`/`||` там, где их читают, и не роняют приложение.
 */
export function isValidItemShape(value: unknown): value is Item {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return typeof obj.id === "string" && Array.isArray(obj.fields);
}

/** Параметры KDF/шифра, зафиксированные для конкретной открытой/созданной
 * базы - всё, что нужно `toBytes()`, кроме самого `iv` (он новый на каждое
 * сохранение, см. `crypto.ts`). Соль и алгоритмы не меняются, пока не сменят
 * мастер-пароль (это делает будущий тикет настроек, не этот модуль). */
type KdfInfo = {
  formatVersion: number;
  alg: string;
  saltBase64: string;
  iterations: number;
  cipher: string;
};

/** Каталог файла из полного пути. Понимает и `/`, и `\` - база может лежать
 * на Windows-пути с обратными слэшами. Возвращает `.`, если разделителя нет
 * (путь - просто имя файла в текущем каталоге). */
function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? "." : path.slice(0, idx);
}

/** Склеить каталог и имя файла тем же разделителем, что уже используется в
 * каталоге (обратные слэши для Windows-пути, иначе прямые). */
function joinPath(dir: string, filename: string): string {
  if (dir === "" || dir === ".") return filename;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${filename}` : `${dir}${sep}${filename}`;
}

/** Каталог бэкапов для данного пути к базе - всегда `<каталог базы>/backups`
 * (дословно из брифа). */
function backupsDirFor(vaultPath: string): string {
  return joinPath(dirOf(vaultPath), "backups");
}

/** Имя файла бэкапа по моменту сохранения - `vault-YYYY-MM-DD-HHmmss.dat`,
 * ровно формат из брифа. Локальное время машины пользователя (не UTC) -
 * пользователь смотрит на список бэкапов на этой же машине и ожидает видеть
 * "недавние" файлы в порядке, который совпадает с его собственными часами.
 * Секундная точность означает, что два сохранения в одну и ту же секунду
 * дадут одно и то же имя файла (второе перезапишет первое как бэкап) - это
 * принятый компромисс, не баг: в такой ситуации предыдущая версия всё равно
 * не теряется навсегда, теряется только промежуточный шаг между двумя
 * сохранениями за одну секунду.
 */
function formatBackupTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Имя файла бэкапа этого приложения: `vault-<дата>.dat`. Используется и при
 * создании (см. `save()`), и при фильтрации списка бэкапов для UI (см.
 * `listBackupsForRecovery()`) - каталог `backups/` может содержать не только
 * такие файлы (например, копию `emergency-decrypt.py`, см. `save()`), это
 * регулярное выражение отделяет одно от другого. */
const BACKUP_FILENAME_RE = /^vault-\d{4}-\d{2}-\d{2}-\d{6}\.dat$/;

export class VaultStore {
  private items: Item[] = [];
  private key: CryptoKey | null = null;
  private kdfInfo: KdfInfo | null = null;
  private dirty = false;
  /**
   * Число записей на момент последней успешной загрузки (R28, §9 - "база
   * сравнения - при последней успешной загрузке", не момент открытия
   * какого-то экрана и не исходная загрузка при старте сессии). `null` до
   * первого `loadFromBytes`/`createNewVault`. Выставляется этими двумя
   * методами и обновляется каждым успешным `save()` - так следующее
   * сравнение идёт от точки последнего сохранения/загрузки, а не бесконечно
   * от самой первой загрузки за сессию.
   */
  private loadedCount: number | null = null;

  /** Есть ли в сторе несохранённые изменения (флаг из interfaces.md). Ложь
   * сразу после `loadFromBytes`/`createNewVault`/успешного `save()`. */
  isDirty(): boolean {
    return this.dirty;
  }

  /** Бросить понятную ошибку, если ни одна из `loadFromBytes`/`createNewVault`
   * ещё не была вызвана - остальные методы без загруженного стора работать
   * не могут (не с чем: нет ни ключа, ни коллекции). Методам, которым нужны
   * сами `key`/`kdfInfo` типизированно (без `null` в типе), нужен
   * `getLoaded()` ниже - TypeScript не сужает тип поля класса через отдельный
   * вызов void-метода, поэтому здесь только рантайм-проверка. */
  private assertLoaded(): void {
    if (this.key === null || this.kdfInfo === null) {
      throw new VaultNotLoadedError();
    }
  }

  /** То же самое, что `assertLoaded()`, но дополнительно возвращает `key` и
   * `kdfInfo` уже сужен­ными до не-`null` типов - используется там, где эти
   * значения нужны напрямую (`toBytes()`). */
  private getLoaded(): { key: CryptoKey; kdfInfo: KdfInfo } {
    if (this.key === null || this.kdfInfo === null) {
      throw new VaultNotLoadedError();
    }
    return { key: this.key, kdfInfo: this.kdfInfo };
  }

  /**
   * Создать новую пустую базу с указанным мастер-паролем: свежая случайная
   * соль (16 байт - см. FORMAT.md §2, не меньше рекомендации NIST), ключ
   * через `deriveKey`, пустая коллекция записей. Число итераций по умолчанию
   * - `DEFAULT_ITERATIONS` из `crypto.ts`; вызывающий код (экран создания
   * базы, тикет 06) может передать другое значение, если предварительно
   * замерил машину пользователя через `benchmarkIterations` - это его
   * забота, не этого модуля.
   */
  async createNewVault(password: string, iterations: number = DEFAULT_ITERATIONS): Promise<void> {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const key = await deriveKey(password, salt, iterations);

    this.items = [];
    this.key = key;
    this.kdfInfo = {
      formatVersion: 1,
      alg: "PBKDF2-SHA256",
      saltBase64: bytesToBase64(salt),
      iterations,
      cipher: "AES-256-GCM",
    };
    this.dirty = false;
    this.loadedCount = this.items.length;
  }

  /**
   * Открыть существующую базу: разобрать контейнер (`parseContainer`,
   * бросает `FormatError` на неизвестной версии/битой структуре),
   * вывести ключ из пароля и параметров заголовка, расшифровать тело
   * (`decrypt`, бросает `DecryptError` на неверном пароле или повреждённых
   * данных - различить эти два случая невозможно, см. `crypto.ts`).
   *
   * Можно вызывать повторно на уже загруженном сторе - тогда предыдущее
   * состояние просто заменяется новым. Это используется путём восстановления
   * из бэкапа (`loadFromBackupFile` ниже): если основной файл повреждён,
   * UI вызывает `loadFromBytes` ещё раз с байтами валидного бэкапа.
   */
  async loadFromBytes(bytes: Uint8Array, password: string): Promise<void> {
    const { header, ciphertext } = parseContainer(bytes);
    const salt = base64ToBytes(header.kdf.salt);
    const key = await deriveKey(password, salt, header.kdf.params.iterations);
    const iv = base64ToBytes(header.iv);
    const plaintext = await decrypt(key, iv, ciphertext); // кидает DecryptError
    this.applyDecryptedVault(header, key, plaintext);
  }

  /**
   * Открыть базу по СЫРОМУ ключу шифрования (не по паролю) - используется
   * разблокировкой по PIN (тикет PIN-кода): `unwrapVaultKeyWithPin` из
   * `pinLock.ts` возвращает те же 256 бит, что и реальный ключ базы,
   * восстановленные PIN-обёрткой. Импортирует `rawKeyBits` как
   * non-extractable AES-256-GCM `CryptoKey` (тот же принцип R34, что у
   * `deriveKey` в `crypto.ts` - извлекаемость не нужна и здесь), дальше идёт
   * тем же путём, что и `loadFromBytes`: разбор контейнера, расшифровка
   * (переиспользует `decrypt` из `crypto.ts` - если ключ не подходит, тот же
   * `DecryptError`, что и при неверном мастер-пароле; вызывающий код
   * (`LockScreen.tsx`) ловит его как "хранилище повреждено или ключ из PIN
   * устарел" - неразличимые на этом уровне случаи, тот же принцип R94.1),
   * общий с `loadFromBytes` хвост - `applyDecryptedVault` ниже.
   *
   * Не трогает и не меняет поведение `loadFromBytes` - оба метода независимо
   * ведут к одному и тому же общему хвосту, различаясь только тем, откуда
   * берётся `key` (деривация из пароля vs импорт сырых байт).
   */
  async loadFromBytesWithRawKey(fileBytes: Uint8Array, rawKeyBits: Uint8Array): Promise<void> {
    const { header, ciphertext } = parseContainer(fileBytes);
    const key = await crypto.subtle.importKey(
      "raw",
      rawKeyBits as BufferSource,
      { name: "AES-GCM", length: 256 },
      // extractable: false - см. комментарий модуля crypto.ts и R34.
      false,
      ["encrypt", "decrypt"],
    );
    const iv = base64ToBytes(header.iv);
    const plaintext = await decrypt(key, iv, ciphertext); // кидает DecryptError
    this.applyDecryptedVault(header, key, plaintext);
  }

  /**
   * Общий хвост `loadFromBytes`/`loadFromBytesWithRawKey`: разобрать
   * расшифрованное тело как JSON-массив записей и применить полученные
   * `key`/`kdfInfo` к стору. Оба метода отличаются только тем, ОТКУДА берётся
   * уже готовый `key` (деривация из пароля vs импорт сырых байт от
   * PIN-обёртки) - вся дальнейшая логика идентична, вынесена сюда, чтобы не
   * дублироваться между ними.
   */
  private applyDecryptedVault(header: VaultHeader, key: CryptoKey, plaintext: Uint8Array): void {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(plaintext);
    } catch {
      throw new FormatError("Vault body is not valid UTF-8 text after decryption");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new FormatError("Vault body is not valid JSON after decryption");
    }
    if (!Array.isArray(parsed)) {
      throw new FormatError("Vault body must be a JSON array of items");
    }
    const badIndex = parsed.findIndex((entry) => !isValidItemShape(entry));
    if (badIndex !== -1) {
      throw new FormatError(
        `Vault body item at index ${badIndex} is malformed: missing "id" (string) or "fields" (array)`,
      );
    }

    this.items = parsed as Item[];
    this.key = key;
    this.kdfInfo = {
      formatVersion: header.v,
      alg: header.kdf.alg,
      saltBase64: header.kdf.salt,
      iterations: header.kdf.params.iterations,
      cipher: header.cipher,
    };
    this.dirty = false;
    this.loadedCount = this.items.length;
  }

  /**
   * Сериализовать текущую коллекцию в байты `vault.dat`: JSON текущих
   * `items` -> шифрование (`encrypt`, новый случайный `iv` на каждый вызов -
   * это делает сам `crypto.ts`) -> контейнер (`serializeContainer`). Не
   * трогает диск и не сбрасывает `isDirty` - это чистая сериализация,
   * используется и оркестрацией `save()` ниже, и (в будущих тикетах) ручным
   * экспортом/копией "Сохранить копию как".
   */
  async toBytes(): Promise<Uint8Array> {
    const { key, kdfInfo } = this.getLoaded();
    const plaintext = new TextEncoder().encode(JSON.stringify(this.items));
    const { iv, ciphertext } = await encrypt(key, plaintext);
    const header: VaultHeader = {
      v: kdfInfo.formatVersion,
      kdf: {
        alg: kdfInfo.alg,
        params: { iterations: kdfInfo.iterations },
        salt: kdfInfo.saltBase64,
      },
      cipher: kdfInfo.cipher,
      iv: bytesToBase64(iv),
    };
    return serializeContainer(header, ciphertext);
  }

  /**
   * Примерный размер тела базы в байтах ДО шифрования - UTF-8 байты
   * `JSON.stringify(this.items)`, то же самое, что кодирует `toBytes()`
   * перед `encrypt()` (см. выше). Только для мягкого предупреждения о
   * размере (R44.3, §18 - `MAX_ATTACHMENT_SIZE_BYTES`/`MAX_VAULT_SIZE_BYTES`
   * выше) - НЕ точный размер итогового `vault.dat` на диске: реальный файл
   * крупнее из-за base64-раздутия шифротекста (~4/3) и заголовка контейнера,
   * но для предупреждения "база становится большой" точность до процента не
   * нужна, а дешёвый синхронный способ (без реального `toBytes()`/
   * шифрования при каждом добавлении вложения) важнее.
   */
  estimateSizeBytes(): number {
    this.assertLoaded();
    return new TextEncoder().encode(JSON.stringify(this.items)).length;
  }

  /**
   * Список записей, отфильтрованных по подстроке `query` (без учёта
   * регистра) в `title`, `tags`, значениях полей с `secret: false` и именах
   * вложений (R96, расширение на вложения - §18 спецификации: "естественное
   * продолжение поиска по названию/тегам/полям, не отдельная функция").
   * Значения полей с `secret: true` никогда не участвуют в сравнении - это
   * и есть исключение секретных полей из индекса поиска, за которое отвечает
   * этот модуль (interfaces.md).
   *
   * Пустая строка (после `trim()`) возвращает все записи - так экран списка
   * (тикет 07) получает полный список тем же вызовом, без отдельного метода.
   * Результат отсортирован по `updatedAt` по убыванию (недавно изменённые
   * первыми, как того просит spec.md §9) и это копии записей
   * (`structuredClone`), а не ссылки на внутреннее состояние - изменение
   * возвращённого объекта не обходит `updateItem`/флаг `isDirty`.
   */
  /**
   * Порядок записей в списке: закреплённые сверху, внутри каждой группы -
   * недавно изменённые первыми.
   *
   * Закрепление намеренно НЕ считается изменением записи и не двигает
   * `updatedAt`: иначе звёздочка перемешивала бы порядок остальных, и человек
   * терял бы из виду то, над чем работал минуту назад.
   */
  search(query: string): Item[] {
    this.assertLoaded();
    const q = query.trim().toLowerCase();
    const matches = (item: Item): boolean => {
      if (q === "") return true;
      if (item.title.toLowerCase().includes(q)) return true;
      if (item.tags.some((tag) => tag.toLowerCase().includes(q))) return true;
      if (
        item.fields.some((field) => !field.secret && field.value.toLowerCase().includes(q))
      ) {
        return true;
      }
      if (item.attachments.some((att) => att.name.toLowerCase().includes(q))) return true;
      return false;
    };

    return this.items
      .filter(matches)
      .slice()
      .sort(compareForList)
      .map((item) => structuredClone(item));
  }

  /** Создать новую запись. Генерирует `id` (`crypto.randomUUID()`),
   * `createdAt`/`updatedAt` (текущий момент, ISO8601), помечает стор
   * несохранённым. Возвращает копию созданной записи. */
  addItem(input: NewItemInput): Item {
    this.assertLoaded();
    const now = new Date().toISOString();
    const item: Item = {
      id: crypto.randomUUID(),
      type: input.type,
      title: input.title,
      tags: input.tags ?? [],
      fields: input.fields ?? [],
      note: input.note ?? "",
      attachments: input.attachments ?? [],
      createdAt: now,
      updatedAt: now,
      // Отсутствие поля вместо `false` - см. `setPinned`: база без избранного
      // не должна отличаться от базы прежней версии.
      ...(input.pinned ? { pinned: true } : {}),
    };
    this.items.push(structuredClone(item));
    this.dirty = true;
    return structuredClone(item);
  }

  /**
   * Изменить существующую запись. `id`, `createdAt` не меняются;
   * `updatedAt` обновляется на текущий момент. Если патч включает `fields`
   * и среди изменившихся полей есть поля с `secret: true` (значение стало
   * другим или поле пропало из нового набора), их СТАРЫЕ значения уходят в
   * новую запись `history` (R45) - история хранит только то, что реально
   * изменилось у секретных полей, не полный снимок записи и не изменения
   * несекретных полей (§9: возраст точки-статуса считается по последней
   * записи `history` для конкретного поля).
   *
   * Бросает `ItemNotFoundError`, если записи с таким `id` нет.
   */
  updateItem(id: string, patch: ItemPatch): Item {
    this.assertLoaded();
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx === -1) throw new ItemNotFoundError(id);
    const existing = this.items[idx];
    const now = new Date().toISOString();

    let history = existing.history;
    if (patch.fields) {
      const changedSecretFields = existing.fields
        .filter((oldField) => oldField.secret)
        .filter((oldField) => {
          const newField = patch.fields!.find((f) => f.name === oldField.name);
          return !newField || newField.value !== oldField.value;
        })
        .map((oldField) => ({ name: oldField.name, value: oldField.value }));

      if (changedSecretFields.length > 0) {
        history = [...(existing.history ?? []), { fields: changedSecretFields, changedAt: now }];
      }
    }

    const updated: Item = {
      ...existing,
      ...patch,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: now,
      history,
    };
    this.items[idx] = structuredClone(updated);
    this.dirty = true;
    return structuredClone(updated);
  }

  /**
   * Закрепить запись наверху списка или снять закрепление.
   *
   * Отдельный метод, а не поле в `ItemPatch`, и это не педантизм: `updateItem`
   * всегда двигает `updatedAt`, а закрепление изменением записи не является.
   * Через патч звёздочка перекидывала бы запись в начало «недавно изменённых»
   * и перемешивала бы порядок остальных - человек терял бы из виду то, над чем
   * работал минуту назад.
   */
  setPinned(id: string, pinned: boolean): Item {
    this.assertLoaded();
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx === -1) throw new ItemNotFoundError(id);
    // Снятое закрепление пишется как отсутствие поля, а не как `false`: так
    // база, в которой избранным не пользовались, побайтово не отличается от
    // базы старой версии.
    const next: Item = { ...this.items[idx] };
    if (pinned) next.pinned = true;
    else delete next.pinned;
    this.items[idx] = next;
    this.dirty = true;
    return structuredClone(next);
  }

  /** Удалить запись. Бросает `ItemNotFoundError`, если записи с таким `id`
   * нет - молчаливый no-op на несуществующий `id` скрыл бы ошибку вызывающего
   * кода (передан не тот `id`), а не защитил бы данные. */
  deleteItem(id: string): void {
    this.assertLoaded();
    const idx = this.items.findIndex((item) => item.id === id);
    if (idx === -1) throw new ItemNotFoundError(id);
    this.items.splice(idx, 1);
    this.dirty = true;
  }

  /**
   * Полностью заменить внутреннюю коллекцию переданным массивом - для
   * импорта (§12, R100): импорт заменяет базу целиком, а не сливает записи
   * через `addItem`/`updateItem`, которые генерировали бы новые `id`/
   * `createdAt` и не принимают `history` - цикл из них исказил бы
   * импортируемые записи. `replaceAllItems` берёт их как есть, включая
   * `id`, `createdAt`, `updatedAt`, `history` из файла импорта.
   *
   * Копия (`structuredClone`), не хранение ссылки на чужой массив - тот же
   * принцип, что и у `addItem`/`updateItem`/`search`: внутреннее состояние
   * не должно меняться в обход этого класса, если вызывающий код продолжит
   * держать и мутировать свою копию `items` после вызова.
   *
   * Только меняет память и `isDirty()` - на диск ничего не пишет, это
   * делает вызывающий код обычным `save()`. Именно поэтому уменьшение
   * числа записей (импорт 3 записей поверх базы из 50) НЕ проверяется и не
   * блокируется здесь - оно останется незамеченным до следующего `save()`,
   * который наткнётся на `ItemCountDecreasedError` (R28) и потребует
   * `{ allowCountDecrease: true }`, ровно как при любом другом уменьшении.
   * Это осознанно: двойное предупреждение (свое у импорта и ещё одно у
   * save()) избыточно, а обход R28 специально для этого пути нарушил бы
   * инвариант "уменьшение никогда не проходит без подтверждения" ради
   * одного вызывающего кода.
   */
  replaceAllItems(items: Item[]): void {
    this.assertLoaded();
    this.items = structuredClone(items);
    this.dirty = true;
  }

  /**
   * Оркестрация сохранения на диск (spec.md §5, дословно из брифа):
   * 0. R28 (история 11, §9): если число записей сейчас меньше, чем было при
   *    последней успешной загрузке (`loadedCount`), и вызывающий код явно не
   *    подтвердил уменьшение (`opts.allowCountDecrease`) - бросить
   *    `ItemCountDecreasedError` и НЕ писать на диск вообще ничего (ни
   *    бэкап, ни новую версию файла, ни emergency-скрипты) - fail closed,
   *    как того требует "не сохранять молча". Диалог "было N, стало M" -
   *    забота UI (тикеты 06-10), этот метод только даёт `loaded`/`current`
   *    через поля ошибки и точку, где повторный вызов с подтверждением
   *    пройдёт;
   * 1. если по `path` уже лежит файл - скопировать его как есть в
   *    `backups/vault-<ISO8601>.dat` (текущая, ещё не изменённая версия);
   * 2. записать новую версию (`toBytes()`) атомарно в `path`;
   * 3. `rotateBackups(backupsDir, MAX_BACKUPS)` - оставить последние 20.
   *
   * Копии `emergency-decrypt.py` И `aes_gcm.py` (см. комментарий у их
   * импортов выше - без второго файла первый не может расшифровать тело)
   * кладутся рядом с `path` и в каталог бэкапов при каждом успешном
   * сохранении, всегда вместе - см. `copyEmergencyScriptsTo` ниже. Их
   * отсутствие или неудача записи не прерывают сохранение самой базы (не
   * данные пользователя, восстановимо из репозитория/другой копии).
   *
   * Если `rotateBackups` не удалась целиком (не просто "один старый файл не
   * удалился" - это уже прощено внутри самой Rust-команды, см. её
   * комментарии) - сохранение всё равно считается успешным: новая версия уже
   * на диске к этому моменту, лишний бэкап, оставшийся сверх лимита, не
   * нарушает приоритет 1 (данные не теряются). Ошибка только логируется.
   *
   * После успешной записи новой версии (шаг 2) `isDirty()` становится
   * `false` и `loadedCount` переустанавливается на новое `this.items.length`
   * - следующая проверка уменьшения идёт от ЭТОЙ точки (последнее успешное
   * сохранение), не бесконечно от самой первой загрузки за сессию.
   */
  async save(path: string, opts?: { allowCountDecrease?: boolean }): Promise<void> {
    this.assertLoaded();

    if (
      this.loadedCount !== null &&
      this.items.length < this.loadedCount &&
      !opts?.allowCountDecrease
    ) {
      throw new ItemCountDecreasedError(this.loadedCount, this.items.length);
    }

    const backupsDir = backupsDirFor(path);

    let existingBytes: Uint8Array | null;
    try {
      existingBytes = await readVault(path);
    } catch {
      // Файла по этому пути ещё нет - это самое первое сохранение только что
      // созданной базы, бэкапировать нечего.
      existingBytes = null;
    }

    if (existingBytes !== null) {
      const backupPath = joinPath(backupsDir, `vault-${formatBackupTimestamp(new Date())}.dat`);
      await writeVaultAtomic(backupPath, existingBytes);
      await this.copyEmergencyScriptsTo(backupsDir);
    }

    const newBytes = await this.toBytes();
    await writeVaultAtomic(path, newBytes);
    this.loadedCount = this.items.length;

    await this.copyEmergencyScriptsTo(dirOf(path));

    try {
      await rotateBackups(backupsDir, MAX_BACKUPS);
    } catch (err) {
      console.error("vaultStore: rotate_backups failed, keeping the new save", err);
    }

    this.dirty = false;
  }

  /**
   * Записать `emergency-decrypt.py`, `aes_gcm.py` И `emergency-decrypt.bat`
   * в указанный каталог - всегда втроём, никогда по отдельности:
   * `emergency-decrypt.py` без `aes_gcm.py` рядом откажет с понятной ошибкой
   * при попытке расшифровать тело (см. импорт `aes_gcm` в начале
   * emergency-decrypt.py), а `.bat` без обоих не находит, что запускать -
   * так что копия неполного набора никого не спасёт в реальной аварии.
   * Неудача записи (диск занят, нет прав и т.п.) только логируется - это
   * вспомогательные файлы, не данные пользователя, и их отсутствие не
   * должно блокировать сохранение самой базы (см. `save()` выше).
   */
  private async copyEmergencyScriptsTo(dir: string): Promise<void> {
    try {
      await writeVaultAtomic(
        joinPath(dir, "emergency-decrypt.py"),
        new TextEncoder().encode(emergencyScriptSource),
      );
      await writeVaultAtomic(joinPath(dir, "aes_gcm.py"), new TextEncoder().encode(aesGcmScriptSource));
      await writeVaultAtomic(
        joinPath(dir, "emergency-decrypt.bat"),
        new TextEncoder().encode(emergencyBatSource),
      );
    } catch (err) {
      console.error(`vaultStore: failed to copy emergency-decrypt scripts into ${dir}`, err);
    }
  }

  /**
   * Восстановление после повреждения (R114i): список файлов бэкапов для
   * данной базы, отфильтрованный по имени (`vault-YYYY-MM-DD-HHmmss.dat` -
   * каталог `backups/` может содержать и другие файлы, например копию
   * `emergency-decrypt.py`, см. `save()` выше) и отсортированный от самого
   * нового к самому старому. Сам диалог выбора для пользователя строит
   * тикет 06 - это только источник данных для него.
   */
  static async listBackupsForRecovery(vaultPath: string): Promise<BackupInfo[]> {
    const dir = backupsDirFor(vaultPath);
    const all = await listBackups(dir);
    return all
      .filter((backup) => BACKUP_FILENAME_RE.test(backup.filename))
      .slice()
      .sort((a, b) => b.modifiedAtMs - a.modifiedAtMs);
  }

  /**
   * Открыть конкретный файл бэкапа как текущую базу (R114i) - это ОТКРЫТИЕ,
   * не автоматическая замена основного файла: перезапись боевого `vault.dat`
   * произойдёт только следующим обычным `save()`, который вызовет пользователь
   * сам, убедившись, что данные из бэкапа верные (см. spec.md §5). Бросает
   * те же `FormatError`/`DecryptError`, что и `loadFromBytes`, если сам
   * выбранный бэкап тоже повреждён или пароль не подошёл.
   */
  async loadFromBackupFile(backupPath: string, password: string): Promise<void> {
    const bytes = await readVault(backupPath);
    await this.loadFromBytes(bytes, password);
  }
}
