import { useState, type KeyboardEvent } from "react";
import "./PasswordGenerator.css";

/**
 * Генератор паролей (R49, spec.md §10): длина, наборы символов (строчные/
 * заглавные/цифры/спецсимволы) чекбоксами, кнопка "Вставить в поле".
 * "Простой" дословно по брифу (В7 - "да, простой. Длина, наборы символов,
 * кнопка «вставить в поле»") - без индикатора силы пароля, без шаблонов,
 * без гарантии "минимум по одному символу из каждого набора": равномерный
 * случайный выбор из объединённого алфавита выбранных наборов - самый
 * прямолинейный вариант, который всё ещё честно использует весь запрошенный
 * состав, не более (Правило 4 - не решать незапрошенную задачу).
 *
 * Этот компонент не знает, в какое поле редактора класть результат - это
 * знает только Editor (какое поле было в фокусе на момент открытия
 * генератора, см. Editor.tsx), поэтому наружу выставлен только
 * `onInsert(password)` без побочных эффектов на DOM за пределами себя же.
 */

export type PasswordGeneratorOptions = {
  length: number;
  lowercase: boolean;
  uppercase: boolean;
  digits: boolean;
  symbols: boolean;
};

export const PASSWORD_GENERATOR_DEFAULTS: PasswordGeneratorOptions = {
  length: 16,
  lowercase: true,
  uppercase: true,
  digits: true,
  symbols: true,
};

/** Границы слайдера длины - не названы в брифе (В7 говорит только "длина"),
 * craft-решение тикета 08: достаточно широкий диапазон и для короткого PIN,
 * и для длинного пароля. */
export const MIN_LENGTH = 4;
export const MAX_LENGTH = 64;

const LOWERCASE_CHARS = "abcdefghijklmnopqrstuvwxyz";
const UPPERCASE_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGIT_CHARS = "0123456789";
const SYMBOL_CHARS = "!@#$%^&*()-_=+[]{};:,.<>?/~";

/** Ни один набор символов не выбран - генерировать не из чего. */
export class NoCharsetSelectedError extends Error {
  constructor() {
    super("Password generator: at least one character set must be selected");
    this.name = "NoCharsetSelectedError";
  }
}

/**
 * Равномерный случайный индекс в [0, maxExclusive) через
 * `crypto.getRandomValues` с отбраковкой значений сверх последнего полного
 * блока диапазона (rejection sampling) - без неё `value % maxExclusive`
 * слегка искажает распределение (modulo bias). Пароли - чувствительные
 * данные (см. interfaces.md, тикет 08), поэтому не `Math.random()` и не
 * приближённая арифметика, тот же принцип, что и в `crypto.ts`/
 * `vaultStore.ts` (случайная соль/IV/id тоже только через `crypto.*`).
 */
function randomIndex(maxExclusive: number): number {
  const MAX_UINT32 = 0xffffffff;
  // MAX_UINT32 - (MAX_UINT32 % maxExclusive) даёт accepted-диапазон размера
  // MAX_UINT32 - (MAX_UINT32 % m) + 1, который не кратен m (перекос на одно
  // значение в пользу остатка 0) - всего значений в uint32 ровно MAX_UINT32
  // + 1 (2^32), поэтому кратно maxExclusive именно (MAX_UINT32 + 1) % m,
  // отброшенное от верхней границы.
  const limit = MAX_UINT32 - ((MAX_UINT32 + 1) % maxExclusive);
  const buf = new Uint32Array(1);
  let value: number;
  do {
    crypto.getRandomValues(buf);
    value = buf[0];
  } while (value > limit);
  return value % maxExclusive;
}

function buildAlphabet(options: PasswordGeneratorOptions): string {
  let alphabet = "";
  if (options.lowercase) alphabet += LOWERCASE_CHARS;
  if (options.uppercase) alphabet += UPPERCASE_CHARS;
  if (options.digits) alphabet += DIGIT_CHARS;
  if (options.symbols) alphabet += SYMBOL_CHARS;
  return alphabet;
}

/**
 * Сгенерировать пароль заданной длины и состава. Бросает
 * `NoCharsetSelectedError`, если ни один набор символов не включён, и
 * `RangeError`, если длина не целое положительное число. Чистая функция -
 * не трогает DOM, вынесена отдельно от компонента специально ради
 * тестируемости без окружения с DOM (в проекте пока нет jsdom/RTL, см.
 * package.json - только логика без рендера тестируется юнит-тестами).
 */
