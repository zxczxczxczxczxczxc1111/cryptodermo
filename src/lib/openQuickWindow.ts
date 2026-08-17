/**
 * Создание и показ маленького окна быстрого доступа.
 *
 * Окно создаётся ОДИН РАЗ и дальше только прячется и показывается: создание
 * webview стоит заметно дороже показа, а сочетание нажимают по многу раз за
 * день, и разница видна.
 *
 * Создаётся оно СКРЫТЫМ. Показывается только после того, как содержимое
 * отрисовалось и запросило список (событие `quick:ready`), иначе на долю
 * секунды видна пустая рамка - ровно тот рывок, из-за которого появление
 * выглядит дешёвым.
 */
import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { once } from "@tauri-apps/api/event";
import { QUICK_WINDOW_LABEL, QUICK_EVENTS } from "./quickBridge";

const WIDTH = 560;
const HEIGHT = 420;

/** Сколько ждать готовности окна, прежде чем показать его всё равно. Страховка
 * от того, что событие потерялось: лучше показать окно чуть раньше, чем не
 * показать вовсе. */
const READY_TIMEOUT_MS = 700;

export async function openQuickWindow(): Promise<void> {
  try {
    const existing = await WebviewWindow.getByLabel(QUICK_WINDOW_LABEL);
    if (existing) {
      await existing.show();
      await existing.center();
      await existing.setFocus();
      return;
    }

    const win = new WebviewWindow(QUICK_WINDOW_LABEL, {
      url: "index.html",
      width: WIDTH,
      height: HEIGHT,
      resizable: false,
      decorations: false,
      alwaysOnTop: true,
      center: true,
      // Своей кнопки на панели задач у всплывающего окна быть не должно: это
      // не второе приложение, а временный слой поверх работы.
      skipTaskbar: true,
      // Показ - вручную, после готовности содержимого.
      visible: false,
      transparent: true,
    });

    const shown = new Promise<void>((resolve) => {
      void once(QUICK_EVENTS.ready, () => resolve());
      setTimeout(resolve, READY_TIMEOUT_MS);
    });
    await shown;
    await win.show();
    await win.setFocus();
  } catch (err) {
    console.error("openQuickWindow: не удалось открыть окно быстрого доступа", err);
  }
}
