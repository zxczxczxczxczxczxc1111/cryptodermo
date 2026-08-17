/**
 * Буфер обмена с автоочисткой (R48, R48.1). Общая утилита, используемая
 * тикетом 06 (очистка при блокировке) и тикетом 07 (копирование значения
 * из карточки записи) - оба параллельных тикета опираются на этот контракт
 * вместо того, чтобы каждый изобретал свою версию.
 *
 * Секретное значение никогда не попадает в постоянное хранилище через этот
 * модуль - только в буфер обмена ОС, на ограниченное время.
 */

/** Через сколько буфер обмена очищается сам. Экспортируется: окно быстрого
 * доступа обязано дожить до этого момента, иначе очистка не сработает - см.
 * `QuickAccess.tsx`. */
export const CLIPBOARD_CLEAR_MS = 30000;
const DEFAULT_CLEAR_MS = CLIPBOARD_CLEAR_MS;

let clearTimer: ReturnType<typeof setTimeout> | null = null;
// true, пока в буфере обмена лежит значение, записанное этим модулем и ещё
// не очищенное - используется clearNow(), чтобы не стирать буфер, если там
// сейчас нечто, скопированное не этим приложением (R48.1 говорит именно про
// "значение, скопированное этим приложением").
let hasOwnValue = false;

/** Отменяет запланированный таймер автоочистки, если он ещё не сработал. */
function cancelPendingClear(): void {
  if (clearTimer !== null) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

/** Записывает пустую строку в буфер обмена - фактическая очистка. */
function clearClipboardNow(): void {
  navigator.clipboard
    .writeText("")
    .catch((err) => console.error("clipboard: не удалось очистить буфер обмена", err));
}

export async function copyWithAutoClear(
  value: string,
  ms: number = DEFAULT_CLEAR_MS,
): Promise<void> {
  cancelPendingClear();

  await navigator.clipboard.writeText(value);
  hasOwnValue = true;

  clearTimer = setTimeout(() => {
    clearTimer = null;
    hasOwnValue = false;
    clearClipboardNow();
  }, ms);
}

/**
 * Немедленная очистка буфера обмена - вызывается тикетом 06 при
 * автоблокировке (R48.1), чтобы не ждать штатные 30 секунд. Отменяет
 * запланированный таймер `copyWithAutoClear`, если он ещё не сработал.
 *
 * Ничего не делает, если сейчас в буфере нет значения, записанного этим
 * модулем - иначе автоблокировка стирала бы то, что пользователь скопировал
 * из другого приложения перед сворачиванием окна.
 */
export function clearNow(): void {
  cancelPendingClear();

  if (!hasOwnValue) {
    return;
  }

  hasOwnValue = false;
  clearClipboardNow();
}
