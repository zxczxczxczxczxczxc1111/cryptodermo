/**
 * Экран настроек (тикет 09, R101/R101.1, spec.md §9 "Настройки").
 *
 * Три независимых раздела - смена мастер-пароля, таймаут автоблокировки,
 * путь к базе - каждый со своей кнопкой и своим статусом (R84: кнопка
 * называется тем, что произойдёт, статус после - то же действие в прошедшем
 * времени). Таймаут и путь читаются/пишутся через `settingsConfig.ts`
 * (`vault.settings.json`, не секрет, обычный JSON). Смена пароля - через
 * `changeMasterPassword` ниже, отдельный поток, не однострочная замена (см.
 * комментарий у неё).
 *
 * D02 (interfaces.md/manifest.md): `src/App.tsx` не в зоне этого тикета, его
 * сведёт тикет 12 позже - поэтому у `Settings` полностью самостоятельный
 * публичный контракт через пропсы/колбэки (`SettingsProps` ниже), как и у
 * `LockScreen`/`Editor` из тикетов 06/08. В частности, `onAutoLockTimeoutChange`
 * существует именно для тикета 12: этот экран гарантирует запись нового
 * таймаута на диск и немедленный колбэк, но "живое" применение без
 * перезапуска (критерий приёмки тикета) требует, чтобы вызывающий код
 * (тикет 12) передал новое значение в `useAutoLock` - у самого `useAutoLock`
 * (тикет 06, чужая зона) таймаут читается один раз при разблокировке
 * (`interfaces.md`: "тикет 06 только читает autoLockTimeoutMs при старте"),
 * без параметра для живого обновления. Замкнуть эту цепочку до конца может
 * только тикет 12, когда `App.tsx` уже существует - см. отчёт по тикету.
 *
 * Как и у `LockScreen`/`Editor`, значимая логика вынесена в обычные
 * async-функции без JSX/хуков (здесь - `changeMasterPassword`), потому что в
 * проекте нет DOM-окружения для тестов (jsdom/happy-dom не установлены,
 * ставить новую зависимость без отдельного вопроса нельзя, R31). Сам
 * JSX-компонент проверен глазами и сборкой (`tsc`/`vite build`), не
 * автотестом.
 */
