/**
 * Автоблокировка (тикет 06, R47/R47.1/R48.1/R79). Таймаут бездействия по
 * умолчанию + блокировка при сворачивании окна; перед снятием ключа из
 * памяти - автосохранение несохранённых правок без диалога, и немедленная
 * очистка буфера обмена.
 *
 * Значимая логика вынесена в две обычные async-функции без React и без DOM
 * (`readAutoLockTimeoutMs`, `performAutoLock`) - именно они проверены
 * unit-тестами (`useAutoLock.test.ts`). Сам хук `useAutoLock` - тонкая
 * обвязка вокруг них: таймер бездействия, слушатели активности и событие
 * сворачивания окна нельзя проверить в этом проекте автотестом (нет
 * jsdom/happy-dom и нет реального Tauri-рантайма в Vitest, а устанавливать
 * новую зависимость без отдельного вопроса пользователю нельзя, R31) -
 * проверено чтением кода и сборкой (`tsc`/`vite build`), см. отчёт по
 * тикету.
 */
import { useEffect, useRef, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { readVault } from "../lib/tauriApi";
import { clearNow } from "../lib/clipboard";
import { ItemCountDecreasedError, type VaultStore } from "../lib/vaultStore";

/** Дефолт из брифа (В5) - 5 минут бездействия, используется, когда
 * `vault.settings.json` ещё нет (валидное состояние) или поле в нём не
 * задано/некорректно. */
export const DEFAULT_AUTO_LOCK_TIMEOUT_MS = 300_000;

const SETTINGS_FILENAME = "vault.settings.json";

/** Каталог файла из полного пути - копия той же маленькой утилиты, что уже
 * есть в vaultStore.ts (см. её комментарий: между модулями это дублируется
 * умышленно, а не экспортируется, так решено в тикете 02/05). Понимает и
 * "/", и "\\" - база может лежать на Windows-пути. */
function dirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return idx === -1 ? "." : path.slice(0, idx);
}

/** Склеить каталог и имя файла тем же разделителем, что уже используется в
 * каталоге - та же логика, что в vaultStore.ts. */
