/**
 * PIN-обёртка над ключом хранилища (фича "разблокировка по PIN").
 *
 * Модель безопасности (согласована заранее, см. задание): мастер-пароль
 * остаётся единственным способом менять сами "доступы" (сам пароль,
 * включение/выключение/смену PIN) - это делает `Settings.tsx`. PIN - только
 * для повседневного входа в уже созданную базу (`LockScreen.tsx`), переживает
 * перезапуск приложения (хранится в `vault.settings.json` через
 * `settingsConfig.ts`).
 *
 * Механизм - envelope-шифрование: PIN оборачивает те же 256 бит, что и
 * реальный ключ шифрования хранилища (та же PBKDF2-деривация из
 * мастер-пароля, соли и итераций заголовка конкретной базы, см.
 * `vaultFormat.ts`/`crypto.ts`), собственным AES-256-GCM ключом, выведенным
 * из PIN с высоким числом итераций PBKDF2 (`PIN_KDF_ITERATIONS` ниже). Это
 * осознанный компромисс, принятый пользователем: offline-подбор PIN по
 * украденному `vault.settings.json` теоретически быстрее полного перебора
 * мастер-пароля - смягчается числом итераций PIN и лимитом попыток на вводе
 * (`isPinLockedOut`/`recordFailedPinAttempt` ниже), дальше не пересматривается
 * в рамках этой фичи.
 *
 * Переиспользует `deriveKey`/`encrypt`/`decrypt` из `crypto.ts` напрямую -
 * не реализует крипто-примитивы заново (тот же принцип R20/R32, что и у
 * самого `crypto.ts`). Ничего не знает про `VaultStore.key` и не читает его
 * (R34, см. комментарий модуля `crypto.ts`) - вся передеривка идёт из
 * пароля, который вызывающий код (`LockScreen.tsx`/`Settings.tsx`) держит в
 * памяти сам в момент установки/смены PIN.
 */
import { deriveKey, encrypt, decrypt, DecryptError } from "./crypto";

/** Сколько неверных попыток PIN подряд ведёт к временной блокировке входа. */
export const PIN_LOCKOUT_MAX_ATTEMPTS = 3;

/** Длительность временной блокировки после `PIN_LOCKOUT_MAX_ATTEMPTS`
 * неверных попыток подряд, мс - 10 минут. */
export const PIN_LOCKOUT_DURATION_MS = 10 * 60 * 1000;

/**
 * Число итераций PBKDF2 для ключа, которым PIN оборачивает реальный ключ
 * хранилища - та же нижняя граница OWASP, что и `OWASP_MIN_ITERATIONS` в
 * `crypto.ts` (не экспортирована оттуда - приватная константа того модуля,
 * поэтому здесь своя копия с тем же обоснованием: PIN короче и менее
 * случаен, чем полноценный мастер-пароль, поэтому обязан компенсировать это
 * числом итераций не меньшим, чем нижняя граница для самого пароля).
 */
const PIN_KDF_ITERATIONS = 600_000;

/** Минимальная/максимальная длина PIN - чисто цифровой код. */
export const PIN_MIN_LENGTH = 4;
export const PIN_MAX_LENGTH = 8;

/** Обёртка реального ключа хранилища PIN-ом - хранится в
 * `vault.settings.json` (`VaultSettings.pin`, см. `settingsConfig.ts`).
 * `salt`/`iv`/`wrappedKey` - base64 (стандартный алфавит), как и остальные
 * бинарные поля в открытых частях этого проекта (`vaultFormat.ts`). `salt`
 * здесь - СОБСТВЕННАЯ соль PIN, отдельная от соли мастер-пароля в заголовке
 * базы (`VaultHeader.kdf.salt`) - две разные PBKDF2-деривации с разными
 * входами, смешивать их нельзя. */
export type PinWrap = {
  salt: string;
  iterations: number;
  iv: string;
  wrappedKey: string;
};

/** Единая ошибка разблокировки по PIN - тот же принцип, что `DecryptError` в
 * `crypto.ts`: AES-GCM не различает на своём уровне "неверный PIN" и
 * "повреждённые/устаревшие данные обёртки", поэтому и здесь наружу уходит
 * один тип ошибки, не два. */
export class PinUnlockError extends Error {
  constructor(message = "PIN unlock failed: wrong PIN or corrupted wrap data") {
    super(message);
    this.name = "PinUnlockError";
  }
}

/** base64 (стандартный алфавит) -> байты - своя маленькая копия, как уже
 * принято в проекте (`vaultStore.ts`/`vaultFormat.ts`/`RecordCard.tsx`/
 * `Settings.tsx` и т.д. - приватные хелперы других модулей не экспортируются,
 * у каждого файла своя копия). */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Обратное преобразование: байты -> base64 (стандартный алфавит). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/** Чисто цифровой PIN, от `PIN_MIN_LENGTH` до `PIN_MAX_LENGTH` символов -
 * переиспользуется и формой ввода (LockScreen.tsx), и формой настройки
 * (Settings.tsx), чтобы правило не разошлось между двумя экранами. */
export function isValidPinFormat(pin: string): boolean {
  return pin.length >= PIN_MIN_LENGTH && pin.length <= PIN_MAX_LENGTH && /^[0-9]+$/.test(pin);
}

