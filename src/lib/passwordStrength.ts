/**
 * Оценка силы пароля (тикет 11 сегодняшней очереди) - чистая функция без DOM,
 * используется и в редакторе (живая оценка при ручном вводе), и позже в
 * проверке базы на слабые пароли (тикет 12).
 *
 * Без внешней библиотеки (zxcvbn и т.п.) - тот же принцип, что уже применён
 * в этой сессии к base64 (`vault_fs.rs`) и CSV (`importExport.ts`): готовая
 * оценка решаема вручную, новая зависимость не оправдана (R31).
 *
 * Метод - три сигнала, не один:
 * 1. Энтропия по составу символов (log2(размер алфавита) * длина) - основной
 *    сигнал, честно отражает случайные/сгенерированные пароли.
 * 2. Список частых паролей (~40 штук) с нормализацией по частым leetspeak-
 *    заменам (@ -> a, 0 -> o, 3 -> e и т.п.) - без неё "P@ssw0rd" получил бы
 *    высокую оценку по чистой энтропии (4 класса символов), хотя это
 *    хрестоматийно слабый пароль. Список - не претензия на словарь атаки по
 *    словарю (это и есть zxcvbn, сознательно не делаем), только самые частые
 *    случаи.
 * 3. Низкое разнообразие символов (aaaa, abab, 111222) - у таких паролей
 *    формальная энтропия по алфавиту завышена (алфавит "a1" даёт count>1),
 *    а настоящая близка к нулю.
 *
 * Осознанное ограничение: не ловит атаки по паттерну (qwerty-строки
 * клавиатуры, последовательности "abcd"/"1234") и не использует словарь
 * языка - за пределами "без спама" ценности для пользователя эта точность
 * не стоит сложности полноценного zxcvbn-подхода.
 */

export type PasswordStrengthLevel = "empty" | "weak" | "fair" | "good" | "strong";

export type PasswordStrengthResult = {
  level: PasswordStrengthLevel;
  /** Подпись для интерфейса, по-русски. Пустая строка при `level === "empty"`
   * - редактор в этом случае индикатор не показывает вовсе. */
  label: string;
};

export const PASSWORD_STRENGTH_LABELS: Record<PasswordStrengthLevel, string> = {
  empty: "",
  weak: "Слабый",
  fair: "Средний",
  good: "Хороший",
  strong: "Надёжный",
};

/** Частые пароли, в нижнем регистре. Сверяются и как есть, и после снятия
 * leetspeak-замен (см. `normalizeForCommonCheck`) - часть значений здесь уже
 * содержит цифры как часть обычного написания ("qwerty123"), их не нужно
 * прогонять через замену. Не претендует на полноту. */
const COMMON_PASSWORDS = new Set([
  "password", "123456", "12345678", "123456789", "12345", "1234", "1234567",
  "qwerty", "qwerty123", "111111", "000000", "123123", "abc123", "password1",
  "admin", "letmein", "welcome", "monkey", "dragon", "master", "iloveyou",
  "zaq12wsx", "qazwsx", "football", "baseball", "superman", "trustno1",
  "696969", "sunshine", "princess", "login", "starwars", "hello", "freedom",
  "whatever", "qwertyuiop", "changeme", "default", "guest", "test",
]);

/** Частые символьные замены букв ("leetspeak") - применяются только для
 * сверки со списком частых паролей, не влияют на расчёт энтропии. */
const LEET_MAP: Record<string, string> = {
  "@": "a", "4": "a", "8": "b", "3": "e", "1": "i", "!": "i",
  "0": "o", "$": "s", "5": "s", "7": "t",
};

function normalizeForCommonCheck(password: string): string {
  return password
    .toLowerCase()
    .split("")
    .map((ch) => LEET_MAP[ch] ?? ch)
    .join("");
}

/** Размер алфавита по классам символов, реально встретившимся в пароле - не
 * по тому, что теоретически разрешено. Всё, что не ASCII-буква/цифра
 * (включая кириллицу), считается одним классом "прочее" с консервативным
 * размером 32: недооценка энтропии для не-ASCII паролей безопаснее
 * переоценки. */
function alphabetSize(password: string): number {
  let size = 0;
  if (/[a-z]/.test(password)) size += 26;
  if (/[A-Z]/.test(password)) size += 26;
  if (/[0-9]/.test(password)) size += 10;
  if (/[^a-zA-Z0-9]/.test(password)) size += 32;
  return size;
}

/**
 * Вырожденный повтор символов - "aaaaaaaa" или "abababab", у которых
 * формальная энтропия по алфавиту завышена относительно настоящей.
 *
 * Регрессия живого прогона (2026-08-19): первая версия сравнивала долю
 * УНИКАЛЬНЫХ символов от общей длины (`new Set(password).size / length`).
 * Порог ломался на длинных, но честных паролях - мешанина по соседним
 * клавишам ("lsadlsa2349sdipsdkg;sdkg;...") естественно повторяет небольшой
 * набор символов, и с ростом длины доля уникальных падает даже без всякой
 * деградации (сокращение того же пароля пользователем вручную подтвердило:
 * короче - "надёжный", length растёт - "слабый", хотя реальная случайность
 * не менялась). Заменено на то, что действительно отличает вырожденный
 * пароль от длинного случайного: длинный повтор ОДНОГО символа подряд и
 * короткий цикл, из которого построена вся строка - оба сигнала не зависят
 * от длины пароля, только от структуры.
 */
function hasLowVariety(password: string): boolean {
  if (password.length < 6) return false;

  let maxRun = 1;
  let run = 1;
  for (let i = 1; i < password.length; i++) {
    run = password[i] === password[i - 1] ? run + 1 : 1;
    if (run > maxRun) maxRun = run;
  }
  if (maxRun >= 4) return true;

  for (let period = 1; period <= 4; period++) {
    if (password.length < period * 3) continue;
    let isCycle = true;
    for (let i = period; i < password.length; i++) {
      if (password[i] !== password[i - period]) {
        isCycle = false;
        break;
      }
    }
    if (isCycle) return true;
  }

  return false;
}

export function estimatePasswordStrength(password: string): PasswordStrengthResult {
  if (password === "") {
    return { level: "empty", label: PASSWORD_STRENGTH_LABELS.empty };
  }

  if (
    COMMON_PASSWORDS.has(password.toLowerCase()) ||
    COMMON_PASSWORDS.has(normalizeForCommonCheck(password)) ||
    hasLowVariety(password)
  ) {
    return { level: "weak", label: PASSWORD_STRENGTH_LABELS.weak };
  }

  const pool = alphabetSize(password);
  const bits = pool > 0 ? password.length * Math.log2(pool) : 0;

  let level: PasswordStrengthLevel;
  if (bits < 28) level = "weak";
  else if (bits < 45) level = "fair";
  else if (bits < 65) level = "good";
  else level = "strong";

  return { level, label: PASSWORD_STRENGTH_LABELS[level] };
}
