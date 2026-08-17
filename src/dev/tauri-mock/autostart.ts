/**
 * Подмена `@tauri-apps/plugin-autostart` для режима `--mode mock`.
 *
 * Записать себя в автозапуск Windows из вкладки браузера нельзя. Заглушка
 * держит состояние в памяти, чтобы можно было проверить сам интерфейс
 * (переключатель, подписи, порядок вызовов), но честно забывает его при
 * перезагрузке страницы - иначе легко решить, что настройка работает.
 */
let enabled = false;

export async function enable(): Promise<void> {
  enabled = true;
  console.info("mock: autostart.enable() - в браузере ничего не происходит");
}

export async function disable(): Promise<void> {
  enabled = false;
  console.info("mock: autostart.disable() - в браузере ничего не происходит");
}

export async function isEnabled(): Promise<boolean> {
  return enabled;
}
