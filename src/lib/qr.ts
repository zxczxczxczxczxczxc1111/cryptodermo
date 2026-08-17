/**
 * Построение QR-кода для передачи одного значения на телефон.
 *
 * Зачем это здесь: перенести пароль на iPhone иначе означает либо облако, либо
 * буфер обмена, либо мессенджер - то есть в любом случае третью сторону. QR
 * проходит по воздуху между экраном и камерой, не оставляя следа ни в сети, ни
 * в истории буфера обмена Windows.
 *
 * Кодировщик - `qrcode-generator` (MIT, один файл, ноль собственных
 * зависимостей). Установлен отдельным решением пользователя от 17.08.2026:
 * своя реализация Reed-Solomon и масок дала бы ноль выигрыша в безопасности
 * (QR - не криптография, а способ нарисовать байты) при вполне реальном шансе
 * ошибиться в математике.
 *
 * Наружу отсюда выходит МАТРИЦА, а не готовая картинка: библиотека умеет сама
 * рисовать `<img>`, `<table>` и data-URL, но все они приносят свои цвета,
 * растр и внешнюю разметку. Рисование остаётся за компонентом, который берёт
 * цвета из токенов и выдаёт векторный SVG - он одинаково чёткий и на 1920, и
 * на 2560.
 */
import qrcode from "qrcode-generator";

/** Уровень коррекции ошибок. `M` (около 15% восстановления) - обычный выбор
 * для экранного кода: `L` заметно хуже читается на бликующей матрице, `Q`/`H`
 * ради тех же данных дают более плотную сетку, а значит более мелкий модуль. */
const ERROR_CORRECTION: "L" | "M" | "Q" | "H" = "M";

/**
 * Предел длины на уровне `M` в байтовом режиме - версия 40 вмещает 2331 байт.
 * Проверка нужна не для красоты: без неё библиотека бросает собственную ошибку
 * с английским текстом прямо в обработчике клика.
 */
export const QR_MAX_INPUT_BYTES = 2331;

/** Значение не помещается в QR-код. Отдельный класс, чтобы вызывающий код
 * отличал «слишком длинно» от неожиданного сбоя и не подменял один текст
 * другим (общий принцип проекта - один тип ошибки на класс отказа). */
export class QrTooLongError extends Error {
  constructor(public readonly byteLength: number) {
    super(`QR: значение занимает ${byteLength} байт при пределе ${QR_MAX_INPUT_BYTES}`);
    this.name = "QrTooLongError";
  }
}

export interface QrMatrix {
  /** Сторона матрицы в модулях, без полей. Всегда нечётная: 21, 25, 29 ... */
  size: number;
  /** `true` - тёмный модуль. Первый индекс - строка. */
  modules: boolean[][];
}

/**
 * Байты UTF-8, разложенные по одному в символ.
 *
 * `qrcode-generator` в ESM-сборке кодирует строку по-простому: берёт младший
 * байт каждого кода символа. Для кириллицы это молча даёт мусор - «Пароль»
 * превратился бы в шесть произвольных байт, и телефон прочитал бы кракозябры.
 * Отдельный модуль UTF-8 из поставки библиотеки подключать не нужно: достаточно
 * закодировать строку самим и передать байты в том виде, в каком эта простая
 * функция их и оставит без изменений.
 */
function toLatin1OfUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let out = "";
  for (const byte of bytes) out += String.fromCharCode(byte);
  return out;
}

/** Длина значения в байтах UTF-8 - именно она упирается в предел, а не число
 * символов: одна кириллическая буква занимает два байта. */
export function qrByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Матрица QR-кода для строки. Версия подбирается автоматически (нулевой
 * `typeNumber`) - минимальная из тех, куда данные помещаются.
 */
export function buildQrMatrix(text: string): QrMatrix {
  const byteLength = qrByteLength(text);
  if (byteLength > QR_MAX_INPUT_BYTES) {
    throw new QrTooLongError(byteLength);
  }

  const qr = qrcode(0, ERROR_CORRECTION);
  qr.addData(toLatin1OfUtf8(text), "Byte");
  qr.make();

  const size = qr.getModuleCount();
  const modules: boolean[][] = [];
  for (let row = 0; row < size; row++) {
    const line: boolean[] = [];
    for (let col = 0; col < size; col++) {
      line.push(qr.isDark(row, col));
    }
    modules.push(line);
  }
  return { size, modules };
}

/**
 * Поля вокруг кода в модулях. Стандарт требует не меньше четырёх: без них
 * камера не отличает край кода от того, что нарисовано рядом.
 */
export const QR_QUIET_ZONE = 4;

export interface QrSvg {
  viewBox: string;
  /** Готовый `d` для одного `<path>`. */
  path: string;
}

/**
 * Один путь на весь код вместо тысячи прямоугольников.
 *
 * Матрица 41×41 - это 1681 модуль, и каждый отдельным элементом означал бы
 * столько же узлов DOM на одно открытие окна. Соседние тёмные модули в строке
 * при этом склеиваются в один горизонтальный отрезок, так что путь получается
 * заметно короче самой матрицы.
 */
export function qrSvgPath(matrix: QrMatrix, quietZone: number = QR_QUIET_ZONE): QrSvg {
  const side = matrix.size + quietZone * 2;
  const parts: string[] = [];

  for (let row = 0; row < matrix.size; row++) {
    let runStart = -1;
    for (let col = 0; col <= matrix.size; col++) {
      const dark = col < matrix.size && matrix.modules[row][col];
      if (dark && runStart === -1) {
        runStart = col;
      } else if (!dark && runStart !== -1) {
        const x = runStart + quietZone;
        const y = row + quietZone;
        parts.push(`M${x} ${y}h${col - runStart}v1h-${col - runStart}z`);
        runStart = -1;
      }
    }
  }

  return { viewBox: `0 0 ${side} ${side}`, path: parts.join("") };
}
