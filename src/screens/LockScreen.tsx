/**
 * Экран блокировки/создания базы (тикет 06, R47/R74/R75/R94.1/R95/R95.1).
 *
 * Один экран для обоих случаев - различаются наличием `vault.dat` по текущему
 * пути (`checkExistingVault` ниже). Компонент сам по себе - тонкая обвязка
 * состояния формы вокруг трёх экспортированных async-функций
 * (`submitUnlock`/`submitCreate`/`submitRecovery`), в которых сосредоточена
 * вся значимая логика. Разделение сделано намеренно: в проекте нет
 * DOM-окружения для тестов (jsdom/happy-dom не установлены, устанавливать
 * новую зависимость без отдельного вопроса пользователю нельзя - R31), а
 * значит компонент нельзя отрендерить в автотесте. Три функции ниже -
 * обычный async-код без JSX/хуков, их можно и нужно проверить unit-тестами
 * напрямую (см. `LockScreen.test.ts`) - это и есть "шов", о котором просит
 * тикет: "проверяй через факт вызова onUnlock с корректным VaultStore".
 * Сам JSX-компонент (вёрстка, состояние формы) проверен глазами и сборкой
 * (`tsc`/`vite build`), не автотестом - см. отчёт по тикету.
 */
import { useEffect, useState, type FormEvent, type KeyboardEvent } from "react";
import { VaultStore } from "../lib/vaultStore";
import { DecryptError } from "../lib/crypto";
import { FormatError } from "../lib/vaultFormat";
import { readVault, type BackupInfo } from "../lib/tauriApi";
import "../tokens.css";
import "./LockScreen.css";

/** Единый текст ошибки на неверный пароль/битый файл - AES-GCM не различает
 * эти два случая криптографически (R94.1), дословно из брифа/ticket. */
export const UNLOCK_ERROR_MESSAGE = "Не удалось открыть базу: неверный пароль или файл повреждён";

/** Текст на неожиданный сбой записи при создании новой базы - не сама
 * DecryptError/FormatError (эти два кейса относятся только к открытию
 * существующей базы), а ошибка файлового слоя (диск занят, нет прав и т.п.). */
export const CREATE_SAVE_ERROR_MESSAGE =
  "Не удалось сохранить базу по этому пути. Проверьте, что каталог доступен для записи, и попробуйте снова";

/** Статичный текстовый индикатор процесса деривации ключа (R75) - на месте
 * будущей canvas-анимации (тикет 13, спецификация §16) сейчас просто текст,
 * без спиннера и прогресс-бара, дословно из брифа. */
export const DERIVING_LABEL = "Проверяю...";

/** Текст на неожиданную ошибку (не DecryptError/FormatError и не сбой
 * записи при создании - у обоих есть свой текст выше), которую компонент не
 * пытается интерпретировать - см. правило "не изобретай поведение для
 * неизвестного сбоя" (CLAUDE.md §1). R85 - без "Произошла ошибка". */
export const UNEXPECTED_ERROR_MESSAGE =
  "Не удалось выполнить операцию. Попробуйте ещё раз";

/**
 * Опечатка в новом мастер-пароле при СОЗДАНИИ базы не видна сразу (в отличие
 * от разблокировки, где неверный пароль тут же выдаёт себя отказом
 * расшифровки) - для офлайн-хранилища с приоритетом "данные не теряются"
 * это риск необратимой блокировки. Решение оркестратора (2026-08-16): поле
 * повтора пароля только в ветке создания, тот же текст и в подсказке под
 * полем, и в возвращаемой ошибке `submitCreate` (защита на обоих уровнях -
 * кнопка неактивна, пока поля не совпадают, но и сама функция проверяет это
 * заново, а не полагается только на UI). */
export const PASSWORD_MISMATCH_MESSAGE = "Пароли не совпадают";

/**
 * Есть ли уже файл базы по данному пути - определяет режим экрана
 * (разблокировка/создание, R95). Любая ошибка чтения (файла нет, нет прав и
 * т.п.) трактуется как "файла ещё нет" - тот же принцип, что и в
 * `VaultStore.save()` (см. комментарий там же): различать конкретную причину
 * не задача этого экрана, а Rust-команда не даёт для этого структурированной
 * информации.
 */