/**
 * Независимая передеривация тех же 256 бит, что и у реального ключа
 * хранилища (тот же пароль+соль+итерации, что в заголовке базы), но через
 * `crypto.subtle.deriveBits` вместо `deriveKey` из `crypto.ts` - `deriveBits`
 * отдаёт сырые байты напрямую, `deriveKey` намеренно этого не делает
 * (`extractable: false`, R34). Это НЕ чтение `VaultStore.key`: результат -
 * заново посчитанный из пароля эквивалент, который вызывающий код и так
 * держит в памяти в момент установки PIN (только что ввёл его в форму) -
 * инвариант R34 ("ключ никогда не покидает `crypto.ts`/`VaultStore` как
 * сырые байты") этим не нарушается, потому что здесь нет самого объекта
 * `VaultStore.key` вообще, только независимый пересчёт из открытых входных
 * данных (пароль в памяти формы + публичные соль/итерации заголовка).
 */
async function deriveVaultKeyRawBits(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<Uint8Array> {
  const passwordKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    passwordKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Настроить PIN для уже существующей (только что созданной или только что
 * разблокированной мастер-паролем) базы: пересчитать сырые биты реального
 * ключа хранилища (`deriveVaultKeyRawBits`), сгенерировать собственную
 * случайную соль PIN (16 байт, тот же размер, что у соли базы - см.
 * `VaultStore.createNewVault`), вывести из PIN ключ-обёртку
 * (`PIN_KDF_ITERATIONS`) и зашифровать сырые биты им (`encrypt` из
 * `crypto.ts` - случайный IV на каждый вызов, как и у самой базы).
 */
export async function setUpPin(
  vaultPassword: string,
  vaultSalt: Uint8Array,
  vaultIterations: number,
  pin: string,
): Promise<PinWrap> {
  const raw = await deriveVaultKeyRawBits(vaultPassword, vaultSalt, vaultIterations);
  const pinSalt = crypto.getRandomValues(new Uint8Array(16));
  const pinKey = await deriveKey(pin, pinSalt, PIN_KDF_ITERATIONS);
  const { iv, ciphertext } = await encrypt(pinKey, raw);
  return {
    salt: bytesToBase64(pinSalt),
    iterations: PIN_KDF_ITERATIONS,
    iv: bytesToBase64(iv),
    wrappedKey: bytesToBase64(ciphertext),
  };
}

/**
 * Развернуть обёртку PIN-ом обратно в сырые биты реального ключа хранилища -
 * вызывающий код (`LockScreen.tsx`) передаёт результат в
 * `VaultStore.loadFromBytesWithRawKey`. Неверный PIN и повреждённая/
 * устаревшая обёртка (например, PIN не сбросили после смены мастер-пароля)
 * неразличимы на этом уровне - обе ветки `DecryptError` из `crypto.ts`
 * перебрасываются как единый `PinUnlockError`.
 */
export async function unwrapVaultKeyWithPin(wrap: PinWrap, pin: string): Promise<Uint8Array> {
  const pinKey = await deriveKey(pin, base64ToBytes(wrap.salt), wrap.iterations);
  try {
    return await decrypt(pinKey, base64ToBytes(wrap.iv), base64ToBytes(wrap.wrappedKey));
  } catch (err) {
    if (err instanceof DecryptError) {
      throw new PinUnlockError();
    }
    throw err;
  }
}

/** Состояние лимита попыток PIN - хранится в `vault.settings.json`
 * (`VaultSettings.pinLockout`). `lockedUntil` - ISO8601 момент, до которого
 * вход заблокирован, или `null`, если сейчас блокировки нет. */
export type PinLockoutState = { failedAttempts: number; lockedUntil: string | null };

/** Заблокирован ли сейчас вход по PIN (и, по решению `LockScreen.tsx`, заодно
 * и по мастер-паролю - см. её комментарий). `now` - параметр, а не
 * `Date.now()` внутри - тот же принцип тестируемости, что и у
 * `isSecretFieldStale` в `RecordCard.tsx`. Отсутствие состояния (PIN ни разу
 * не настраивался или блокировки не было) - не заблокировано. */
export function isPinLockedOut(state: PinLockoutState | undefined, now: Date): boolean {
  if (!state?.lockedUntil) return false;
  return new Date(state.lockedUntil).getTime() > now.getTime();
}

/**
 * Зафиксировать одну неверную попытку PIN: увеличить `failedAttempts` на 1;
 * если достигнут `PIN_LOCKOUT_MAX_ATTEMPTS` - выставить/обновить
 * `lockedUntil` на `now + PIN_LOCKOUT_DURATION_MS`.
 *
 * Намеренно не сбрасывает `failedAttempts` сам по себе, когда предыдущая
 * блокировка уже истекла (`isPinLockedOut` для неё сейчас вернула бы false) -
 * если после истечения блокировки следующая попытка снова неверна, счётчик
 * продолжает расти от прежнего значения и блокировка включается заново
 * немедленно (после одной, не трёх новых попыток). Это закрывает лазейку
 * "переждать блокировку и получить ещё три бесплатные попытки" - явное
 * решение, не недосмотр. Единственное, что по-настоящему обнуляет счётчик -
 * `resetPinLockout()` после УСПЕШНОГО входа (любым способом, см.
 * `LockScreen.tsx`).
 */
export function recordFailedPinAttempt(state: PinLockoutState | undefined, now: Date): PinLockoutState {
  const failedAttempts = (state?.failedAttempts ?? 0) + 1;
  if (failedAttempts >= PIN_LOCKOUT_MAX_ATTEMPTS) {
    return {
      failedAttempts,
      lockedUntil: new Date(now.getTime() + PIN_LOCKOUT_DURATION_MS).toISOString(),
    };
  }
  return { failedAttempts, lockedUntil: state?.lockedUntil ?? null };
}

/** Состояние "лимита попыток нет" - после любого успешного входа. */
export function resetPinLockout(): PinLockoutState {
  return { failedAttempts: 0, lockedUntil: null };
}
