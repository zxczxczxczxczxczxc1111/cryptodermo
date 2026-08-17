/**
 * Открыть адрес в браузере, которым человек пользуется.
 *
 * Обёртка над `@tauri-apps/plugin-opener` в одном месте, а не вызовы по всему
 * коду - по той же причине, по которой в проекте одна точка `invoke()`: когда
 * плагин однажды сменится, править придётся один файл.
 *
 * Открываются ТОЛЬКО `http` и `https`. Проверка не формальность: в поле записи
 * лежит произвольная строка, введённая человеком или пришедшая из импорта, а
 * системный обработчик умеет открывать и `file:`, и всё, что зарегистрировано
 * в Windows под свою схему. Отдать такую строку операционной системе значит
 * позволить содержимому базы запускать посторонние программы.
 */
import { openUrl } from "@tauri-apps/plugin-opener";

/** Похоже ли значение поля на веб-адрес, который стоит предложить открыть. */
export function isOpenableUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!/^https?:\/\//i.test(trimmed)) return false;
  try {
    const url = new URL(trimmed);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Открыть адрес. Возвращает `false`, если адрес не подошёл или открыть не
 * удалось - вызывающий код показывает это человеку, а не молчит. */
export async function openExternal(value: string): Promise<boolean> {
  if (!isOpenableUrl(value)) return false;
  try {
    await openUrl(value.trim());
    return true;
  } catch (err) {
    console.error("openExternal: не удалось открыть адрес во внешнем браузере", err);
    return false;
  }
}
