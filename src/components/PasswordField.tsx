/**
 * Поле пароля с собственной кнопкой «показать/скрыть».
 *
 * Появилось 17.08.2026 по находке пользователя: на экране создания базы глаз
 * был виден только у одного из двух полей. Разгадка в том, что своей кнопки в
 * проекте не было вовсе - глаз рисовал сам WebView2 (`::-ms-reveal`), а он
 * показывается лишь у поля, которое сейчас в фокусе И уже содержит текст.
 * Отсюда и «иконка есть, но её не видно»: у первого поля она просто пропадала
 * при переходе ко второму. В настройках её не было по той же причине - там
 * поля успевали потерять фокус.
 *
 * Своя кнопка решает сразу три вещи: она всегда на месте, она одинаковая во
 * всех пяти местах, где в приложении вводят пароль, и она подчиняется
 * монохромной палитре, а не системному стилю Windows. Нативный `::-ms-reveal`
 * при этом погашен глобально в `tokens.css` - иначе на сфокусированном поле
 * было бы два глаза подряд.
 *
 * Состояние «показан» намеренно НЕ сбрасывается по потере фокуса: человек
 * сверяет пароль с повтором, переводя фокус между полями, и мигающая маска
 * ровно в этот момент раздражала бы. Сброс происходит, когда значение
 * очищается извне (успешная отправка формы) - см. эффект ниже.
 */
import { useEffect, useState } from "react";
import { EyeIcon } from "./icons";
import "./PasswordField.css";

export interface PasswordFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Класс самого `<input>` - поля выглядят по-разному на экране входа и в
   * настройках, а обёртка и кнопка одни и те же. */
  inputClassName?: string;
  /** Дополнительный класс обёртки - например, чтобы сузить поле PIN. */
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  autoComplete?: string;
  inputMode?: "numeric" | "text";
  maxLength?: number;
  spellCheck?: boolean;
}

const SHOW_LABEL = "Показать пароль";
const HIDE_LABEL = "Скрыть пароль";

export function PasswordField({
  id,
  value,
  onChange,
  inputClassName,
  className,
  disabled,
  autoFocus,
  autoComplete = "off",
  inputMode,
  maxLength,
  spellCheck = false,
}: PasswordFieldProps) {
  const [shown, setShown] = useState(false);

  // Форма очистила поле (обычно после успешной отправки) - показывать больше
  // нечего, и следующий ввод должен начинаться замаскированным, а не
  // унаследовать открытый режим от прошлого пароля.
  useEffect(() => {
    if (value === "") setShown(false);
  }, [value]);

  return (
    <div className={`password-field${className ? ` ${className}` : ""}`}>
      <input
        id={id}
        type={shown ? "text" : "password"}
        className={`password-field__input${inputClassName ? ` ${inputClassName}` : ""}`}
        value={value}
        onChange={(e) => onChange(e.currentTarget.value)}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        inputMode={inputMode}
        maxLength={maxLength}
        spellCheck={spellCheck}
      />
      <button
        type="button"
        className="password-field__toggle"
        onClick={() => setShown((prev) => !prev)}
        disabled={disabled}
        aria-label={shown ? HIDE_LABEL : SHOW_LABEL}
        aria-pressed={shown}
        title={shown ? HIDE_LABEL : SHOW_LABEL}
        // Кнопка не должна перехватывать Tab между полями формы: путь
        // «пароль -> повтор -> отправить» важнее, чем попасть на глаз с
        // клавиатуры. Мышью и через экранную читалку она доступна.
        tabIndex={-1}
      >
        <EyeIcon off={shown} />
      </button>
    </div>
  );
}