import { useEffect, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { VaultStore, type Item } from "../lib/vaultStore";
import { deriveKey, encrypt, decrypt, DecryptError } from "../lib/crypto";
import { serializeContainer, parseContainer, FormatError, type VaultHeader } from "../lib/vaultFormat";
import { readVault } from "../lib/tauriApi";
import { readSettings, updateSettings, DEFAULT_AUTO_LOCK_TIMEOUT_MS } from "../lib/settingsConfig";
import { isValidPinFormat, setUpPin, resetPinLockout, PIN_MAX_LENGTH } from "../lib/pinLock";
import { PasswordField } from "../components/PasswordField";
import "../tokens.css";
import "./Settings.css";

/** base64 (стандартный алфавит) -> байты - та же маленькая копия, что уже
 * есть в vaultStore.ts/vaultFormat.ts (между модулями дублируется умышленно,
 * не экспортируется - см. их комментарии, тот же принцип здесь). */
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

export type ChangePasswordResult = { ok: true; store: VaultStore } | { ok: false; message: string };

/** AES-GCM (и разбор контейнера) не различают "неверный пароль" и "файл
 * повреждён" на своём уровне - тот же принцип R94.1, что и в LockScreen.tsx
 * (UNLOCK_ERROR_MESSAGE), применённый здесь к проверке ТЕКУЩЕГО пароля перед
 * сменой на новый. */
export const CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE =
  "Не удалось подтвердить текущий пароль: пароль неверен или файл базы повреждён";

export const PASSWORD_MISMATCH_MESSAGE = "Новый пароль и повтор не совпадают";

export const PASSWORD_CHANGE_SAVE_ERROR_MESSAGE =
  "Не удалось сохранить базу с новым паролем. Файл на диске не изменён - проверьте, что каталог доступен для записи, и попробуйте снова";

export const UNEXPECTED_ERROR_MESSAGE = "Не удалось выполнить операцию. Попробуйте ещё раз";

/**
 * Смена мастер-пароля (R101.1, история 18) - шаги дословно из тикета, не
 * "быстрая замена одной строки":
 *
 * 1. Читает текущий файл базы с диска и проверяет `currentPassword` реальным
 *    расшифрованием его тела (не доверяет памяти - `store` мог быть открыт
 *    раньше, файл на диске должен подтвердить пароль сам). Если пароль не
 *    подходит или файл повреждён - никаких изменений на диске ещё не было
 *    (единый текст ошибки, см. `CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE`).
 * 2. Данные для перешифровки берутся из ЖИВОГО `store` (`store.search("")`
 *    - публичный способ получить всю коллекцию, см. vaultStore.ts), не из
 *    только что расшифрованного тела с диска: если в сторе есть
 *    несохранённые правки (`isDirty()`), они не должны потеряться при смене
 *    пароля - приоритет 1 ("данные не теряются") выше, чем "переписать
 *    ровно то, что уже проверено паролем".
 * 3. Деривация нового ключа (`deriveKey`) со свежей случайной солью, число
 *    итераций и алгоритмы - те же, что были в текущем заголовке (не
 *    выдумываются заново).
 * 4. Перешифровка всей коллекции новым ключом (`encrypt`) и сборка нового
 *    контейнера (`serializeContainer`).
 * 5. Новый `VaultStore` собирается через `loadFromBytes` на СВЕЖЕ
 *    построенных байтах - это раунд-трип через уже проверенную логику
 *    разбора/расшифровки, не "доверяй и не проверяй": если бы шаг 4 собрал
 *    что-то невалидное, `loadFromBytes` сам бы на этом споткнулся.
 * 6. `newStore.save(vaultPath)` - переиспользует существующую оркестрацию
 *    `VaultStore` (spec.md §5): бэкап ТЕКУЩЕГО файла на ДИСКЕ (ещё на старом
 *    пароле, до этого момента ничего не менялось) в `backups/`, затем
 *    атомарная запись новой версии, затем ротация. Ничего не пишется
 *    частично - если `save()` бросает исключение на записи, `vault.dat`
 *    остаётся тем, чем был (см. комментарий `write_vault_atomic` в Rust:
 *    прямой записи в целевой файл не существует ни на одном шаге), а
 *    переданный извне `store` не тронут вообще (новый стор - отдельный
 *    объект) - вызывающий код может показать ошибку и предложить попробовать
 *    ещё раз, ничего не потеряв.
 *
 * Возвращает новый `VaultStore` при успехе - вызывающий код (в конечном
 * счёте App.tsx, тикет 12) обязан заменить им старый: у старого `store`
 * ключ больше не соответствует тому, что записано на диске.
 */
export async function changeMasterPassword(params: {
  store: VaultStore;
  vaultPath: string;
  currentPassword: string;
  newPassword: string;
}): Promise<ChangePasswordResult> {
  const { store, vaultPath, currentPassword, newPassword } = params;

  const diskBytes = await readVault(vaultPath);

  let header: VaultHeader;
  let ciphertext: Uint8Array;
  try {
    ({ header, ciphertext } = parseContainer(diskBytes));
  } catch (err) {
    if (err instanceof FormatError) {
      return { ok: false, message: CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE };
    }
    throw err;
  }

  const oldSalt = base64ToBytes(header.kdf.salt);
  const oldKey = await deriveKey(currentPassword, oldSalt, header.kdf.params.iterations);
  try {
    // Результат не нужен - это чистая проверка пароля, данные для
    // перешифровки идут из живого store (см. комментарий функции выше).
    await decrypt(oldKey, base64ToBytes(header.iv), ciphertext);
  } catch (err) {
    if (err instanceof DecryptError) {
      return { ok: false, message: CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE };
    }
    throw err;
  }

  const items: Item[] = store.search("");

  const newSalt = crypto.getRandomValues(new Uint8Array(16));
  const newKey = await deriveKey(newPassword, newSalt, header.kdf.params.iterations);
  const plaintext = new TextEncoder().encode(JSON.stringify(items));
  const { iv, ciphertext: newCiphertext } = await encrypt(newKey, plaintext);

  const newHeader: VaultHeader = {
    v: header.v,
    kdf: {
      alg: header.kdf.alg,
      params: { iterations: header.kdf.params.iterations },
      salt: bytesToBase64(newSalt),
    },
    cipher: header.cipher,
    iv: bytesToBase64(iv),
  };
  const newContainerBytes = serializeContainer(newHeader, newCiphertext);

  const newStore = new VaultStore();
  await newStore.loadFromBytes(newContainerBytes, newPassword);

  try {
    await newStore.save(vaultPath);
  } catch (err) {
    console.error("Settings: failed to save the vault under the new password", err);
    return { ok: false, message: PASSWORD_CHANGE_SAVE_ERROR_MESSAGE };
  }

  // Смена мастер-пароля инвалидирует PIN (задание, фича PIN-кода): старая
  // PinWrap (если PIN был настроен) держит байты СТАРОГО ключа хранилища -
  // после смены пароля они больше не совпадают с реальным ключом, использовать
  // её нельзя. Единственный корректный ответ - сброс, не попытка
  // "перешифровать" обёртку заново здесь же (пользователь явно не вводил PIN
  // в этой форме - настраивать его заново без спроса было бы неожиданно).
  // Best-effort: неудача этой записи не должна откатывать уже свершившуюся,
  // куда более важную смену самого мастер-пароля (тот же принцип, что у
  // copyEmergencyScriptsTo/rotateBackups в vaultStore.ts - вторичная запись,
  // ошибка только логируется).
  try {
    await updateSettings(vaultPath, { pin: undefined, pinLockout: undefined });
  } catch (err) {
    console.error("Settings: failed to clear PIN settings after changing the master password", err);
  }

  return { ok: true, store: newStore };
}

/** Единая ошибка проверки текущего мастер-пароля для операций с PIN - тот же
 * принцип R94.1, что и `CURRENT_PASSWORD_VERIFY_ERROR_MESSAGE` выше. */
export const PIN_TOGGLE_PASSWORD_ERROR_MESSAGE =
  "Не удалось подтвердить текущий пароль: пароль неверен или файл базы повреждён";
export const PIN_TOGGLE_MISMATCH_MESSAGE = "PIN и повтор не совпадают";
export const PIN_TOGGLE_FORMAT_ERROR_MESSAGE = "PIN должен состоять только из цифр (4-8 символов)";

export type PinToggleResult = { ok: true } | { ok: false; message: string };

/**
 * Проверить, что `password` - актуальный мастер-пароль базы на ДИСКЕ (не
 * доверяет памяти `store`, может быть открыт раньше) - та же реальная
 * расшифровка тела, что и первый шаг `changeMasterPassword` выше. Возвращает
 * разобранный `header`, только когда пароль подтверждён, чтобы вызывающий
 * код (`enableOrChangePin`) мог переиспользовать соль/итерации базы для
 * `pinLock.setUpPin`, не читая и не разбирая файл повторно. Приватная функция
 * этого модуля (не экспортируется) - `changeMasterPassword` не переведена на
 * неё намеренно, чтобы не трогать уже проверенный, отдельно протестированный
 * код без необходимости (CLAUDE.md §4, "не делай несвязанных правок").
 */
async function verifyCurrentMasterPassword(
  vaultPath: string,
  password: string,
): Promise<{ ok: true; header: VaultHeader } | { ok: false }> {
  const diskBytes = await readVault(vaultPath);
  let header: VaultHeader;
  let ciphertext: Uint8Array;
  try {
    ({ header, ciphertext } = parseContainer(diskBytes));
  } catch (err) {
    if (err instanceof FormatError) return { ok: false };
    throw err;
  }
  const key = await deriveKey(password, base64ToBytes(header.kdf.salt), header.kdf.params.iterations);
  try {
    await decrypt(key, base64ToBytes(header.iv), ciphertext);
  } catch (err) {
    if (err instanceof DecryptError) return { ok: false };
    throw err;
  }
  return { ok: true, header };
}

/**
 * Включить или изменить PIN (задание: "Включение и изменение ТРЕБУЮТ
 * повторного ввода текущего мастер-пароля") - проверка идёт по реальному
 * файлу на диске (`verifyCurrentMasterPassword`), тот же принцип, что у
 * `changeMasterPassword`. При успехе строит новую `PinWrap`
 * (`pinLock.setUpPin`) той же солью/итерациями, что в заголовке базы на
 * диске, и записывает её в `vault.settings.json` вместе со сбросом
 * `pinLockout` (включение/изменение PIN - разумная точка обнулить лимит
 * неверных попыток, старый счётчик относился к прежнему PIN).
 */
export async function enableOrChangePin(params: {
  vaultPath: string;
  masterPassword: string;
  pin: string;
  pinConfirm: string;
}): Promise<PinToggleResult> {
  const { vaultPath, masterPassword, pin, pinConfirm } = params;
  if (!isValidPinFormat(pin)) {
    return { ok: false, message: PIN_TOGGLE_FORMAT_ERROR_MESSAGE };
  }
  if (pin !== pinConfirm) {
    return { ok: false, message: PIN_TOGGLE_MISMATCH_MESSAGE };
  }

  const verified = await verifyCurrentMasterPassword(vaultPath, masterPassword);
  if (!verified.ok) {
    return { ok: false, message: PIN_TOGGLE_PASSWORD_ERROR_MESSAGE };
  }

  const salt = base64ToBytes(verified.header.kdf.salt);
  const wrap = await setUpPin(masterPassword, salt, verified.header.kdf.params.iterations, pin);
  await updateSettings(vaultPath, { pin: wrap, pinLockout: resetPinLockout() });
  return { ok: true };
}

/**
 * Выключить PIN (задание: "Выключение PIN - тоже за мастер-паролем (не за
 * самим PIN - иначе кто угодно с PIN сможет его же и отключить)"). Просто
 * сброс `pin`/`pinLockout` - PIN, если пользователь позже захочет, настраивается
 * заново (та же логика, что и после смены мастер-пароля выше).
 */
export async function disablePin(params: { vaultPath: string; masterPassword: string }): Promise<PinToggleResult> {
  const verified = await verifyCurrentMasterPassword(params.vaultPath, params.masterPassword);
  if (!verified.ok) {
    return { ok: false, message: PIN_TOGGLE_PASSWORD_ERROR_MESSAGE };
  }
  await updateSettings(params.vaultPath, { pin: undefined, pinLockout: undefined });
  return { ok: true };
}

/** Перевод таймаута между минутами (что видит пользователь) и миллисекундами
 * (что хранится в `vault.settings.json`, схема из interfaces.md). Минимум -
 * 1 минута: таймаут 0 или отрицательный не имеет смысла (мгновенная
 * блокировка не запрашивалась брифом), пустое/некорректное поле трактуется
 * как минимум, а не как ошибка ввода - меньше сюрпризов, чем блокирующая
 * валидация на простом числовом поле. */
function minutesToMs(minutes: number): number {
  return Math.max(1, Math.round(minutes)) * 60_000;
}

function msToMinutes(ms: number): number {
  return Math.max(1, Math.round(ms / 60_000));
}

export interface SettingsProps {
  /** Текущий открытый стор - нужен для смены мастер-пароля (interfaces.md:
   * "Ему нужен доступ к VaultStore для смены мастер-пароля"). */
  store: VaultStore;
  /** Путь к файлу базы - определяет, где лежит `vault.settings.json`
   * (`<каталог базы>/vault.settings.json`, та же схема, что и в
   * useAutoLock.ts). */
  vaultPath: string;
  /**
   * Мастер-пароль успешно изменён - `store` больше не тот, что был передан
   * в пропсах (ключ старого стора больше не соответствует файлу на диске).
   * Вызывающий код обязан заменить активный стор этим новым объектом.
   */
  onPasswordChanged: (store: VaultStore, vaultPath: string) => void;
  /**
   * Новый таймаут автоблокировки уже записан в `vault.settings.json`
   * (миллисекунды). Живое применение без перезапуска - забота вызывающего
   * кода (см. комментарий модуля выше про тикет 12/useAutoLock).
   */
  onAutoLockTimeoutChange?: (autoLockTimeoutMs: number) => void;
  /** Закрыть экран настроек и вернуться к списку. */
  onClose: () => void;
  /**
   * Состояние базы, доступное только для чтения. Переехало сюда из нижней
   * полосы, удалённой 17.08.2026: это справочные числа, на которые смотрят
   * изредка, а постоянная полоса под них занимала место на каждом экране.
   */
  storageState?: {
    itemsCount: number;
    lastBackupAt: Date | null;
    autoLockRemainingMs: number;
    appVersion: string;
  };
  /**
   * Импорт и экспорт. Отдан слотом, а не перенесён внутрь этого файла: вся
   * логика подтверждения, отката и сохранения завязана на store и на модалку
   * уменьшения числа записей, и тащить её сюда значило бы размазать один
   * сценарий по двум файлам.
   */
  importExportSlot?: ReactNode;
}

export function Settings({
  store,
  vaultPath,
  onPasswordChanged,
  onAutoLockTimeoutChange,
  onClose,
  storageState,
  importExportSlot,
}: SettingsProps) {
  // --- смена мастер-пароля ---
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordChanged, setPasswordChanged] = useState(false);

  // --- таймаут автоблокировки ---
  const [autoLockMinutes, setAutoLockMinutes] = useState(() => msToMinutes(DEFAULT_AUTO_LOCK_TIMEOUT_MS));
  const [timeoutBusy, setTimeoutBusy] = useState(false);
  const [timeoutError, setTimeoutError] = useState<string | null>(null);
  const [timeoutSaved, setTimeoutSaved] = useState(false);

  // --- путь к базе ---
  const [pathInput, setPathInput] = useState(vaultPath);
  const [pathBusy, setPathBusy] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [pathSaved, setPathSaved] = useState(false);

  // --- вход по PIN ---
  const [pinConfigured, setPinConfigured] = useState(false);
  const [pinMasterPassword, setPinMasterPassword] = useState("");
  const [pinValue, setPinValue] = useState("");
  const [pinConfirmValue, setPinConfirmValue] = useState("");
  const [pinBusy, setPinBusy] = useState(false);
  const [pinError, setPinError] = useState<string | null>(null);
  const [pinStatusMessage, setPinStatusMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readSettings(vaultPath).then((settings) => {
      if (cancelled) return;
      setAutoLockMinutes(msToMinutes(settings.autoLockTimeoutMs));
      setPinConfigured(Boolean(settings.pin));
    });
    setPathInput(vaultPath);
    return () => {
      cancelled = true;
    };
  }, [vaultPath]);

  async function handleChangePassword(e: FormEvent) {
    e.preventDefault();
    if (passwordBusy) return;
    setPasswordError(null);
    setPasswordChanged(false);
    if (newPassword !== confirmPassword) {
      setPasswordError(PASSWORD_MISMATCH_MESSAGE);
      return;
    }
    setPasswordBusy(true);
    try {
      const result = await changeMasterPassword({ store, vaultPath, currentPassword, newPassword });
      if (result.ok) {
        setCurrentPassword("");
        setNewPassword("");
        setConfirmPassword("");
        setPasswordChanged(true);
        // changeMasterPassword всегда сбрасывает pin/pinLockout на диске
        // (см. её комментарий) - синхронизируем локальное состояние раздела
        // "Вход по PIN" сразу же, не дожидаясь следующего маунта/смены
        // vaultPath (тот же путь к файлу не меняется сменой пароля, поэтому
        // useEffect на [vaultPath] здесь сам по себе не перечитает
        // vault.settings.json). Без этого кнопка ниже ошибочно продолжала бы
        // называться "Изменить PIN" вместо "Включить PIN" сразу после смены
        // пароля, хотя PIN уже фактически сброшен.
        setPinConfigured(false);
        onPasswordChanged(result.store, vaultPath);
      } else {
        setPasswordError(result.message);
      }
    } catch (err) {
      console.error("Settings: unexpected error while changing the master password", err);
      setPasswordError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setPasswordBusy(false);
    }
  }

  async function handleSaveTimeout(e: FormEvent) {
    e.preventDefault();
    if (timeoutBusy) return;
    setTimeoutError(null);
    setTimeoutSaved(false);
    setTimeoutBusy(true);
    try {
      const ms = minutesToMs(autoLockMinutes);
      await updateSettings(vaultPath, { autoLockTimeoutMs: ms });
      setTimeoutSaved(true);
      onAutoLockTimeoutChange?.(ms);
    } catch (err) {
      console.error("Settings: failed to save autoLockTimeoutMs", err);
      setTimeoutError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setTimeoutBusy(false);
    }
  }

  async function handleSavePath(e: FormEvent) {
    e.preventDefault();
    if (pathBusy || pathInput.trim() === "") return;
    setPathError(null);
    setPathSaved(false);
    setPathBusy(true);
    try {
      await updateSettings(vaultPath, { lastVaultPath: pathInput.trim() });
      setPathSaved(true);
    } catch (err) {
      console.error("Settings: failed to save lastVaultPath", err);
      setPathError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setPathBusy(false);
    }
  }

  /** Включить или изменить PIN - требует текущий мастер-пароль (задание:
   * тот же принцип разделения "мастер-пароль для смены доступов, PIN для
   * входа"). Общее поле мастер-пароля (`pinMasterPassword`) обслуживает и
   * эту кнопку, и "Выключить PIN" ниже - обе операции требуют одного и того
   * же подтверждения. */
  async function handleEnableOrChangePin(e: FormEvent) {
    e.preventDefault();
    if (pinBusy) return;
    setPinError(null);
    setPinStatusMessage(null);
    setPinBusy(true);
    try {
      const wasConfigured = pinConfigured;
      const result = await enableOrChangePin({
        vaultPath,
        masterPassword: pinMasterPassword,
        pin: pinValue,
        pinConfirm: pinConfirmValue,
      });
      if (result.ok) {
        setPinConfigured(true);
        setPinMasterPassword("");
        setPinValue("");
        setPinConfirmValue("");
        setPinStatusMessage(wasConfigured ? "PIN обновлён" : "PIN включён");
      } else {
        setPinError(result.message);
      }
    } catch (err) {
      console.error("Settings: unexpected error while enabling/changing the PIN", err);
      setPinError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setPinBusy(false);
    }
  }

  /** Выключить PIN - тоже за мастер-паролем, не за самим PIN (задание: "иначе
   * кто угодно с PIN сможет его же и отключить"). Не форма (нет своего
   * submit) - использует то же поле мастер-пароля, что и включение/изменение
   * выше, отдельная кнопка внутри общей формы. */
  async function handleDisablePin() {
    if (pinBusy) return;
    setPinError(null);
    setPinStatusMessage(null);
    setPinBusy(true);
    try {
      const result = await disablePin({ vaultPath, masterPassword: pinMasterPassword });
      if (result.ok) {
        setPinConfigured(false);
        setPinMasterPassword("");
        setPinValue("");
        setPinConfirmValue("");
        setPinStatusMessage("PIN выключен");
      } else {
        setPinError(result.message);
      }
    } catch (err) {
      console.error("Settings: unexpected error while disabling the PIN", err);
      setPinError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setPinBusy(false);
    }
  }

  /** R89: Esc закрывает открытое - здесь это сам экран настроек, тот же
   * переход, что и клик по "×". Настройки не копят несохранённый черновик
   * (каждое поле сохраняется своей собственной кнопкой), поэтому закрытие
   * не нуждается в диалоге подтверждения, в отличие от Editor.tsx. */
  function handleSettingsKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key === "Escape") {
      onClose();
    }
  }

  return (
    <section className="settings" onKeyDown={handleSettingsKeyDown}>
      <header className="settings__header">
        <h1 className="settings__title">Настройки</h1>
        <button type="button" className="settings__close-btn" aria-label="Закрыть" onClick={onClose}>
          ×
        </button>
      </header>

      <div className="settings__body">
        <form className="settings__section" onSubmit={handleChangePassword}>
          <h2 className="settings__section-title">Мастер-пароль</h2>
          <label className="settings__label" htmlFor="settings-current-password">
            Текущий пароль
          </label>
          <PasswordField
            id="settings-current-password"
            inputClassName="settings__input"
            value={currentPassword}
            onChange={setCurrentPassword}
            disabled={passwordBusy}
          />
          <label className="settings__label" htmlFor="settings-new-password">
            Новый пароль
          </label>
          <PasswordField
            id="settings-new-password"
            inputClassName="settings__input"
            value={newPassword}
            onChange={setNewPassword}
            disabled={passwordBusy}
          />
          <label className="settings__label" htmlFor="settings-confirm-password">
            Повторите новый пароль
          </label>
          <PasswordField
            id="settings-confirm-password"
            inputClassName="settings__input"
            value={confirmPassword}
            onChange={setConfirmPassword}
            disabled={passwordBusy}
          />
          <div className="settings__row">
            <button
              type="submit"
              className="settings__submit"
              disabled={
                passwordBusy ||
                currentPassword.length === 0 ||
                newPassword.length === 0 ||
                confirmPassword.length === 0
              }
            >
              {passwordBusy ? "Меняю пароль..." : "Сменить пароль"}
            </button>
            <span className="settings__status" aria-live="polite">
              {passwordChanged ? "Пароль изменён" : ""}
            </span>
          </div>
          {passwordError && (
            <p className="settings__error" role="alert">
              {passwordError}
            </p>
          )}
        </form>

        <form className="settings__section" onSubmit={handleSaveTimeout}>
          <h2 className="settings__section-title">Автоблокировка</h2>
          <label className="settings__label" htmlFor="settings-timeout-minutes">
            Таймаут бездействия, минут
          </label>
          <input
            id="settings-timeout-minutes"
            type="number"
            min={1}
            className="settings__input settings__input--narrow"
            value={autoLockMinutes}
            onChange={(e) => setAutoLockMinutes(Number(e.currentTarget.value) || 1)}
            disabled={timeoutBusy}
          />
          <div className="settings__row">
            <button type="submit" className="settings__submit" disabled={timeoutBusy}>
              {timeoutBusy ? "Сохраняю таймаут..." : "Сохранить таймаут"}
            </button>
            <span className="settings__status" aria-live="polite">
              {timeoutSaved ? "Таймаут сохранён" : ""}
            </span>
          </div>
          {timeoutError && (
            <p className="settings__error" role="alert">
              {timeoutError}
            </p>
          )}
        </form>

        <form className="settings__section" onSubmit={handleSavePath}>
          <h2 className="settings__section-title">Путь к базе</h2>
          <label className="settings__label" htmlFor="settings-vault-path">
            Путь к файлу базы
          </label>
          <input
            id="settings-vault-path"
            type="text"
            className="settings__input"
            value={pathInput}
            onChange={(e) => setPathInput(e.currentTarget.value)}
            disabled={pathBusy}
          />
          <p className="settings__hint">
            Приложение не переносит файл базы само - перенесите vault.dat и папку backups/
            в новое место вручную, затем сохраните путь здесь.
          </p>
          <div className="settings__row">
            <button type="submit" className="settings__submit" disabled={pathBusy || pathInput.trim() === ""}>
              {pathBusy ? "Сохраняю путь..." : "Сохранить путь"}
            </button>
            <span className="settings__status" aria-live="polite">
              {pathSaved ? "Путь сохранён - изменения вступят в силу при следующем запуске" : ""}
            </span>
          </div>
          {pathError && (
            <p className="settings__error" role="alert">
              {pathError}
            </p>
          )}
        </form>

        <form className="settings__section" onSubmit={handleEnableOrChangePin}>
          <h2 className="settings__section-title">Вход по PIN</h2>
          <p className="settings__hint">
            {pinConfigured
              ? "PIN настроен и используется для повседневного входа. Изменение и выключение требуют текущего мастер-пароля."
              : "PIN-код позволяет открывать уже созданную базу без мастер-пароля при следующих запусках. Настройка требует текущего мастер-пароля."}
          </p>
          <label className="settings__label" htmlFor="settings-pin-master-password">
            Текущий мастер-пароль
          </label>
          <PasswordField
            id="settings-pin-master-password"
            inputClassName="settings__input"
            value={pinMasterPassword}
            onChange={setPinMasterPassword}
            disabled={pinBusy}
          />
          <label className="settings__label" htmlFor="settings-pin-value">
            {pinConfigured ? "Новый PIN-код" : "PIN-код"}
          </label>
          <PasswordField
            id="settings-pin-value"
            inputMode="numeric"
            maxLength={PIN_MAX_LENGTH}
            className="settings__field--narrow"
            inputClassName="settings__input"
            value={pinValue}
            onChange={(next) => setPinValue(next.replace(/\D/g, ""))}
            disabled={pinBusy}
          />
          <label className="settings__label" htmlFor="settings-pin-confirm">
            Повторите PIN-код
          </label>
          <PasswordField
            id="settings-pin-confirm"
            inputMode="numeric"
            maxLength={PIN_MAX_LENGTH}
            className="settings__field--narrow"
            inputClassName="settings__input"
            value={pinConfirmValue}
            onChange={(next) => setPinConfirmValue(next.replace(/\D/g, ""))}
            disabled={pinBusy}
          />
          <div className="settings__row">
            <button
              type="submit"
              className="settings__submit"
              disabled={
                pinBusy || pinMasterPassword.length === 0 || pinValue.length === 0 || pinConfirmValue.length === 0
              }
            >
              {pinBusy ? "Сохраняю PIN..." : pinConfigured ? "Изменить PIN" : "Включить PIN"}
            </button>
            {pinConfigured && (
              <button
                type="button"
                className="settings__submit"
                onClick={() => void handleDisablePin()}
                disabled={pinBusy || pinMasterPassword.length === 0}
              >
                Выключить PIN
              </button>
            )}
            <span className="settings__status" aria-live="polite">
              {pinStatusMessage ?? ""}
            </span>
          </div>
          {pinError && (
            <p className="settings__error" role="alert">
              {pinError}
            </p>
          )}
        </form>

        {/*
          Импорт и экспорт. Стоит после всего редактируемого и перед справкой:
          это действие с базой целиком, самое опасное на экране, и ему не место
          в одном ряду с полем таймаута.
        */}
        {importExportSlot && (
          <section className="settings__block">
            <h2 className="settings__section-title">Резервная копия и обмен данными</h2>
            {importExportSlot}
          </section>
        )}

        {/*
          Состояние базы - только для чтения, поэтому идёт ПОСЛЕДНИМ.
          Порядок экрана: сначала то, что меняют, потом то, на что смотрят.
          Раньше эти четыре числа жили в постоянной нижней полосе на каждом
          экране; смотрят на них изредка, а место они занимали всегда.
        */}
        {storageState && (
          <section className="settings__block">
            <h2 className="settings__section-title">Состояние базы</h2>
            <dl className="settings__facts">
              <div className="settings__fact">
                <dt>Записей</dt>
                <dd>{storageState.itemsCount}</dd>
              </div>
              <div className="settings__fact">
                <dt>Резервная копия</dt>
                <dd>{formatBackupAge(storageState.lastBackupAt)}</dd>
              </div>
              <div className="settings__fact">
                <dt>До автоблокировки</dt>
                <dd>{formatRemaining(storageState.autoLockRemainingMs)}</dd>
              </div>
              <div className="settings__fact">
                <dt>Версия приложения</dt>
                <dd>{storageState.appVersion}</dd>
              </div>
            </dl>
          </section>
        )}
      </div>
    </section>
  );
}

/**
 * Возраст резервной копии словами. Своя маленькая копия, а не общий хелпер -
 * тот же принцип, что уже принят в проекте для `dirOf`/`joinPath`
 * (см. комментарии в vaultStore.ts): каждый модуль держит свою.
 *
 * Отдельно важно, что это НЕ переиспользование `App.formatRelativeTime`:
 * та функция под шестью assert'ами в App.test.ts, и объединение внезапно
 * поставило бы формулировки этого экрана под чужие тесты.
 */
export function formatBackupAge(lastBackupAt: Date | null, now: Date = new Date()): string {
  if (!lastBackupAt) return "ещё не было";
  const minutes = Math.floor((now.getTime() - lastBackupAt.getTime()) / 60000);
  if (minutes < 1) return "только что";
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  return `${Math.floor(hours / 24)} дн назад`;
}

/** Остаток до автоблокировки в виде M:SS. */
export function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