export async function checkExistingVault(vaultPath: string): Promise<Uint8Array | null> {
  try {
    return await readVault(vaultPath);
  } catch {
    return null;
  }
}

export type SubmitResult = { ok: true } | { ok: false; message: string };

/**
 * Попытка разблокировать существующую базу. Единственная точка, где вызывается
 * `onUnlock` в сценарии "верный пароль на существующей базе" - критерий
 * приёмки проверяется тестом именно на этом вызове (`LockScreen.test.ts`).
 *
 * `DecryptError`/`FormatError` от `VaultStore.loadFromBytes` превращаются в
 * единый текст (R94.1); любая другая ошибка не подменяется и уходит наверх -
 * выдумывать для неё текст не задача этой функции (см. правило "не
 * изобретай поведение").
 */
export async function submitUnlock(params: {
  existingBytes: Uint8Array;
  password: string;
  vaultPath: string;
  onUnlock: (store: VaultStore, vaultPath: string) => void;
}): Promise<SubmitResult> {
  const store = new VaultStore();
  try {
    await store.loadFromBytes(params.existingBytes, params.password);
  } catch (err) {
    if (err instanceof DecryptError || err instanceof FormatError) {
      return { ok: false, message: UNLOCK_ERROR_MESSAGE };
    }
    throw err;
  }
  params.onUnlock(store, params.vaultPath);
  return { ok: true };
}

/**
 * Создать новую базу и сразу сохранить её на диск (иначе после создания без
 * единой правки `vault.dat` физически не появится, и при следующем запуске
 * экран снова показал бы режим создания вместо разблокировки). Вызывающий
 * код (компонент) обязан заранее убедиться через свежий
 * `checkExistingVault`, что по этому пути ещё ничего нет - здесь этой
 * проверки нет намеренно: "определить" и "сделать" - разные ответственности,
 * компонент делает выбор (создавать или показать диалог конфликта, R95.1) до
 * вызова этой функции. Эта перепроверка закрывает только меньшую часть
 * гонки: самое большое окно - `deriveKey` внутри `createNewVault` (намеренно
 * ~0.5-1с) между перепроверкой и записью на диск - остаётся принятым
 * остаточным риском, не гарантией отсутствия конфликта.
 *
 * `passwordConfirm` проверяется ПЕРВЫМ делом, до `createNewVault`/`save` -
 * несовпадение не создаёт ни стор, ни файл на диске (см. тест "does not
 * create a vault..." в `LockScreen.test.ts`). Это подстраховка на уровне
 * функции поверх отключённой в UI кнопки - опечатка в новом мастер-пароле
 * иначе осталась бы незамеченной (в отличие от разблокировки, где неверный
 * пароль сразу выдаёт себя отказом расшифровки).
 */
export async function submitCreate(params: {
  vaultPath: string;
  password: string;
  passwordConfirm: string;
  onUnlock: (store: VaultStore, vaultPath: string) => void;
}): Promise<SubmitResult> {
  if (params.password !== params.passwordConfirm) {
    return { ok: false, message: PASSWORD_MISMATCH_MESSAGE };
  }
  const store = new VaultStore();
  await store.createNewVault(params.password);
  try {
    await store.save(params.vaultPath);
  } catch (err) {
    console.error("LockScreen: failed to persist newly created vault", err);
    return { ok: false, message: CREATE_SAVE_ERROR_MESSAGE };
  }
  params.onUnlock(store, params.vaultPath);
  return { ok: true };
}

/**
 * Восстановление после повреждения (R114i) - открыть конкретный файл бэкапа
 * тем же паролем. `vaultPath` в колбэке - путь к основной базе (не к файлу
 * бэкапа): следующий обычный save() должен писать в `vault.dat`, а не
 * перезаписывать сам бэкап (см. комментарий `loadFromBackupFile` в
 * vaultStore.ts - открытие бэкапа не заменяет боевой файл автоматически).
 */
