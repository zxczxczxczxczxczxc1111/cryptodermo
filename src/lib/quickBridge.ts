/**
 * Разговор между основным окном и маленьким окном быстрого доступа.
 *
 * ГЛАВНОЕ РЕШЕНИЕ, РАДИ КОТОРОГО ЭТОТ ФАЙЛ СУЩЕСТВУЕТ: маленькое окно не
 * получает базу. Совсем. Это отдельный контекст, и передавать в него
 * расшифрованное хранилище значило бы завести вторую копию всех секретов в
 * памяти, живущую по своим правилам.
 *
 * Вместо этого окно спрашивает «найди вот это» и получает назад только
 * НАЗВАНИЯ записей с пометками, есть ли у них логин и код двухфакторки.
 * Названия секретом не являются. Когда человек жмёт Enter, окно говорит
 * «скопируй пароль записи такой-то», и копирует основное окно - то самое, у
 * которого ключ и так есть. Пароль при этом не пересекает границу между окнами
 * ни разу.
 *
 * Побочная выгода: автоочистка буфера обмена остаётся в одном месте, у
 * основного окна. Закрытие маленького окна не может её сорвать.
 */

/** Метка окна быстрого доступа. По ней `main.tsx` решает, что рисовать. */
export const QUICK_WINDOW_LABEL = "quick";

/** Имена событий. Собраны здесь, чтобы обе стороны не разъехались в написании:
 * опечатка в имени события не ломает сборку и проявляется только молчанием. */
export const QUICK_EVENTS = {
  /** Маленькое окно отрисовалось и готово показаться. */
  ready: "quick:ready",
  /** Запрос поиска: маленькое окно -> основное. */
  query: "quick:query",
  /** Результаты: основное -> маленькое. */
  results: "quick:results",
  /** Просьба скопировать: маленькое -> основное. */
  copy: "quick:copy",
  /** Итог копирования: основное -> маленькое. */
  copied: "quick:copied",
  /**
   * Запрос состояния блокировки: маленькое окно -> основное, при каждом
   * появлении окна (19.08.2026). База могла заблокироваться автоблокировкой,
   * пока окно было спрятано - маленькое окно не хранит своё собственное
   * представление о состоянии, а спрашивает заново каждый раз.
   */
  state: "quick:state",
  /** Ответ на запрос состояния: основное -> маленькое. */
  stateResult: "quick:state-result",
  /** Попытка разблокировки PIN-ом: маленькое -> основное. */
  unlock: "quick:unlock",
  /** Итог попытки разблокировки: основное -> маленькое. */
  unlocked: "quick:unlocked",
} as const;

/** Что можно скопировать. */
export type QuickCopyKind = "password" | "login" | "totp";

/**
 * Строка результата. Ни одного секретного значения - только то, что нужно
 * показать и по чему выбрать.
 *
 * Строка соответствует НЕ записи, а паре «логин и пароль» внутри записи. В
 * одной записи их бывает несколько (две почты одного сервиса - обычное дело), и
 * пока строка была записью, копировалась всегда первая пара, без всякого
 * способа добраться до второй.
 */
export interface QuickResult {
  id: string;
  title: string;
  /** Уточнение под названием: имя поля, когда пар в записи больше одной.
   * Пустая строка - уточнять нечего. */
  detail: string;
  /**
   * ПОЗИЦИЯ секретного поля в записи, а не его имя.
   *
   * Имя перестало быть уникальным, как только у записи появились аккаунты: и в
   * «Аккаунт 1», и в «Аккаунт 2» поле называется «Пароль». Поиск по имени
   * находил первое совпадение и копировал чужой пароль (найдено пользователем
   * 17.08.2026).
   */
  passwordIndex: number;
  /** Позиция поля логина для этой пары, если оно есть. */
  loginIndex: number | null;
  /**
   * ЗНАЧЕНИЕ логина - им и различают строки.
   *
   * Имя поля оказалось бесполезным: две почты одного сервиса давали
   * «maj · Пароль» и «maj · Пароль», по которым выбрать невозможно (замечено
   * пользователем 17.08.2026). Логин отвечает на вопрос «который из них».
   *
   * Это единственное значение поля, пересекающее границу между окнами, и оно
   * несекретное по определению: секретные поля сюда не попадают, а логин и в
   * карточке записи показан открытым текстом.
   */
  loginValue: string | null;
  hasTotp: boolean;
}

