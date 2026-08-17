/**
 * Подмена `@tauri-apps/api/window` для режима `--mode mock` (см. `fs.ts`).
 *
 * Боевой код зовёт ровно четыре метода: `destroy`, `isMinimized`,
 * `onCloseRequested`, `onResized` (`App.tsx:403`, `useAutoLock.ts:250`,
 * `LockScreen.tsx:1073`). Остальное не реализовано намеренно.
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
