import { describe, it, expect } from "vitest";
import {
  base32Decode,
  parseOtpauth,
  totpCode,
  counterFor,
  secondsRemaining,
  looksLikeTotp,
  formatCodeForDisplay,
  normalizeTotpInput,
  TotpParseError,
  type TotpParams,
} from "./totp";

/** Секрет из приложения B к RFC 6238: ASCII "12345678901234567890". */
const RFC_SECRET = new TextEncoder().encode("12345678901234567890");

function rfcParams(digits = 8): TotpParams {
  return { secret: RFC_SECRET, digits, period: 30, algorithm: "SHA-1", label: null, issuer: null };
}

describe("totpCode: эталонные векторы RFC 6238", () => {
  // Единственная проверка, которая по-настоящему что-то доказывает: коды
  // обязаны совпасть с теми, что напечатаны в стандарте, иначе сервер их не
  // примет. Числа взяты из приложения B RFC 6238 (режим SHA1).
  const vectors: Array<[number, string]> = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];

  for (const [time, expected] of vectors) {
    it(`t=${time} даёт ${expected}`, async () => {
      expect(await totpCode(rfcParams(), time)).toBe(expected);
    });
  }

  it("шестизначный код это последние шесть цифр восьмизначного", async () => {
    expect(await totpCode(rfcParams(6), 59)).toBe("287082");
  });
});

describe("base32Decode", () => {
  it("раскодирует канонические примеры RFC 4648", () => {
    const d = (s: string) => new TextDecoder().decode(base32Decode(s));
    expect(d("MY======")).toBe("f");
    expect(d("MZXQ====")).toBe("fo");
    expect(d("MZXW6YTB")).toBe("fooba");
    expect(d("MZXW6YTBOI======")).toBe("foobar");
  });

  it("терпит пробелы, дефисы и дополнение", () => {
    // Сайты печатают ключ группами по четыре символа, и человек копирует его
    // ровно в таком виде.
    const expected = base32Decode("MZXW6YTB");
    expect(base32Decode("MZXW 6YTB")).toEqual(expected);
    expect(base32Decode("mzxw-6ytb")).toEqual(expected);
    expect(base32Decode("MZXW6YTB======")).toEqual(expected);
  });

  it("отказывается от мусора вместо тихой выдачи неверного секрета", () => {
    // Молча раскодировать «как получится» здесь худший вариант: коды просто не
    // будут подходить, а причина останется невидимой.
    expect(() => base32Decode("MZXW6YT1")).toThrow(TotpParseError);
    expect(() => base32Decode("")).toThrow(TotpParseError);
  });
});

describe("parseOtpauth", () => {
  it("разбирает ссылку, которую даёт обычный сайт", () => {
    const p = parseOtpauth("otpauth://totp/GitHub:me@example.com?secret=MZXW6YTB&issuer=GitHub");
    expect(p.digits).toBe(6);
    expect(p.period).toBe(30);
    expect(p.algorithm).toBe("SHA-1");
    expect(p.issuer).toBe("GitHub");
    expect(p.label).toBe("GitHub:me@example.com");
  });

  it("уважает нестандартные digits, period и algorithm", () => {
    const p = parseOtpauth("otpauth://totp/X?secret=MZXW6YTB&digits=8&period=60&algorithm=SHA256");
    expect(p.digits).toBe(8);
    expect(p.period).toBe(60);
    expect(p.algorithm).toBe("SHA-256");
  });

  it("отказывает hotp, а не делает вид, что это totp", () => {
    // hotp считает от счётчика, а не от времени: показать его как TOTP значит
    // выдать неверный код с уверенным видом.
    expect(() => parseOtpauth("otpauth://hotp/X?secret=MZXW6YTB&counter=1")).toThrow(TotpParseError);
  });

  it("отказывает без секрета и на чужих значениях", () => {
    expect(() => parseOtpauth("otpauth://totp/X?issuer=Y")).toThrow(TotpParseError);
    expect(() => parseOtpauth("просто пароль")).toThrow(TotpParseError);
  });

  it("отказывает на неправдоподобной длине кода", () => {
    expect(() => parseOtpauth("otpauth://totp/X?secret=MZXW6YTB&digits=3")).toThrow(TotpParseError);
  });
});

describe("looksLikeTotp", () => {
  it("узнаёт ссылку независимо от регистра и пробелов по краям", () => {
    expect(looksLikeTotp("  OTPAUTH://totp/X?secret=A  ")).toBe(true);
  });

  it("не принимает обычный пароль за секрет двухфакторки", () => {
    expect(looksLikeTotp("Xk9#mQ2$vL8pR4wZ")).toBe(false);
  });
});

describe("counterFor / secondsRemaining", () => {
  it("счётчик меняется ровно на границе периода", () => {
    expect(counterFor(59, 30)).toBe(1);
    expect(counterFor(60, 30)).toBe(2);
  });

  it("остаток отсчитывается от периода до нуля и не показывает 0 у живого кода", () => {
    // На границе остаток снова полный: код только что сменился.
    expect(secondsRemaining(0, 30)).toBe(30);
    expect(secondsRemaining(1, 30)).toBe(29);
    expect(secondsRemaining(29, 30)).toBe(1);
    expect(secondsRemaining(30, 30)).toBe(30);
  });
});

describe("formatCodeForDisplay", () => {
  it("делит код пополам - так его легче перенабрать руками", () => {
    expect(formatCodeForDisplay("123456")).toBe("123 456");
    expect(formatCodeForDisplay("12345678")).toBe("1234 5678");
  });
});

describe("normalizeTotpInput", () => {
  it("принимает готовую ссылку как есть", () => {
    const uri = "otpauth://totp/X?secret=MZXW6YTBOI";
    expect(normalizeTotpInput(uri, "GitHub")).toBe(uri);
  });

  it("собирает ссылку из голого секрета, как его печатают сайты", () => {
    // Одни сайты дают ссылку целиком, другие только строку вроде
    // «JBSW Y3DP EHPK 3PXP». Требовать от человека знать разницу - лишний
    // повод ошибиться там, где ошибка выглядит как «показывает не те цифры».
    const result = normalizeTotpInput("JBSW Y3DP EHPK 3PXP", "GitHub");
    expect(result).toBe("otpauth://totp/GitHub?secret=JBSWY3DPEHPK3PXP");
  });

  it("не принимает обычные слова за секрет", () => {
    // Без нижней границы длины под определение base32 попало бы любое слово
    // из букв A-Z.
    expect(normalizeTotpInput("PASSWORD", "X")).toBeNull();
    expect(normalizeTotpInput("Xk9#mQ2$vL8pR4wZ", "X")).toBeNull();
    expect(normalizeTotpInput("", "X")).toBeNull();
  });

  it("не принимает битую ссылку", () => {
    expect(normalizeTotpInput("otpauth://totp/X?issuer=Y", "X")).toBeNull();
    expect(normalizeTotpInput("otpauth://hotp/X?secret=MZXW6YTBOI", "X")).toBeNull();
  });
});