export async function submitRecovery(params: {
  backupPath: string;
  password: string;
  vaultPath: string;
  onUnlock: (store: VaultStore, vaultPath: string) => void;
}): Promise<SubmitResult> {
  const store = new VaultStore();
  try {
    await store.loadFromBackupFile(params.backupPath, params.password);
  } catch (err) {
    if (err instanceof DecryptError || err instanceof FormatError) {
      return { ok: false, message: UNLOCK_ERROR_MESSAGE };
    }
    throw err;
  }
  params.onUnlock(store, params.vaultPath);
  return { ok: true };
}

export interface LockScreenProps {
  /** Путь к файлу базы. Экран сам определяет разблокировку/создание по
   * наличию файла на этом пути (R95). */
  vaultPath: string;
  /**
   * Вызывается после успешной расшифровки существующей базы или создания
   * новой - это и есть событие "открывает список записей" (сам список
   * подключит другой тикет). Второй аргумент - путь, с которым в итоге
   * связан стор: как правило равен исходному `vaultPath`, но может
   * отличаться, если пользователь во время создания выбрал другое
   * расположение (сценарий "здесь уже есть база", R95.1).
   */
  onUnlock: (store: VaultStore, vaultPath: string) => void;
  /**
   * Необязательный запрос другого пути при конфликте создания (R95.1,
   * "выбрать другое место"). Если не передан, экран сам предлагает ввести
   * путь текстовым полем - минимальная рабочая версия без диалога ОС:
   * `@tauri-apps/plugin-dialog` предусмотрен спецификацией для этого сценария,
   * но не установлен ни в одном предыдущем тикете, а устанавливать новую
   * зависимость вне явного запроса пользователя - не в зоне этого тикета
   * (R31). Когда диалог появится, эту функцию достаточно передать пропом, не
   * трогая остальной компонент.
   */
  onPickAlternatePath?: () => Promise<string | null>;
}

type Phase = "checking" | "unlock" | "create" | "conflict";

