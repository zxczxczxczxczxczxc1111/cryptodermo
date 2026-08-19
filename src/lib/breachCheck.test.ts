import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countFromRangeResponse,
  sha1Hex,
  checkPasswordBreached,
  checkPasswordsBreached,
  BreachCheckError,
} from "./breachCheck";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("sha1Hex", () => {
  // Эталон из RFC 3174 / общеизвестных векторов SHA-1, взят из спецификации,
  // а не получен вызовом кода под тестом.
  it("совпадает с эталонным вектором", async () => {
    expect(await sha1Hex("abc")).toBe("A9993E364706816ABA3E25717850C26C9CD0D89D");
  });

  it("для пустой строки даёт известный хеш", async () => {
    expect(await sha1Hex("")).toBe("DA39A3EE5E6B4B0D3255BFEF95601890AFD80709");
  });
});

describe("countFromRangeResponse", () => {
  const body = ["0018A45C4D1DEF81644B54AB7F969B88D65:1", "00D4F6E8FA6EECAD2A3AA415EEC418D38EC:2"].join(
    "\r\n",
  );

  it("находит счётчик по суффиксу", () => {
    expect(countFromRangeResponse(body, "0018A45C4D1DEF81644B54AB7F969B88D65")).toBe(1);
  });

  it("не находит отсутствующий суффикс", () => {
    expect(countFromRangeResponse(body, "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF")).toBe(0);
  });

  it("сверка суффикса без учёта регистра", () => {
    expect(countFromRangeResponse(body, "0018a45c4d1def81644b54ab7f969b88d65")).toBe(1);
  });

  // Главная ловушка этого протокола: при включённом падинге сервис
  // домешивает фальшивые суффиксы со счётчиком 0. Считать их совпадением -
  // значит показывать «ваш пароль в утечке» на здоровом пароле.
  it("нулевой счётчик НЕ считается совпадением (строки падинга)", () => {
    expect(countFromRangeResponse("AAAABBBBCCCCDDDDEEEEFFFF0000111122:0", "AAAABBBBCCCCDDDDEEEEFFFF0000111122")).toBe(0);
  });

  it("мусорные строки не ломают разбор", () => {
    expect(countFromRangeResponse("совсем не тот формат\n\nещё строка", "ABC")).toBe(0);
  });
});

describe("checkPasswordBreached", () => {
  it("в запрос уходит ровно первые 5 символов хеша", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { ok: true, text: async () => "" } as Response;
    });

    await checkPasswordBreached("password");

    // SHA-1("password") = 5BAA61E4C9B93F3F0682250B6CF8331B7EE68FD8 -
    // общеизвестный вектор, не получен вызовом кода под тестом.
    expect(seen).toEqual(["https://api.pwnedpasswords.com/range/5BAA6"]);
  });

  it("ни сам пароль, ни остаток его хеша в запрос не попадают", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return { ok: true, text: async () => "" } as Response;
    });

    // Пароль намеренно непохож ни на что в адресе сервиса: проверка "нет
    // подстроки" на слове вроде "password" прошла бы ложно, потому что оно
    // есть в самом домене pwnedpasswords.com (поймано на первой версии теста).
    const secret = "МойСовершенноУникальныйПароль-42";
    await checkPasswordBreached(secret);

    const url = new URL(seen[0]);
    expect(url.pathname).toMatch(/^\/range\/[0-9A-F]{5}$/);
    expect(seen[0]).not.toContain(secret);
    expect(seen[0]).not.toContain(encodeURIComponent(secret));
    // Полный хеш в 40 символов уйти не должен - только 5 из него.
    expect(seen[0]).not.toMatch(/[0-9A-F]{40}/);
  });

  it("возвращает число утечек, когда суффикс найден", async () => {
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      text: async () => "1E4C9B93F3F0682250B6CF8331B7EE68FD8:12345",
    }) as Response);

    expect(await checkPasswordBreached("password")).toBe(12345);
  });

  it("сетевой отказ приходит как BreachCheckError, а не как чужая ошибка наружу", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(checkPasswordBreached("x")).rejects.toBeInstanceOf(BreachCheckError);
  });

  it("ответ не-200 тоже даёт BreachCheckError", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: false, status: 503 }) as Response);
    await expect(checkPasswordBreached("x")).rejects.toBeInstanceOf(BreachCheckError);
  });
});

describe("checkPasswordsBreached", () => {
  it("делает по одному запросу на пароль и считает только найденные", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      // Утёкшим считается только первый пароль ("password", префикс 5BAA6).
      const leaked = url.endsWith("5BAA6");
      return {
        ok: true,
        text: async () => (leaked ? "1E4C9B93F3F0682250B6CF8331B7EE68FD8:100" : "ABC:0"),
      } as Response;
    });

    const result = await checkPasswordsBreached(["password", "Tr0ub4dor&3xyzQW"], { delayMs: 0 });

    expect(calls).toBe(2);
    expect(result.breachedCount).toBe(1);
    expect(result.checkedCount).toBe(2);
    // Сами значения нужны, чтобы пометить записи значком - без них значок
    // было бы нечем поставить.
    expect([...result.breachedValues]).toEqual(["password"]);
  });

  it("сообщает о прогрессе на каждом шаге", async () => {
    vi.stubGlobal("fetch", async () => ({ ok: true, text: async () => "" }) as Response);
    const progress: string[] = [];

    await checkPasswordsBreached(["a", "b", "c"], {
      delayMs: 0,
      onProgress: (p) => progress.push(`${p.done}/${p.total}`),
    });

    expect(progress).toEqual(["1/3", "2/3", "3/3"]);
  });

  // Проверка базы идёт заметное время, и автоблокировка может сработать
  // посреди неё: цикл обязан прекратиться, а не продолжать держать пароли
  // в памяти уже после закрытия базы.
  it("прекращает работу по shouldStop, не доделывая очередь", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return { ok: true, text: async () => "" } as Response;
    });

    const result = await checkPasswordsBreached(["a", "b", "c", "d"], {
      delayMs: 0,
      shouldStop: () => calls >= 2,
    });

    expect(calls).toBe(2);
    expect(result.checkedCount).toBe(2);
  });

  it("пустой список не делает ни одного запроса", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async () => {
      calls++;
      return { ok: true, text: async () => "" } as Response;
    });

    const result = await checkPasswordsBreached([], { delayMs: 0 });
    expect(calls).toBe(0);
    expect(result.breachedCount).toBe(0);
    expect(result.checkedCount).toBe(0);
    expect(result.breachedValues.size).toBe(0);
  });
});

// Прерывание отдаёт ЧАСТИЧНЫЙ набор, а не пустой: пометить то, что уже
// успели узнать, честнее, чем выбросить результат работы.
describe("checkPasswordsBreached: частичный результат при прерывании", () => {
  it("возвращает найденное до остановки", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", async (url: string) => {
      calls++;
      const leaked = url.endsWith("5BAA6");
      return {
        ok: true,
        text: async () => (leaked ? "1E4C9B93F3F0682250B6CF8331B7EE68FD8:100" : "ABC:0"),
      } as Response;
    });

    const result = await checkPasswordsBreached(["password", "Tr0ub4dor&3xyzQW", "ещё"], {
      delayMs: 0,
      shouldStop: () => calls >= 2,
    });

    expect(result.checkedCount).toBe(2);
    expect([...result.breachedValues]).toEqual(["password"]);
  });
});
