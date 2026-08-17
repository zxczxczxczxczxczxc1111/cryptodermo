/**
 * Настройки приложения (`vault.settings.json`) - тикет 09.
 *
 * Простой текстовый JSON рядом с базой: таймаут автоблокировки и путь к
 * последней базе. Не секрет, не шифруется, не участвует в ротации `backups/`
 * (interfaces.md → "Хранение настроек приложения", spec.md §9). Читается и
 * пишется теми же Rust-командами файлового слоя, что и сама база
 * (`readVault`/`writeVaultAtomic` из `tauriApi.ts`) - это обычный JSON, не
 * зашифрованный контейнер, никакого `crypto.ts`/`vaultFormat.ts` здесь нет.
 *
 * Схема зафиксирована в interfaces.md ДО этого тикета, чтобы совпадать с
 * тем, что уже читает параллельный тикет 06 (`useAutoLock.ts`,
 * `readAutoLockTimeoutMs`): тот же путь (`<каталог базы>/vault.settings.json`),
 * те же имена полей. Тикет 06 не импортирует этот модуль (его ещё не было на
 * момент параллельной сборки волны 4) - у него собственная маленькая копия
 * чтения одного поля, это осознанное дублирование, задокументированное в
 * interfaces.md, не ошибка. Этот модуль - полноценный владелец файла: читает
 * оба поля и умеет писать.
 *
 * Фича PIN-кода (см. `pinLock.ts`) добавляет сюда три необязательных поля -
 * `pin`/`pinLockout`/`pinSetupOffered` (ниже в `VaultSettings`). Как и
 * `autoLockTimeoutMs`/`lastVaultPath`, они независимы друг от друга и от уже
 * существующих полей: отсутствие/некорректность любого одного не мешает
 * прочитать остальные, а старые файлы без этих полей - валидное состояние
 * ("PIN не настроен"), не ошибка.
 */
import { readVault, writeVaultAtomic } from "./tauriApi";
import type { PinWrap, PinLockoutState } from "./pinLock";

const SETTINGS_FILENAME = "vault.settings.json";

/** Дефолт таймаута автоблокировки - 5 минут (В5 из брифа), используется,
 * когда `vault.settings.json` ещё нет (валидное состояние) или поле в нём
 * не задано/некорректно. То же число, что и `DEFAULT_AUTO_LOCK_TIMEOUT_MS`
 * в `useAutoLock.ts` - значение из interfaces.md, не совпадение. */
export const DEFAULT_AUTO_LOCK_TIMEOUT_MS = 300_000;

/** Схема файла - дословно по interfaces.md. Оба поля независимы: допустимо
 * присутствие только одного, отсутствующее поле = дефолт, не ошибка. */
export type VaultSettings = {
  /** Таймаут автоблокировки, миллисекунды. */
  autoLockTimeoutMs: number;
  /** Путь к последней открытой базе, или `null`, если ещё не сохранялась. */
  lastVaultPath: string | null;
  /** PIN-обёртка реального ключа хранилища (см. `pinLock.ts`) - `undefined`,
   * если PIN не настроен. Инвалидируется (сбрасывается) сменой мастер-пароля
   * (`Settings.tsx`, `changeMasterPassword`) - старая обёртка держит байты
   * СТАРОГО ключа. */
  pin?: PinWrap;
  /** Лимит неверных попыток PIN (см. `pinLock.ts`) - `undefined`, если PIN
   * ни разу не настраивался или блокировки ещё не было. */
  pinLockout?: PinLockoutState;
  /** Одноразовое предложение настроить PIN уже показано - не спамить им на
   * каждой разблокировке (`LockScreen.tsx`). */
  pinSetupOffered?: boolean;
};

/** Значения по умолчанию - используются целиком, когда файла ещё нет, и
 * по отдельным полям, когда файл есть, но поле отсутствует/некорректно. */
export const DEFAULT_SETTINGS: VaultSettings = {
  autoLockTimeoutMs: DEFAULT_AUTO_LOCK_TIMEOUT_MS,
  lastVaultPath: null,
};

/** `value` выглядит как валидный `PinWrap` - все четыре поля нужной формы.
 * Некорректная/неполная форма трактуется как "PIN не настроен" (`undefined`),
 * не как ошибка чтения всего файла - тот же принцип независимости полей, что
 * и у `autoLockTimeoutMs`/`lastVaultPath` выше. */
