/**
 * Живой код двухфакторки на месте значения поля.
 *
 * Поле распознаётся по значению: секретное поле, начинающееся с `otpauth://`,
 * показывается не точками, а шестизначным кодом с обратным отсчётом. Никакого
 * нового типа поля и никакой правки формата базы для этого не понадобилось -
 * см. комментарий модуля `lib/totp.ts`.
 *
 * Код пересчитывается раз в секунду. Не по таймеру «на период», а именно
 * ежесекундно: полоска обратного отсчёта должна двигаться, а не прыгать раз в
 * полминуты, и по ней сразу видно, успеешь ли ты вбить код или лучше дождаться
 * следующего.
 *
 * Скрывать код точками, как пароль, смысла нет: он живёт тридцать секунд и
 * бесполезен без пароля, а прятать его значит требовать лишнее нажатие ровно в
 * тот момент, когда человек торопится.
 */
import { useEffect, useMemo, useState } from "react";
import {
  parseOtpauth,
  totpCode,
  secondsRemaining,
  formatCodeForDisplay,
  TotpParseError,
  type TotpParams,
} from "../lib/totp";
import "./TotpCode.css";

export interface TotpCodeProps {
  /** Значение поля - ссылка `otpauth://`. */
  value: string;
  /** Текущий код наружу: карточка копирует именно его, а не ссылку. */
  onCodeChange?: (code: string | null) => void;
}

const BROKEN_MESSAGE = "Секрет двухфакторки не разобран";

export function TotpCode({ value, onCodeChange }: TotpCodeProps) {
  const parsed = useMemo<{ params: TotpParams } | { error: string }>(() => {
    try {
      return { params: parseOtpauth(value) };
    } catch (err) {
      if (err instanceof TotpParseError) return { error: err.message };
      throw err;
    }
  }, [value]);

  const [code, setCode] = useState<string | null>(null);
  const [remaining, setRemaining] = useState(0);

  useEffect(() => {
    if ("error" in parsed) {
      setCode(null);
      onCodeChange?.(null);
      return;
    }
    let alive = true;
    let lastCounter = -1;

    const tick = async () => {
      const nowSeconds = Date.now() / 1000;
      setRemaining(secondsRemaining(nowSeconds, parsed.params.period));
      const counter = Math.floor(nowSeconds / parsed.params.period);
      // Считаем только на смене периода: HMAC внутри одного окна даёт то же
      // число, а лишняя криптооперация раз в секунду ни к чему.
      if (counter === lastCounter) return;
      lastCounter = counter;
      const next = await totpCode(parsed.params, nowSeconds);
      if (!alive) return;
      setCode(next);
      onCodeChange?.(next);
    };

    void tick();
    const timer = window.setInterval(() => void tick(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parsed]);

  if ("error" in parsed) {
    return (
      <span className="totp-code totp-code--broken" title={parsed.error}>
        {BROKEN_MESSAGE}
      </span>
    );
  }

  const fraction = remaining / parsed.params.period;

  return (
    <span className="totp-code">
      <span className="totp-code__digits">{code ? formatCodeForDisplay(code) : "······"}</span>
      {/*
        Обратный отсчёт кольцом, а не текстом: цифра «7» рядом с цифрами кода
        читается как часть кода. Кольцо занимает столько же места и не спорит
        со значением.
      */}
      <span
        className="totp-code__timer"
        style={{ "--totp-fraction": String(fraction) } as React.CSSProperties}
        role="timer"
        aria-label={`Код действителен ещё ${Math.ceil(remaining)} секунд`}
      />
    </span>
  );
}
