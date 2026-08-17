/**
 * Подмена `@tauri-apps/api/window` для режима `--mode mock` (см. `fs.ts`).
 *
 * Боевой код зовёт `destroy`, `isMinimized`, `onCloseRequested`, `onResized`
 * (`App.tsx`, `useAutoLock.ts`, `LockScreen.tsx`), а с появлением своей полосы
 * заголовка ещё и `minimize`, `toggleMaximize`, `close`, `isMaximized`
 * (`TitleBar.tsx`). Остальное не реализовано намеренно.
 *
 * Важное ограничение, которое надо помнить при проверке: настоящее поведение
 * окна здесь не воспроизводится. Закрытие по крестику, сворачивание и смена
 * размера нативного окна - это ровно тот класс багов, который в прошлый раз
 * прошёл мимо код-ревью и был найден только живым запуском. Заглушка их не
 * ловит и не претендует.
 */

type UnlistenFn = () => void;

class MockWindow {
  async destroy(): Promise<void> {
    console.info("mock: window.destroy() - в браузере окно не закрывается");
  }

  async isMinimized(): Promise<boolean> {
    return false;
  }

  /* Управление окном из своей полосы заголовка. В браузере всё это
     невыполнимо, но обязано не падать: без заглушек первый же рендер
     `TitleBar` уронил бы приложение на `isMaximized()`. */
  async isMaximized(): Promise<boolean> {
    return false;
  }

  async minimize(): Promise<void> {
    console.info("mock: window.minimize() - в браузере окно не сворачивается");
  }

  async toggleMaximize(): Promise<void> {
    console.info("mock: window.toggleMaximize() - в браузере окно не разворачивается");
  }

  async setAlwaysOnTop(value: boolean): Promise<void> {
    console.info(`mock: window.setAlwaysOnTop(${value}) - в браузере не применимо`);
  }

  async close(): Promise<void> {
    console.info("mock: window.close() - в браузере окно не закрывается");
  }

  async onCloseRequested(_handler: (event: unknown) => void): Promise<UnlistenFn> {
    // Событие в браузере не наступает никогда: вкладку закрывают мимо Tauri.
    return () => {};
  }

  async onResized(handler: () => void): Promise<UnlistenFn> {
    // Единственное, что можно воспроизвести честно: изменение размера окна
    // браузера. `isMinimized()` при этом всегда `false`, поэтому подписчик
    // (автоблокировка) до блокировки не дойдёт - это верно и по смыслу.
    const onResize = () => handler();
    window.addEventListener("resize", onResize, { passive: true });
    return () => window.removeEventListener("resize", onResize);
  }
}

const instance = new MockWindow();

export function getCurrentWindow(): MockWindow {
  return instance;
}