export function generatePassword(options: PasswordGeneratorOptions): string {
  if (!Number.isInteger(options.length) || options.length <= 0) {
    throw new RangeError("generatePassword: length must be a positive integer");
  }
  const alphabet = buildAlphabet(options);
  if (alphabet.length === 0) {
    throw new NoCharsetSelectedError();
  }

  let result = "";
  for (let i = 0; i < options.length; i++) {
    result += alphabet[randomIndex(alphabet.length)];
  }
  return result;
}

export type PasswordGeneratorProps = {
  /** Начальные настройки - частично, недостающее берётся из дефолта. */
  initialOptions?: Partial<PasswordGeneratorOptions>;
  /** "Вставить в поле" - куда класть результат решает вызывающий код
   * (Editor знает, какое поле было в фокусе на момент открытия генератора). */
  onInsert: (password: string) => void;
  /** Необязательное закрытие панели генератора, например кнопкой "Закрыть"
   * или кликом мимо неё - решает родитель. */
  onClose?: () => void;
};

export function PasswordGenerator({ initialOptions, onInsert, onClose }: PasswordGeneratorProps) {
  const [options, setOptions] = useState<PasswordGeneratorOptions>({
    ...PASSWORD_GENERATOR_DEFAULTS,
    ...initialOptions,
  });
  const [password, setPassword] = useState<string>(() => {
    try {
      return generatePassword({ ...PASSWORD_GENERATOR_DEFAULTS, ...initialOptions });
    } catch {
      return "";
    }
  });
  const [error, setError] = useState<string | null>(null);

  function regenerate(next: PasswordGeneratorOptions) {
    try {
      setPassword(generatePassword(next));
      setError(null);
    } catch {
      setPassword("");
      setError("Выберите хотя бы один набор символов");
    }
  }

  function updateOptions(patch: Partial<PasswordGeneratorOptions>) {
    const next = { ...options, ...patch };
    setOptions(next);
    regenerate(next);
  }

  /** R89: Esc закрывает открытое - здесь это сам поповер генератора.
   * Останавливает всплытие, чтобы то же нажатие Esc не закрыло следом ещё и
   * редактор позади (Editor.tsx слушает Esc на всём экране) - закрывается
   * только самое верхнее открытое. Ничего не делает, если `onClose` не
   * передан (тот же принцип опциональности, что и у самой кнопки "Закрыть"). */
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && onClose) {
      e.stopPropagation();
      onClose();
    }
  }

  return (
    <div className="password-generator" role="group" aria-label="Генератор паролей" onKeyDown={handleKeyDown}>
      <div className="password-generator__preview" aria-live="polite">
        {error ? (
          <span className="password-generator__error">{error}</span>
        ) : (
          <span className="password-generator__password">{password}</span>
        )}
      </div>

      <label className="password-generator__row password-generator__row--length">
        <span>Длина: {options.length}</span>
        <input
          type="range"
          min={MIN_LENGTH}
          max={MAX_LENGTH}
          value={options.length}
          onChange={(e) => updateOptions({ length: Number(e.currentTarget.value) })}
        />
      </label>

      <label className="password-generator__row">
        <input
          type="checkbox"
          checked={options.lowercase}
          onChange={(e) => updateOptions({ lowercase: e.currentTarget.checked })}
        />
        строчные (a-z)
      </label>

      <label className="password-generator__row">
        <input
          type="checkbox"
          checked={options.uppercase}
          onChange={(e) => updateOptions({ uppercase: e.currentTarget.checked })}
        />
        заглавные (A-Z)
      </label>

      <label className="password-generator__row">
        <input
          type="checkbox"
          checked={options.digits}
          onChange={(e) => updateOptions({ digits: e.currentTarget.checked })}
        />
        цифры (0-9)
      </label>

      <label className="password-generator__row">
        <input
          type="checkbox"
          checked={options.symbols}
          onChange={(e) => updateOptions({ symbols: e.currentTarget.checked })}
        />
        спецсимволы
      </label>

      <div className="password-generator__actions">
        <button type="button" onClick={() => regenerate(options)}>
          Сгенерировать заново
        </button>
        <button
          type="button"
          className="password-generator__insert"
          disabled={error !== null}
          onClick={() => onInsert(password)}
        >
          Вставить в поле
        </button>
        {onClose && (
          <button type="button" onClick={onClose}>
            Закрыть
          </button>
        )}
      </div>
    </div>
  );
}