function joinPath(dir: string, filename: string): string {
  if (dir === "" || dir === ".") return filename;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${filename}` : `${dir}${sep}${filename}`;
}

/** Путь к `vault.settings.json` для данной базы - `<каталог базы>/vault.settings.json`. */
function settingsPathFor(vaultPath: string): string {
  return joinPath(dirOf(vaultPath), SETTINGS_FILENAME);
}

/**
 * Прочитать `autoLockTimeoutMs` из `vault.settings.json` рядом с базой.
 * Отсутствие файла - валидное состояние (значение по умолчанию), как и любая
 * другая причина, по которой прочитать/разобрать его не вышло (битый JSON,
 * поле не число и т.п.) - эта функция никогда не бросает исключение наружу,
 * только возвращает дефолт. Владелец самой записи файла - другой тикет
 * (`settingsConfig.ts`, ещё не существует к моменту этой сборки) - здесь
 * только чтение одного числа, напрямую через `readVault` + `JSON.parse`, как
 * зафиксировано в interfaces.md.
 */
export async function readAutoLockTimeoutMs(vaultPath: string): Promise<number> {
  try {
    const bytes = await readVault(settingsPathFor(vaultPath));
    const text = new TextDecoder("utf-8").decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed === "object" && parsed !== null && "autoLockTimeoutMs" in parsed) {
      const value = (parsed as Record<string, unknown>).autoLockTimeoutMs;
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        return value;
      }
    }
    return DEFAULT_AUTO_LOCK_TIMEOUT_MS;
  } catch {
    return DEFAULT_AUTO_LOCK_TIMEOUT_MS;
  }
}

/**
 * Что происходит непосредственно в момент автоблокировки (R47.1/R48.1),
 * дословный порядок из брифа:
 * 1. если есть несохранённые изменения - сохранить их, без диалога
 *    подтверждения (диалог, который некому увидеть до блокировки, не
 *    защищает данные);
 * 2. очистить буфер обмена немедленно (`clearNow()` сам по себе не трогает
 *    буфер, если там сейчас не значение этого приложения - см. clipboard.ts);
 * 3. вызвать `onLock()` - сигнал вызывающему коду уронить ссылку на
 *    `VaultStore` (это и есть "снять ключ из памяти": сам `VaultStore` не
 *    даёт явного метода "забыть ключ", ключ уходит вместе со сборкой мусора
 *    после того, как последняя ссылка на стор пропадает).
 *
 * Неудача автосохранения (диск занят и т.п.) не отменяет блокировку -
 * блокировать всё равно нужно (сворачивание/бездействие уже произошло,
 * показать диалог с ошибкой некому), ошибка только логируется. Это
 * компромисс между приоритетом 1 ("данные не теряются") и требованием
 * автоблокировки без диалога - явно отмечен как решение тикета, не
 * недосмотр.
 *
 * Отдельно - R28 (`ItemCountDecreasedError` из vaultStore.ts): если число
 * записей уменьшилось с последней успешной загрузки/сохранения, обычный
 * `save()` отказывается писать на диск без явного `{ allowCountDecrease:
 * true }`. Диалог "было N, стало M" здесь показать некому (решение
 * оркестратора 2026-08-16) - сохранение только что сделанных пользователем
 * правок важнее самой защиты R28 в этой конкретной ситуации, поэтому такая
 * ошибка перехватывается и `save()` повторяется с подтверждением
 * автоматически, без попытки спросить.
 */
export async function performAutoLock(params: {
  store: VaultStore;
  vaultPath: string;
  onLock: () => void;
}): Promise<void> {
  const { store, vaultPath, onLock } = params;
  if (store.isDirty()) {
    try {
      await store.save(vaultPath);
    } catch (err) {
      if (err instanceof ItemCountDecreasedError) {
        console.error(
          `useAutoLock: R28 сработал при автосохранении перед блокировкой - было ${err.loaded}, ` +
            `стало ${err.current}, сохраняю повторно с allowCountDecrease`,
          err,
        );
        try {
          await store.save(vaultPath, { allowCountDecrease: true });
        } catch (retryErr) {
          console.error(
            "useAutoLock: повторное автосохранение с allowCountDecrease тоже не удалось",
            retryErr,
          );
        }
      } else {
        console.error("useAutoLock: автосохранение перед блокировкой не удалось", err);
      }
    }
  }
  clearNow();
  onLock();
}

/** Активность пользователя, которая сбрасывает таймер бездействия. */
const ACTIVITY_EVENTS = ["mousedown", "mousemove", "keydown", "wheel", "touchstart"] as const;

/** Как часто пересчитывается остаток времени до блокировки (показывается в
 * разделе «Состояние базы» настроек). */
const TICK_MS = 1000;

export interface UseAutoLockParams {
  /** Текущий открытый стор, или `null`, если приложение ещё не разблокировано
   * / уже заблокировано - хук в этом случае неактивен (никаких таймеров и
   * подписок). */
  store: VaultStore | null;
  /** Путь к файлу базы - нужен и для автосохранения, и для чтения
   * `vault.settings.json`. Синхронен с `store`: `null` тогда и только тогда,
   * когда `store === null`. */
  vaultPath: string | null;
  /** Вызывается ПОСЛЕ автосохранения (если были несохранённые изменения) и
   * очистки буфера обмена - сигнал уронить ссылку на `store` и показать
   * экран блокировки. */
  onLock: () => void;
}

export interface UseAutoLockResult {
  /** Сколько миллисекунд осталось до автоблокировки - для
   * раздела «Состояние базы» в настройках. */
  remainingMs: number;
}

/**
 * Хук автоблокировки. Активен только когда есть и `store`, и `vaultPath` -
 * вызывающий код (App.tsx, тикет 12) передаёт их только после успешного
 * `onUnlock` из `LockScreen`.
 *
 * Сигнал "окно свёрнуто" - `onResized()` + `isMinimized()` (спецификация §6:
 * оба кандидата - `onResized` и `document.visibilitychange` - не
 * подтверждены документацией как канонический способ на Windows, решение
 * фиксируется здесь). Выбран `onResized` + прямая проверка `isMinimized()`,
 * а не `onFocusChanged` - последний срабатывает на любую потерю фокуса
 * (например, Alt+Tab на другое окно без сворачивания), что заблокировало бы
 * приложение куда агрессивнее, чем просит бриф ("блокировка... при
 * сворачивании окна", не "при потере фокуса").
 */
export function useAutoLock({ store, vaultPath, onLock }: UseAutoLockParams): UseAutoLockResult {
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  const [remainingMs, setRemainingMs] = useState(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  const lastActivityRef = useRef(Date.now());
  const lockingRef = useRef(false);

  // Последние store/vaultPath/onLock в ref, чтобы срабатывание таймера
  // всегда било по актуальному стору, не по значению на момент установки
  // таймера (store - новый объект на каждый addItem/updateItem не нужен, но
  // ссылка должна быть свежей).
  const latestRef = useRef({ store, vaultPath, onLock });
  latestRef.current = { store, vaultPath, onLock };

  // 1) Прочитать таймаут из vault.settings.json один раз при разблокировке.
  useEffect(() => {
    if (!store || !vaultPath) {
      setTimeoutMs(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
      return;
    }
    let cancelled = false;
    readAutoLockTimeoutMs(vaultPath).then((ms) => {
      if (!cancelled) setTimeoutMs(ms);
    });
    return () => {
      cancelled = true;
    };
  }, [store, vaultPath]);

  // 2) Таймер бездействия + подписка на сворачивание окна.
  useEffect(() => {
    if (!store || !vaultPath) {
      setRemainingMs(timeoutMs);
      return;
    }

    lastActivityRef.current = Date.now();
    setRemainingMs(timeoutMs);

    const registerActivity = () => {
      lastActivityRef.current = Date.now();
    };
    ACTIVITY_EVENTS.forEach((evt) => window.addEventListener(evt, registerActivity, { passive: true }));

    const triggerLock = () => {
      if (lockingRef.current) return;
      const current = latestRef.current;
      if (!current.store || !current.vaultPath) return;
      lockingRef.current = true;
      performAutoLock({ store: current.store, vaultPath: current.vaultPath, onLock: current.onLock }).finally(
        () => {
          lockingRef.current = false;
        },
      );
    };

    const interval = setInterval(() => {
      const left = Math.max(timeoutMs - (Date.now() - lastActivityRef.current), 0);
      setRemainingMs(left);
      if (left <= 0) {
        triggerLock();
      }
    }, TICK_MS);

    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    getCurrentWindow()
      .onResized(async () => {
        try {
          if (await getCurrentWindow().isMinimized()) {
            triggerLock();
          }
        } catch {
          // Вне реального Tauri-рантайма (например, обычный `npm run dev`
          // без `tauri dev`) window-API недоступен - тихо игнорируем, это не
          // должно ломать таймер бездействия.
        }
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenResize = unlisten;
      })
      .catch(() => {
        // Как и выше - недоступность window-API вне Tauri не должна ронять
        // остальную автоблокировку.
      });

    return () => {
      disposed = true;
      clearInterval(interval);
      ACTIVITY_EVENTS.forEach((evt) => window.removeEventListener(evt, registerActivity));
      unlistenResize?.();
    };
  }, [store, vaultPath, timeoutMs]);

  return { remainingMs };
}
