/**
 * Своя строка заголовка окна.
 *
 * Нативная рамка убрана (`decorations: false` в `tauri.conf.json`) по решению
 * пользователя от 17.08.2026. Это разворот прежнего решения проекта «нативную
 * рамку не трогаем»: сначала безрамочным задумывалось только всплывающее окно
 * быстрого доступа, но раз оно безрамочное, а главное окно с системным
 * заголовком - это два разных приложения на вид. Дизайн должен быть один.
 *
 * Полоса намеренно прозрачная и без подложки. На экране входа под ней рисуется
 * канвас с сетью и проступающий из темноты логотип; любая плашка сверху
 * превратила бы этот экран в окно с шапкой. Кнопки при этом видно всегда, а не
 * только по наведению: невидимые органы управления окном - это ребус, а не
 * минимализм.
 *
 * Перетаскивание отдано атрибуту `data-tauri-drag-region`, кнопки лежат
 * ОТДЕЛЬНО от него: внутри области перетаскивания нажатие уводится в
 * перетаскивание окна и до кнопки не доходит.
 *
 * Закрытие идёт через `close()`, а НЕ через `destroy()`. Разница
 * принципиальная: `close()` порождает событие `close-requested`, которое
 * перехватывает `App.tsx` (спрашивает про несохранённые изменения и только
 * потом зовёт `destroy()`). Прямой `destroy()` отсюда обошёл бы этот вопрос и
 * потерял бы правки.
 */
import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { PinIcon } from "./icons";
import "./TitleBar.css";

const ON_TOP_LABEL = "Открепить от переднего плана";
const OFF_TOP_LABEL = "Закрепить поверх других окон";
const MINIMIZE_LABEL = "Свернуть";
const MAXIMIZE_LABEL = "Развернуть";
const RESTORE_LABEL = "Восстановить";
const CLOSE_LABEL = "Закрыть";

export function TitleBar() {
  const [maximized, setMaximized] = useState(false);
  /**
   * Окно поверх остальных. По умолчанию включено (`alwaysOnTop` в
   * `tauri.conf.json`) по просьбе пользователя от 17.08.2026: при переносе
   * паролей окно постоянно скрывалось под браузером, и каждый пароль стоил
   * лишнего переключения.
   *
   * Состояние не переживает перезапуск намеренно: настройки живут в
   * `vault.settings.json` рядом с базой, а рамка окна рисуется до того, как
   * база вообще открыта, и её пути не знает. Приложение всегда стартует
   * закреплённым, а снять закрепление это один щелчок.
   */
  const [onTop, setOnTop] = useState(true);

  // Кнопка разворота должна показывать актуальное состояние: окно можно
  // развернуть и мимо неё - двойным щелчком по полосе, Win+Стрелка вверх,
  // перетаскиванием к верхнему краю.
  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let alive = true;

    void (async () => {
      try {
        setMaximized(await win.isMaximized());
        const off = await win.onResized(() => {
          void win.isMaximized().then((value) => {
            if (alive) setMaximized(value);
          });
        });
        if (alive) unlisten = off;
        else off();
      } catch (err) {
        console.error("TitleBar: не удалось подписаться на изменение размера окна", err);
      }
    })();

    return () => {
      alive = false;
      unlisten?.();
    };
  }, []);

  async function toggleOnTop() {
    const next = !onTop;
    try {
      await getCurrentWindow().setAlwaysOnTop(next);
      setOnTop(next);
    } catch (err) {
      console.error("TitleBar: не удалось изменить закрепление окна поверх остальных", err);
    }
  }

  async function run(action: "minimize" | "toggle" | "close") {
    const win = getCurrentWindow();
    try {
      if (action === "minimize") await win.minimize();
      else if (action === "toggle") await win.toggleMaximize();
      else await win.close();
    } catch (err) {
      console.error(`TitleBar: не удалось выполнить действие окна «${action}»`, err);
    }
  }

  return (
    <div className="title-bar">
      {/* Двойной щелчок по полосе разворачивает окно - это делает сам Tauri
          для области перетаскивания, отдельного обработчика не нужно. */}
      <div className="title-bar__drag" data-tauri-drag-region />
      <div className="title-bar__controls">
        <button
          type="button"
          className={"title-bar__btn" + (onTop ? " title-bar__btn--on" : "")}
          onClick={() => void toggleOnTop()}
          aria-pressed={onTop}
          aria-label={onTop ? ON_TOP_LABEL : OFF_TOP_LABEL}
          title={onTop ? ON_TOP_LABEL : OFF_TOP_LABEL}
        >
          <PinIcon filled={onTop} size={13} />
        </button>
        <button
          type="button"
          className="title-bar__btn"
          onClick={() => void run("minimize")}
          aria-label={MINIMIZE_LABEL}
          title={MINIMIZE_LABEL}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 5h10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
        <button
          type="button"
          className="title-bar__btn"
          onClick={() => void run("toggle")}
          aria-label={maximized ? RESTORE_LABEL : MAXIMIZE_LABEL}
          title={maximized ? RESTORE_LABEL : MAXIMIZE_LABEL}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <path d="M2.5 2.5V0.5h7v7h-2" stroke="currentColor" strokeWidth="1" />
              <rect x="0.5" y="2.5" width="7" height="7" stroke="currentColor" strokeWidth="1" />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" aria-hidden="true">
              <rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" />
            </svg>
          )}
        </button>
        <button
          type="button"
          className="title-bar__btn title-bar__btn--close"
          onClick={() => void run("close")}
          aria-label={CLOSE_LABEL}
          title={CLOSE_LABEL}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
          </svg>
        </button>
      </div>
    </div>
  );
}
