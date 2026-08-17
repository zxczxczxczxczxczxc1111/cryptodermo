/**
 * Подмена `@tauri-apps/plugin-opener` для режима `--mode mock`.
 *
 * В браузере ссылку можно открыть по-настоящему - `window.open` делает ровно
 * то же, что плагин делает в приложении. Это редкий случай, когда заглушка
 * воспроизводит поведение честно, а не притворяется.
 */
export async function openUrl(url: string): Promise<void> {
  window.open(url, "_blank", "noopener,noreferrer");
}
