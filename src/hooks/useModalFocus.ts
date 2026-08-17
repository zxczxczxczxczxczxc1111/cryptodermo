/**
 * Управление фокусом в модальных окнах.
 *
 * Найдено проверкой по Web Interface Guidelines 17.08.2026: во всех шести
 * модалках проекта фокусом не управлял никто. Escape обрабатывался, разметка
 * была правильной (`role="dialog"`, `aria-modal`, `aria-labelledby`), но фокус
 * оставался на кнопке ПОД затемнением, и Tab уводил в фоновое содержимое.
 * То есть с клавиатуры диалог можно было «обойти», не закрывая: человек
 * продолжал переключаться по списку записей сквозь модальное окно.
 *
 * Хук делает три вещи, ровно те, которых не хватало:
 *   1. запоминает, что было в фокусе до открытия, и возвращает фокус туда при
 *      закрытии - иначе после диалога фокус улетает в начало документа;
 *   2. переводит фокус внутрь диалога при открытии;
 *   3. замыкает Tab и Shift+Tab внутри диалога.
 *
 * Escape намеренно НЕ обрабатывается здесь: он уже реализован у каждого
 * владельца модалки со своей логикой (у редактора закрытие диалога о
 * несохранённых изменениях не то же самое, что закрытие диалога об удалении).
 * Дублировать его тут значило бы получить два обработчика на одно событие.
 *
 * ВНИМАНИЕ: автотестами это НЕ покрыто и покрыто быть не может - в проекте нет
 * jsdom, а здесь всё завязано на живой DOM (`querySelectorAll`, `offsetParent`,
 * `document.activeElement`). Обычный для проекта приём «вынести чистую функцию
 * и проверить её» тут не спасает: чистой части, не касающейся DOM, у ловушки
 * фокуса просто нет.
 *
 * Проверено живым прогоном 17.08.2026 на диалоге удаления записи: фокус
 * уходит внутрь на «Отмена» (безопасный вариант, а не «Удалить»), три Tab
 * подряд остаются внутри диалога, Escape закрывает и возвращает фокус на
 * элемент, с которого диалог открыли. При правке этого файла прогон надо
 * повторить руками - иначе регрессия пройдёт молча.
 */
import { useEffect, type RefObject } from "react";

/** Что считается фокусируемым внутри диалога. Скрытые и выключенные элементы
 * исключены: попасть на них нельзя, а в цикле Tab они создавали бы паузу. */
const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "textarea:not([disabled])",
  "select:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(", ");

/**
 * Фокусируемые элементы внутри контейнера, в порядке обхода. Отдельная
 * экспортируемая функция, чтобы её можно было проверить тестом без DOM-рендера
 * React-компонента.
 */
export function focusableWithin(container: HTMLElement): HTMLElement[] {
  const found = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
  // `offsetParent === null` отсекает скрытые через display:none. Проверка
  // дешёвая и не требует getComputedStyle на каждый элемент.
  return found.filter((el) => el.offsetParent !== null || el === document.activeElement);
}

/**
 * Замкнуть фокус внутри диалога, пока `active`.
 *
 * @param ref контейнер диалога (элемент с `role="dialog"`)
 * @param active открыт ли диалог прямо сейчас
 */
export function useModalFocus(ref: RefObject<HTMLElement | null>, active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const container = ref.current;
    if (!container) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    // Первый фокусируемый элемент диалога, а не сам диалог: так человек сразу
    // на кнопке, а не в пустоте, из которой первый Tab уводит непонятно куда.
    const initial = focusableWithin(container)[0];
    initial?.focus();

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const focusable = focusableWithin(container);
      if (focusable.length === 0) {
        e.preventDefault();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const current = document.activeElement;

      // Фокус мог оказаться вне диалога (например, его увёл фоновый код) -
      // возвращаем его на край цикла, а не полагаемся на то, что он внутри.
      if (!container.contains(current)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
        return;
      }
      if (e.shiftKey && current === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && current === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      // Возврат фокуса туда, откуда пришли. `isConnected` - страховка на
      // случай, если элемент успел пропасть из документа, пока диалог был
      // открыт (например, запись удалили именно этим диалогом).
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [ref, active]);
}