export interface QuickQueryPayload {
  query: string;
}

export interface QuickResultsPayload {
  results: QuickResult[];
}

export interface QuickCopyPayload {
  id: string;
  kind: QuickCopyKind;
  /** Позиция поля в записи. Обязательна для пароля и логина: имена в записи с
   * аккаунтами повторяются, и по имени находилось чужое поле. */
  index?: number;
}

export interface QuickCopiedPayload {
  /** Что скопировано, для подписи: «пароль», «логин», «код». */
  label: string | null;
  /** Текст ошибки, если скопировать не вышло. */
  error?: string;
}

/** Ответ на `state`: заблокирована ли база в основном окне прямо сейчас. */
export interface QuickStateResultPayload {
  locked: boolean;
  /** Есть ли вообще настроенный PIN - без него маленькому окну предложить
   * разблокировку нечем (см. `NO_PIN_MESSAGE` в `QuickAccess.tsx`). */
  hasPin: boolean;
  /** Осталось мс временной блокировки после исчерпанных попыток, если она
   * сейчас действует. Считается на стороне основного окна по `vault.settings.json`,
   * а не в маленьком - оно не хранит состояние между показами. */
  lockedOutRemainingMs?: number;
}

export interface QuickUnlockPayload {
  pin: string;
  /**
   * Считать ли неудачу этой попытки полноценным провалом для счётчика
   * блокировки (см. `isPinAttemptExhausted` в `LockScreen.tsx`). Тихие
   * попытки короче максимальной длины PIN неудачей не считаются - иначе
   * владелец шестизначного PIN получал бы блокировку на четвёртой цифре, не
   * успев дописать.
   */
  counted: boolean;
  /**
   * Порядковый номер попытки со стороны маленького окна. Тот же приём, что
   * `pinAttemptSeqRef`/`isCurrent()` в `LockScreen.tsx`, но через границу
   * окон: ответ на устаревшую попытку (человек успел стереть/дописать PIN,
   * пока деривация основного окна ещё считалась) должен быть проигнорирован,
   * а не перезаписать уже более новое состояние экрана.
   */
  seq: number;
}

export interface QuickUnlockedPayload {
  ok: boolean;
  /** Текст для человека - неверный PIN, база не найдена и т.п. */
  message?: string;
  /** Осталось мс временной блокировки, если этой попыткой она наступила. */
  lockedOutRemainingMs?: number;
  /** Эхо `seq` из запроса - см. комментарий там же. */
  seq: number;
}

/** Подпись действия для человека. В одном месте, потому что используется и в
 * подтверждении, и в подсказке. */
export const COPY_LABELS: Record<QuickCopyKind, string> = {
  password: "пароль",
  login: "логин",
  totp: "код",
};

/**
 * Уточнение справа от названия.
 *
 * Собирается из имени аккаунта и логина, но с двумя оговорками, каждая из
 * которых родилась из реального экрана (17.08.2026):
 *
 * 1. Логин, совпадающий с названием записи, не повторяется. Строка
 *    «123123123 · Аккаунт 1 · 123123123» сообщает ровно то же, что
 *    «123123123 · Аккаунт 1», только вдвое длиннее.
 * 2. Пустые части выбрасываются, а не превращаются в висящие разделители.
 */
function buildDetail(
  title: string,
  accountName: string | null,
  loginValue: string | null,
  fallback: string | null = null,
): string {
  const parts: string[] = [];
  if (accountName && accountName.trim() !== "") parts.push(accountName.trim());
  const login = loginValue?.trim() ?? "";
  if (login !== "" && login.toLowerCase() !== title.trim().toLowerCase()) parts.push(login);
  if (parts.length === 0 && fallback) parts.push(fallback);
  return parts.join(" · ");
}

