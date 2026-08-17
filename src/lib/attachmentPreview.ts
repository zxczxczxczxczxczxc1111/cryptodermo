/**
 * Что из вложения можно безопасно показать прямо в карточке записи.
 *
 * Это менеджер паролей, поэтому решение принимается не «что браузер умеет
 * нарисовать», а «что нельзя превратить в способ выполнить чужой код или
 * утащить содержимое базы». Отсюда белый список вместо чёрного: неизвестный
 * тип показывается как обычная строка с кнопками, а не «попробуем отрисовать».
 *
 * ЧТО РАЗРЕШЕНО И ПОЧЕМУ:
 *
 * - **Растровые картинки** (png, jpeg, gif, webp, avif, bmp, ico). Рисуются в
 *   `<img>` из `data:`-URL. Ни скриптов, ни внешних запросов такой тег не
 *   выполняет.
 *
 * - **SVG - ЗАПРЕЩЁН НАМЕРЕННО.** Формально `<img>` рендерит SVG в защищённом
 *   статическом режиме, где скрипты не выполняются. Но это гарантия одного
 *   конкретного тега: стоит кому-нибудь позже поменять `<img>` на `<object>`,
 *   `<embed>` или вставку разметкой - и появится исполнение чужого кода
 *   внутри приложения, которое держит все пароли в памяти. Цена ошибки
 *   несоразмерна удобству, поэтому SVG показывается строкой, как файл.
 *
 * - **Простой текст** (text/plain и родственные). Вставляется как
 *   `textContent`, а не как разметка. HTML, XML и прочее размеченное сюда НЕ
 *   входит: показывать их как текст бессмысленно, а как разметку - опасно.
 *
 * - **PDF - запрещён.** Требует `<iframe>`/`<embed>` со встроенным просмотрщиком,
 *   то есть целый парсер чужого формата внутри окна с секретами.
 *
 * Функции чистые и без DOM - их можно проверить тестом (см. рядом лежащий
 * `attachmentPreview.test.ts`).
 */

/** Типы картинок, которые безопасно показать в `<img>`. */
const PREVIEWABLE_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/bmp",
  "image/x-icon",
  "image/vnd.microsoft.icon",
]);

/** Типы, которые безопасно показать как простой текст. */
const PREVIEWABLE_TEXT_TYPES = new Set([
  "text/plain",
  "text/csv",
  "text/markdown",
  "text/x-markdown",
  "application/json",
]);

/**
 * Насколько большой файл вообще имеет смысл разворачивать.
 *
 * Ограничение не про безопасность, а про здравый смысл: вложение хранится
 * в base64 в памяти, и превращать десять мегабайт в `data:`-URL ради
 * картинки, которую всё равно видно кусочком, незачем.
 */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

/** Сколько символов текста показывать в свёрнутом виде. */
export const TEXT_PREVIEW_MAX_CHARS = 600;

export type PreviewKind = "image" | "text" | "none";

/**
 * Что можно показать для этого вложения.
 *
 * `mimeType` приводится к нижнему регистру и очищается от параметров вида
 * `; charset=utf-8` - иначе `text/plain; charset=utf-8` не совпал бы со
 * списком и предпросмотр молча не работал бы для половины текстовых файлов.
 */
export function previewKindFor(mimeType: string, sizeBytes: number): PreviewKind {
  if (sizeBytes > PREVIEW_MAX_BYTES) return "none";
  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (PREVIEWABLE_IMAGE_TYPES.has(type)) return "image";
  if (PREVIEWABLE_TEXT_TYPES.has(type)) return "text";
  return "none";
}

/** `data:`-URL для картинки. Данные вложения уже хранятся в base64. */
export function imageDataUrl(mimeType: string, base64Data: string): string {
  const type = mimeType.split(";")[0].trim().toLowerCase();
  return `data:${type};base64,${base64Data}`;
}

/**
 * Раскодировать текстовое вложение для показа.
 *
 * Возвращает `null`, если содержимое не разбирается: base64 может быть битым,
 * а файл с расширением `.txt` - на деле двоичным. Молча показать мусор хуже,
 * чем не показать ничего.
 */
export function decodeTextPreview(base64Data: string): string | null {
  try {
    const binary = atob(base64Data);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    // `fatal: true` - именно то, ради чего всё: на двоичных данных декодер
    // бросит исключение вместо гирлянды символов подстановки.
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text;
  } catch {
    return null;
  }
}

/** Обрезать текст для свёрнутого вида, не разрывая последнее слово посередине. */
export function truncateForPreview(text: string, maxChars: number = TEXT_PREVIEW_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  const cut = text.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > maxChars * 0.6 ? cut.slice(0, lastSpace) : cut) + "…";
}

/**
 * Короткая подсказка у кнопки прикрепления.
 *
 * Намеренно НЕ перечисляет форматы списком: длинный перечень у кнопки читают
 * ровно ноль человек, а занимает он три строки. Задача - снять недоумение
 * заранее («почему одно открывается, а другое нет»), подробности приходят
 * потом и по месту - см. `previewUnavailableReason`.
 */
export function previewSupportHint(maxAttachmentBytes: number): string {
  const mb = Math.round(maxAttachmentBytes / (1024 * 1024));
  return `Любой формат, до ${mb} МБ. Картинки и текстовые файлы открываются прямо здесь, остальные скачиваются.`;
}

/**
 * Почему у ЭТОГО вложения нет предпросмотра.
 *
 * Показывается на самой строке вложения, а не общей справкой сверху: человек
 * спрашивает «почему не открывается» глядя на конкретный файл, и ответ должен
 * быть там же. Причины две и они разные по смыслу - формат нельзя показать в
 * принципе, а слишком большой файл можно было бы, но не стоит.
 *
 * `null` означает, что предпросмотр есть и объяснять нечего.
 */
export function previewUnavailableReason(
  mimeType: string,
  sizeBytes: number,
): string | null {
  if (previewKindFor(mimeType, sizeBytes) !== "none") return null;

  // Порядок проверок важен: если файл и большой, и неподходящего формата,
  // честнее назвать формат - размер уменьшить можно, формат нет.
  const previewableIfSmall = previewKindFor(mimeType, 0) !== "none";
  if (previewableIfSmall) {
    const mb = Math.round(PREVIEW_MAX_BYTES / (1024 * 1024));
    return `Слишком большой для предпросмотра (больше ${mb} МБ) - скачайте, чтобы открыть.`;
  }

  const type = mimeType.split(";")[0].trim().toLowerCase();
  if (type === "image/svg+xml" || type === "application/pdf") {
    // Эти два не «не поддерживаются», а запрещены осознанно, и человек имеет
    // право знать разницу: иначе это выглядит как недоделка.
    return "Этот формат не открывается в приложении из соображений безопасности - скачайте, чтобы открыть.";
  }
  return "Предпросмотр для этого формата недоступен - скачайте, чтобы открыть.";
}
