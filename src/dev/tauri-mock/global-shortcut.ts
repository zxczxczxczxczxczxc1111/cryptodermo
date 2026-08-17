/**
 * Подмена `@tauri-apps/plugin-global-shortcut` для режима `--mode mock`.
 *
 * Зарегистрировать сочетание на всю систему из вкладки браузера нельзя, и
 * притворяться, что получилось, вредно: проверка в заглушке показала бы
 * работающую функцию там, где её нет. Поэтому регистрация честно отказывает, а
 * приложение обязано это пережить (см. `useGlobalHotkey`).
 */
export async function register(shortcut: string, _handler: unknown): Promise<void> {
  throw new Error(`mock: глобальное сочетание «${shortcut}» в браузере недоступно`);
}

export async function unregister(_shortcut: string): Promise<void> {}

export async function isRegistered(_shortcut: string): Promise<boolean> {
  return false;
}
