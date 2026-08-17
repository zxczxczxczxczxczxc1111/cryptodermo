/**
 * Подмена `@tauri-apps/plugin-clipboard-manager` для режима `--mode mock`.
 *
 * В браузере доступен только `navigator.clipboard`, и он же объясняет, зачем в
 * приложении понадобился плагин: браузерный буфер требует фокуса документа и
 * отказывает без него. В панели предпросмотра это видно постоянно, поэтому
 * ошибка тут ожидаема и не означает поломки.
 */
export async function writeText(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}

export async function readText(): Promise<string> {
  return navigator.clipboard.readText();
}