export function LockScreen({ vaultPath, onUnlock, onPickAlternatePath }: LockScreenProps) {
  const [activePath, setActivePath] = useState(vaultPath);
  const [phase, setPhase] = useState<Phase>("checking");
  const [existingBytes, setExistingBytes] = useState<Uint8Array | null>(null);
  const [password, setPassword] = useState("");
  // Только для ветки создания (R95.1-смежное решение оркестратора,
  // 2026-08-16) - на разблокировке существующей базы повтор не нужен,
  // ошибку и так сразу показывает отказ расшифровки.
  const [passwordConfirm, setPasswordConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [backups, setBackups] = useState<BackupInfo[]>([]);
  const [altPathInput, setAltPathInput] = useState(vaultPath);

  useEffect(() => {
    let cancelled = false;
    setPhase("checking");
    setError(null);
    setBackups([]);
    checkExistingVault(activePath).then((bytes) => {
      if (cancelled) return;
      if (bytes !== null) {
        setExistingBytes(bytes);
        setPhase("unlock");
      } else {
        setExistingBytes(null);
        setPhase("create");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [activePath]);

  async function handleUnlockSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy || existingBytes === null) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitUnlock({
        existingBytes,
        password,
        vaultPath: activePath,
        onUnlock,
      });
      if (!result.ok) {
        setError(result.message);
        const recoveryList = await VaultStore.listBackupsForRecovery(activePath).catch(() => []);
        setBackups(recoveryList);
      }
    } catch (err) {
      console.error("LockScreen: unexpected error while unlocking", err);
      setError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function handleRecoverClick() {
    if (busy || backups.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const result = await submitRecovery({
        backupPath: backups[0].path,
        password,
        vaultPath: activePath,
        onUnlock,
      });
      if (!result.ok) {
        setError(result.message);
      }
    } catch (err) {
      console.error("LockScreen: unexpected error while recovering from a backup", err);
      setError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateSubmit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const freshBytes = await checkExistingVault(activePath);
      if (freshBytes !== null) {
        // Кто-то успел создать файл по этому пути между первичной проверкой
        // и отправкой формы (R95.1) - перезаписи без выбора нет.
        setExistingBytes(freshBytes);
        setPhase("conflict");
        return;
      }
      const result = await submitCreate({
        vaultPath: activePath,
        password,
        passwordConfirm,
        onUnlock,
      });
      if (!result.ok) {
        setError(result.message);
      }
    } catch (err) {
      console.error("LockScreen: unexpected error while creating a new vault", err);
      setError(UNEXPECTED_ERROR_MESSAGE);
    } finally {
      setBusy(false);
    }
  }

  async function handleUseAlternatePath() {
    if (onPickAlternatePath) {
      const picked = await onPickAlternatePath();
      if (picked) {
        setActivePath(picked);
      }
      return;
    }
    if (altPathInput.trim() !== "") {
      setActivePath(altPathInput.trim());
    }
  }

  function handleConflictKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      setPhase("create");
      setExistingBytes(null);
    }
  }

  // Подсказка показывается только когда пользователь уже начал вводить
  // повтор (не сразу на пустом поле - иначе она мигала бы при каждом первом
  // символе). Кнопка "Создать" неактивна, пока оба поля не совпадают -
  // решение оркестратора от 2026-08-16 (см. PASSWORD_MISMATCH_MESSAGE).
  const passwordsMismatch = passwordConfirm.length > 0 && password !== passwordConfirm;
  const createDisabled =
    busy || password.length === 0 || passwordConfirm.length === 0 || passwordsMismatch;

  return (
    <div className="lock-screen">
      <div className="lock-screen__panel">
        {phase === "checking" && (
          <p className="lock-screen__status" role="status">
            {DERIVING_LABEL}
          </p>
        )}

        {phase === "unlock" && (
          <form className="lock-screen__form" onSubmit={handleUnlockSubmit}>
            <label className="lock-screen__label" htmlFor="lock-screen-password">
              Мастер-пароль
            </label>
            <input
              id="lock-screen-password"
              type="password"
              className="lock-screen__input"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              disabled={busy}
            />
            <button
              type="submit"
              className="lock-screen__submit"
              disabled={busy || password.length === 0}
            >
              {busy ? DERIVING_LABEL : "Открыть"}
            </button>
            {error && (
              <div className="lock-screen__error" role="alert">
                <p>{error}</p>
                {backups.length > 0 && (
                  <button
                    type="button"
                    className="lock-screen__recover"
                    onClick={handleRecoverClick}
                    disabled={busy}
                  >
                    Открыть последнюю рабочую копию
                  </button>
                )}
              </div>
            )}
          </form>
        )}

        {phase === "create" && (
          <form className="lock-screen__form" onSubmit={handleCreateSubmit}>
            <label className="lock-screen__label" htmlFor="lock-screen-password">
              Новый мастер-пароль
            </label>
            <input
              id="lock-screen-password"
              type="password"
              className="lock-screen__input"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              autoFocus
              disabled={busy}
            />
            <label className="lock-screen__label" htmlFor="lock-screen-password-confirm">
              Повторите пароль
            </label>
            <input
              id="lock-screen-password-confirm"
              type="password"
              className="lock-screen__input"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.currentTarget.value)}
              disabled={busy}
            />
            {passwordsMismatch && (
              <p className="lock-screen__hint" role="alert">
                {PASSWORD_MISMATCH_MESSAGE}
              </p>
            )}
            <button type="submit" className="lock-screen__submit" disabled={createDisabled}>
              {busy ? DERIVING_LABEL : "Создать"}
            </button>
            {error && (
              <p className="lock-screen__error" role="alert">
                {error}
              </p>
            )}
          </form>
        )}

        {phase === "conflict" && (
          <div className="lock-screen__conflict" onKeyDown={handleConflictKeyDown}>
            <p>Здесь уже есть база: открыть её или выбрать другое место.</p>
            <div className="lock-screen__conflict-actions">
              <button type="button" onClick={() => setPhase("unlock")}>
                Открыть
              </button>
              {!onPickAlternatePath && (
                <>
                  <label htmlFor="lock-screen-alt-path">Другой путь к файлу базы</label>
                  <input
                    id="lock-screen-alt-path"
                    className="lock-screen__input"
                    value={altPathInput}
                    onChange={(e) => setAltPathInput(e.currentTarget.value)}
                  />
                </>
              )}
              <button type="button" onClick={handleUseAlternatePath}>
                Выбрать другое место
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
