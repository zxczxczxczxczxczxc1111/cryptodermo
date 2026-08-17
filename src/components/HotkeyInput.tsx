/**
 * Поле для назначения сочетания клавиш.
 *
 * Работает как в любой программе с настраиваемыми клавишами: нажал на поле -
 * оно ждёт, нажал сочетание - оно записалось. Печатать сочетание текстом
 * нельзя, и это правильно: человек не обязан знать, что Ctrl здесь называется
 * `CommandOrControl`.
 *
 * Пока поле ждёт нажатия, оно перехватывает клавиатуру целиком, включая Tab и
 * Escape - иначе назначить сочетание с ними было бы невозможно, а Escape
 * заодно уносил бы из настроек.
 */
import { useEffect, useRef, useState } from "react";
import { accelFromEvent, formatAccel } from "../lib/hotkey";
import "./HotkeyInput.css";

export interface HotkeyInputProps {
  value: string;
  onChange: (accel: string) => void;
  disabled?: boolean;
}

const WAITING_LABEL = "Нажмите сочетание...";
const REJECTED_HINT = "Нужен Ctrl или Alt: сочетание перехватывается во всей системе";

export function HotkeyInput({ value, onChange, disabled }: HotkeyInputProps) {
  const [listening, setListening] = useState(false);
  const [rejected, setRejected] = useState(false);
  const boxRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!listening) return;
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape") {
        setListening(false);
        setRejected(false);
        return;
      }
      const accel = accelFromEvent(e);
      if (!accel) {
        // Нажали один модификатор - это ещё не отказ, человек просто держит
        // Ctrl и выбирает вторую клавишу. Ругаться на это было бы навязчиво.
        if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) return;
        setRejected(true);
        return;
      }
      onChange(accel);
      setRejected(false);
      setListening(false);
    };
    // `capture: true` - перехватить до того, как нажатие увидят обработчики
    // экрана настроек и всего приложения.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [listening, onChange]);

  return (
    <div className="hotkey">
      <button
        ref={boxRef}
        type="button"
        className={`hotkey__box${listening ? " hotkey__box--listening" : ""}`}
        onClick={() => {
          setRejected(false);
          setListening((prev) => !prev);
        }}
        onBlur={() => setListening(false)}
        disabled={disabled}
        aria-label={listening ? WAITING_LABEL : `Сочетание клавиш: ${formatAccel(value)}`}
      >
        {listening ? WAITING_LABEL : formatAccel(value)}
      </button>
      {rejected && <span className="hotkey__hint">{REJECTED_HINT}</span>}
    </div>
  );
}