/** Поле похоже на секрет двухфакторки. Своя маленькая копия проверки, чтобы
 * этот модуль не тянул за собой весь `totp.ts` - он подключается и в окне, где
 * коды не считаются. */
function isTotpValue(value: string): boolean {
  return value.trim().toLowerCase().startsWith("otpauth://");
}

interface ItemLike {
  id: string;
  title: string;
  fields: { name: string; value: string; secret: boolean; group?: string }[];
}

/**
 * Разложить записи в строки быстрого доступа.
 *
 * Одна строка - один пароль. Логин к нему берётся ближайший несекретный ВЫШЕ
 * по списку полей: именно так люди и заполняют такие записи - логин, пароль,
 * второй логин, второй пароль. Если выше ничего нет, берётся первый
 * несекретный в записи.
 *
 * Общая для всех трёх мест, где есть быстрый поиск: маленькое окно, окно по
 * ярлыку и палитра внутри приложения. Иначе Enter копировал бы в них разное.
 */
export function buildQuickRows(items: ItemLike[]): QuickResult[] {
  const rows: QuickResult[] = [];
  for (const original of items) {
    let item = original;
    // Если у записи есть аккаунты, пары берутся из них, а не угадываются по
    // соседству полей: человек уже сказал, что к чему относится, и
    // догадываться поверх его слов было бы неуважением к его же разметке.
    const named = item.fields.filter((f) => f.group && f.group.trim() !== "");
    if (named.length > 0) {
      const seen: string[] = [];
      for (const field of named) {
        const name = field.group as string;
        if (seen.includes(name)) continue;
        seen.push(name);
        const inGroup = item.fields.filter((f) => f.group === name);
        const secret = inGroup.find(
          (f) => f.secret && f.value.trim() !== "" && !isTotpValue(f.value),
        );
        if (!secret) continue;
        const login = inGroup.find((f) => !f.secret && f.value.trim() !== "");
        rows.push({
          id: item.id,
          title: item.title,
          detail: buildDetail(item.title, name, login ? login.value : null),
          passwordIndex: item.fields.indexOf(secret),
          loginIndex: login ? item.fields.indexOf(login) : null,
          loginValue: login ? login.value : null,
          hasTotp: inGroup.some((f) => isTotpValue(f.value)),
        });
      }
      // Поля вне аккаунтов у такой записи разбираются обычным путём ниже.
      const loose = item.fields.filter((f) => !f.group || f.group.trim() === "");
      if (loose.length === 0) continue;
      item = { ...item, fields: loose };
    }

    // Признак «показывать ли» - наличие заполненного пароля, а НЕ тип записи.
    // Сначала я скрывал заметки и ключи по типу, но тип тут ни при чём:
    // человек волен хранить пароль в записи любого типа, а запись без пароля
    // в окне, которое умеет только копировать, бесполезна независимо от типа
    // (уточнено пользователем 17.08.2026).
    const secrets = item.fields.filter(
      (f) => f.secret && f.value.trim() !== "" && !isTotpValue(f.value),
    );
    if (secrets.length === 0) continue;
    const hasTotp = item.fields.some((f) => isTotpValue(f.value));

    for (const secret of secrets) {
      const index = item.fields.indexOf(secret);
      const above = item.fields.slice(0, index).filter((f) => !f.secret && f.value.trim() !== "");
      const login =
        above.length > 0
          ? above[above.length - 1]
          : item.fields.find((f) => !f.secret && f.value.trim() !== "");
      rows.push({
        id: item.id,
        title: item.title,
        // Уточняем логином. Имя поля - только когда логина нет И паролей
        // несколько: иначе в строке висела бы подпись «Пароль», из которой
        // ничего не следует.
        detail: buildDetail(
          item.title,
          null,
          login && login.value.trim() !== "" ? login.value : null,
          secrets.length > 1 ? secret.name : null,
        ),
        passwordIndex: original.fields.indexOf(secret),
        loginIndex: login ? original.fields.indexOf(login) : null,
        loginValue: login && login.value.trim() !== "" ? login.value : null,
        hasTotp,
      });
    }
  }
  return rows;
}