function isValidPinWrap(value: unknown): value is PinWrap {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.salt === "string" &&
    typeof obj.iterations === "number" &&
    Number.isFinite(obj.iterations) &&
    typeof obj.iv === "string" &&
    typeof obj.wrappedKey === "string"
  );
}

/** `value` выглядит как валидный `PinLockoutState`. Некорректная форма -
 * "блокировки нет" (`undefined`), тот же принцип, что и у `isValidPinWrap`. */
function isValidPinLockoutState(value: unknown): value is PinLockoutState {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.failedAttempts !== "number" || !Number.isFinite(obj.failedAttempts)) return false;
  if (obj.lockedUntil !== null && typeof obj.lockedUntil !== "string") return false;
  return true;
}

/** Каталог файла из полного пути - копия той же маленькой утилиты, что уже
 * есть в vaultStore.ts/useAutoLock.ts (см. их комментарии: между модулями
 * это дублируется умышленно, а не экспортируется - так решено в тикетах
 * 02/05/06). Понимает и "/", и "\\" - база может лежать на Windows-пути. */
function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? "." : path.slice(0, idx);
}

/** Склеить каталог и имя файла тем же разделителем, что уже используется в
 * каталоге - та же логика, что в vaultStore.ts/useAutoLock.ts. */
function joinPath(dir: string, filename: string): string {
  if (dir === "" || dir === ".") return filename;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${filename}` : `${dir}${sep}${filename}`;
}

/** Путь к `vault.settings.json` для данной базы - `<каталог базы>/vault.settings.json`
 * (тот же путь, что вычисляет `useAutoLock.ts`). */
export function settingsPathFor(vaultPath: string): string {
  return joinPath(dirOf(vaultPath), SETTINGS_FILENAME);
}

/**
 * Прочитать настройки рядом с данной базой. Отсутствие файла - валидное
 * состояние (значения по умолчанию), как и любая другая причина, по которой
 * прочитать/разобрать его не вышло (битый JSON, поле не того типа и т.п.) -
 * эта функция никогда не бросает исключение наружу, только возвращает
 * дефолты. Поля читаются независимо друг от друга: некорректное
 * `autoLockTimeoutMs` не мешает прочитать валидный `lastVaultPath`, и
 * наоборот.
 */
export async function readSettings(vaultPath: string): Promise<VaultSettings> {
  try {
    const bytes = await readVault(settingsPathFor(vaultPath));
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) {
      return { ...DEFAULT_SETTINGS };
    }
    const obj = parsed as Record<string, unknown>;

    const autoLockTimeoutMs =
      typeof obj.autoLockTimeoutMs === "number" &&
      Number.isFinite(obj.autoLockTimeoutMs) &&
      obj.autoLockTimeoutMs > 0
        ? obj.autoLockTimeoutMs
        : DEFAULT_AUTO_LOCK_TIMEOUT_MS;

    const lastVaultPath = typeof obj.lastVaultPath === "string" ? obj.lastVaultPath : null;

    const settings: VaultSettings = { autoLockTimeoutMs, lastVaultPath };
    if (isValidPinWrap(obj.pin)) settings.pin = obj.pin;
    if (isValidPinLockoutState(obj.pinLockout)) settings.pinLockout = obj.pinLockout;
    if (typeof obj.pinSetupOffered === "boolean") settings.pinSetupOffered = obj.pinSetupOffered;

    return settings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * Записать настройки рядом с данной базой - весь объект целиком, атомарно
 * (`writeVaultAtomic`, тот же файловый слой, что и у самой базы). Вызывающий
 * код отвечает за то, чтобы передать полный `VaultSettings` (см.
 * `updateSettings` ниже для частичного обновления с автоматическим
 * подмешиванием текущих значений).
 */
export async function writeSettings(vaultPath: string, settings: VaultSettings): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(settings, null, 2));
  await writeVaultAtomic(settingsPathFor(vaultPath), bytes);
}

/**
 * Прочитать текущие настройки, подмешать `patch` и записать обратно - на
 * этом построены обе формы экрана настроек (таймаут автоблокировки, путь к
 * базе), которым нужно изменить только одно поле, не трогая второе.
 */
export async function updateSettings(
  vaultPath: string,
  patch: Partial<VaultSettings>,
): Promise<VaultSettings> {
  const current = await readSettings(vaultPath);
  const next: VaultSettings = { ...current, ...patch };
  await writeSettings(vaultPath, next);
  return next;
}
