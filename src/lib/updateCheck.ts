/**
 * Проверка, вышла ли новая версия приложения.
 *
 * ОДНО ИЗ ДВУХ МЕСТ ВО ВСЁМ ПРИЛОЖЕНИИ, КОТОРЫЕ ХОДЯТ В СЕТЬ (второе -
 * проверка паролей на утечки, `breachCheck.ts`, добавлена 19.08.2026 и
 * работает по тем же правилам). Всё остальное - крипта, файлы, буфер обмена -
 * работает офлайн и в сеть не обращается. Поэтому здесь особые правила:
 *
 * 1. По умолчанию ВЫКЛЮЧЕНО. Включается галочкой в настройках, рядом с
 *    которой прямым текстом написано, что именно уходит и куда.
 * 2. Уходит только один обычный GET к публичному API GitHub. Ни база, ни её
 *    размер, ни имена записей, ни путь к файлу - ничего из этого в запрос не
 *    попадает и попасть не может: запрос не содержит вообще никаких данных
 *    приложения, кроме адреса самого репозитория.
 * 3. GitHub при этом видит то же, что видит любой сайт при открытии страницы:
 *    IP-адрес и то, что с него спросили релизы этого репозитория. Косвенно из
 *    этого следует, что на машине стоит cryptodermo. Версия НЕ передаётся:
 *    сравнение происходит уже здесь, после ответа.
 * 4. Скачивание и установка - руками. Приложение не умеет заменять само себя,
 *    и это осознанно: программа, которая может подменить свой исполняемый
 *    файл, - дополнительный путь внутрь для того, кто получит доступ к
 *    учётной записи GitHub.
 */

/** Публичный API GitHub. Репозиторий открытый, токен не нужен. */
export const RELEASES_URL =
  "https://api.github.com/repos/zxczxczxczxczxczxc1111/cryptodermo/releases/latest";

/** Страница релизов для человека - её открывают в браузере, если проверка не
 * удалась или захотелось посмотреть глазами. */
export const RELEASES_PAGE_URL =
  "https://github.com/zxczxczxczxczxczxc1111/cryptodermo/releases/latest";

/** Как часто проверять при включённой автопроверке. Раз в сутки: приложение
 * открывают по многу раз в день, и запрос на каждый запуск был бы навязчивым
 * при нулевой пользе - релизы выходят реже. */
export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseInfo {
  /** Версия без ведущей `v`. */
  version: string;
  /** Страница релиза - её человек открывает руками. */
  url: string;
}

/** Сеть недоступна или GitHub ответил не тем. Отдельный класс, чтобы интерфейс
 * мог отличить «не смогли спросить» от «обновлений нет» - это разные вещи, и
 * показывать их одинаково значит врать. */
export class UpdateCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UpdateCheckError";
  }
}

/**
 * Разобрать ответ GitHub. Отдельно от запроса, чтобы проверялось тестом без
 * сети - тот же приём, что и во всём остальном проекте.
 */
export function parseRelease(payload: unknown): ReleaseInfo {
  if (typeof payload !== "object" || payload === null) {
    throw new UpdateCheckError("Ответ GitHub не разобран");
  }
  const obj = payload as Record<string, unknown>;
  const tag = obj.tag_name;
  const url = obj.html_url;
  if (typeof tag !== "string" || tag === "") {
    throw new UpdateCheckError("В ответе GitHub нет номера версии");
  }
  if (typeof url !== "string" || url === "") {
    throw new UpdateCheckError("В ответе GitHub нет ссылки на релиз");
  }
  return { version: tag.replace(/^v/i, ""), url };
}

/**
 * Сравнить версии вида `1.2.3`. Больше нуля - `a` новее `b`.
 *
 * Части, которых нет, считаются нулём: `1.1` и `1.1.0` это одна и та же
 * версия. Нечисловой хвост (`1.2.3-beta`) отбрасывается - в этом проекте таких
 * версий не бывает, а падать на них незачем.
 */
export function compareVersions(a: string, b: string): number {
  const parts = (v: string) =>
    v.split(".").map((piece) => {
      const n = Number.parseInt(piece, 10);
      return Number.isFinite(n) ? n : 0;
    });
  const pa = parts(a);
  const pb = parts(b);
  const length = Math.max(pa.length, pb.length);
  for (let i = 0; i < length; i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff > 0 ? 1 : -1;
  }
  return 0;
}

/** Есть ли что скачивать. Равные версии и версия НОВЕЕ выложенной (собрал сам
 * из исходников) одинаково означают «обновляться не нужно». */
export function isNewer(latest: string, current: string): boolean {
  return compareVersions(latest, current) > 0;
}

/** Пора ли проверять снова. `lastCheckAt` - ISO8601 или `undefined`. */
export function shouldCheckNow(lastCheckAt: string | undefined, now: Date): boolean {
  if (!lastCheckAt) return true;
  const previous = new Date(lastCheckAt).getTime();
  if (!Number.isFinite(previous)) return true;
  return now.getTime() - previous >= CHECK_INTERVAL_MS;
}

/**
 * Спросить GitHub о последнем релизе.
 *
 * Таймаут обязателен: без него зависший ответ оставил бы в настройках вечное
 * «Проверяю...», а человек не понял бы, сломалось что-то или нет.
 */
export async function fetchLatestRelease(timeoutMs = 10_000): Promise<ReleaseInfo> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(RELEASES_URL, {
      signal: controller.signal,
      headers: { Accept: "application/vnd.github+json" },
    });
    if (!response.ok) {
      throw new UpdateCheckError(`GitHub ответил ${response.status}`);
    }
    return parseRelease(await response.json());
  } catch (err) {
    if (err instanceof UpdateCheckError) throw err;
    throw new UpdateCheckError("Не удалось связаться с GitHub");
  } finally {
    clearTimeout(timer);
  }
}
