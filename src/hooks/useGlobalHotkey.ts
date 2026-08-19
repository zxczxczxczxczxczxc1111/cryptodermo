/**
 * Глобальное сочетание клавиш, вызывающее приложение из любого места системы.
 *
 * Работает, ПОКА ПРИЛОЖЕНИЕ ЗАПУЩЕНО - в этом весь смысл и в этом ограничение.
 * Сочетание регистрирует живой процесс; закрыли приложение - клавиши снова
 * принадлежат системе. Именно поэтому рядом живёт значок в трее: закрытие окна
 * можно настроить на сворачивание, и тогда процесс остаётся в памяти, а
 * сочетание продолжает работать. Если база успела заблокироваться сама,
 * маленькое окно спрашивает PIN у себя (см. `QuickWindow.tsx`).
 *
 * Регистрация может НЕ УДАСТЬСЯ, и это нормальный рабочий случай, а не сбой:
 * сочетание уже занято другой программой. Приложение обязано это пережить и
 * сказать об этом словами, а не молча делать вид, что всё зарегистрировано.
 * В заглушке для браузера регистрация отказывает всегда - там глобальных
 * клавиш нет в принципе.
 */
import { useEffect, useState } from "react";
import { register, unregister } from "@tauri-apps/plugin-global-shortcut";

/** Сочетание по умолчанию. Ctrl+Alt+C: Ctrl+Shift+C занят инструментами
 * разработчика почти во всех браузерах, а Ctrl+Alt свободнее. */
export const DEFAULT_HOTKEY = "CommandOrControl+Alt+C";

export type HotkeyState =
  | { kind: "off" }
  | { kind: "on"; shortcut: string }
  | { kind: "failed"; shortcut: string; message: string };

/**
 * Держит сочетание зарегистрированным, пока `enabled`.
 *
 * `onTrigger` намеренно НЕ в зависимостях эффекта: обработчик меняется на
 * каждый рендер, а перерегистрация глобального сочетания на каждый рендер -
 * это гонка, в которой клавиша периодически оказывается свободной. Вместо
 * этого свежий обработчик держится в изменяемой ссылке.
 */
export function useGlobalHotkey(
  enabled: boolean,
  shortcut: string,
  onTrigger: () => void,
): HotkeyState {
  const [state, setState] = useState<HotkeyState>({ kind: "off" });
  // Свежий обработчик без перерегистрации сочетания - см. комментарий у хука.
  const onTriggerRef = useLatest(onTrigger);

  useEffect(() => {
    if (!enabled) {
      setState({ kind: "off" });
      return;
    }
    let alive = true;
    let registered = false;

    void (async () => {
      try {
        await register(shortcut, (event) => {
          // Плагин присылает и нажатие, и отпускание. Без фильтра окно
          // выходило бы вперёд дважды на одно нажатие.
          if (event.state !== "Pressed") return;
          onTriggerRef.current();
        });
        if (!alive) {
          void unregister(shortcut);
          return;
        }
        registered = true;
        setState({ kind: "on", shortcut });
      } catch (err) {
        console.error("useGlobalHotkey: не удалось зарегистрировать сочетание", err);
        if (alive) {
          setState({
            kind: "failed",
            shortcut,
            message: "Сочетание занято другой программой",
          });
        }
      }
    })();

    return () => {
      alive = false;
      if (registered) void unregister(shortcut);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, shortcut]);

  return state;
}

/** Ссылка, всегда указывающая на последнее значение. Маленький хелпер вместо
 * зависимости от библиотеки - в проекте принято держать такие копии у себя. */
function useLatest<T>(value: T): { current: T } {
  const [ref] = useState(() => ({ current: value }));
  ref.current = value;
  return ref;
}
