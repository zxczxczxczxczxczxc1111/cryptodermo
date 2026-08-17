/**
 * Маленькое окно, которое появляется по глобальному сочетанию клавиш.
 *
 * Отличается от `QuickAccess.tsx` тем, что основное приложение УЖЕ ОТКРЫТО и
 * база расшифрована. Поэтому PIN здесь не спрашивается вовсе, а данных у окна
 * нет: оно спрашивает у основного окна названия и просит его же скопировать
 * значение - см. `lib/quickBridge.ts`, там объяснено почему.
 *
 * Окно создаётся СКРЫТЫМ и показывается только после первой отрисовки: иначе
 * на долю секунды видна пустая рамка, и появление выглядит рывком, а не
 * возникновением.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import {
  QUICK_EVENTS,
  type QuickCopiedPayload,
  type QuickCopyKind,
  type QuickResult,
  type QuickResultsPayload,
} from "../lib/quickBridge";
import { UserIcon, KeyIcon, ClockIcon, CheckIcon } from "../components/icons";
import "../tokens.css";
import "./QuickWindow.css";

/** Через сколько окно закрывается само, если его бросили открытым. */
export const IDLE_HIDE_MS = 60_000;

/** Сколько держится подпись «скопировано». */
const COPIED_MS = 3000;

export const HINT = "Enter - пароль, Shift+Enter - логин, Esc - закрыть";

export function QuickWindow() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<QuickResult[]>([]);
  const [selected, setSelected] = useState(0);
  /**
   * Начал ли человек выбирать.
   *
   * До первого действия подсветки нет вовсе: при открытии первая строка
   * выглядела выбранной, хотя человек ничего не выбирал (замечено
   * пользователем 17.08.2026). Стрелки, наведение мышью и новый запрос
   * включают её. Enter до этого момента всё равно берёт первую строку -
   * иначе он бы просто ничего не делал.
   */
  const [picking, setPicking] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const idleRef = useRef<number | null>(null);
  const copiedRef = useRef<number | null>(null);

  /** Спрятать окно, а не закрыть: следующий вызов сочетания должен быть
   * мгновенным, а создание окна заново стоит заметно дороже показа. */
  const hide = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  const touch = useCallback(() => {
    if (idleRef.current !== null) window.clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(hide, IDLE_HIDE_MS);
  }, [hide]);

  // Подписки и сообщение «я готов». Один раз за жизнь окна.
  useEffect(() => {
    let alive = true;
    const offs: Array<() => void> = [];

    void (async () => {
      const offResults = await listen<QuickResultsPayload>(QUICK_EVENTS.results, (event) => {
        setResults(event.payload.results);
        setSelected(0);
        setPicking(false);
      });
      const offCopied = await listen<QuickCopiedPayload>(QUICK_EVENTS.copied, (event) => {
        if (event.payload.error) {
          setError(event.payload.error);
          return;
        }
        setError(null);
        setCopied(event.payload.label);
        if (copiedRef.current !== null) window.clearTimeout(copiedRef.current);
        copiedRef.current = window.setTimeout(() => setCopied(null), COPIED_MS);
      });
      if (!alive) {
        offResults();
        offCopied();
        return;
      }
      offs.push(offResults, offCopied);
      void emit(QUICK_EVENTS.query, { query: "" });
      // Сообщаем основному окну, что можно показывать: к этому моменту список
      // уже запрошен, и человек увидит окно с содержимым, а не пустую рамку.
      void emit(QUICK_EVENTS.ready, {});
    })();

    touch();
    inputRef.current?.focus();

    return () => {
      alive = false;
      for (const off of offs) off();
      if (idleRef.current !== null) window.clearTimeout(idleRef.current);
      if (copiedRef.current !== null) window.clearTimeout(copiedRef.current);
    };
  }, [touch]);

  /**
   * Окно прячут, а не уничтожают, поэтому при повторном показе оно остаётся с
   * прошлым запросом на экране. Сброс делается по возвращению фокуса: это
   * ровно момент нового вызова.
   */
  useEffect(() => {
    const onFocus = () => {
      setQuery("");
      setCopied(null);
      setError(null);
      void emit(QUICK_EVENTS.query, { query: "" });
      inputRef.current?.focus();
      touch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [touch]);

  function runSearch(next: string) {
    setQuery(next);
    touch();
    void emit(QUICK_EVENTS.query, { query: next });
  }

  function copy(id: string, kind: QuickCopyKind, field?: string) {
    touch();
    void emit(QUICK_EVENTS.copy, { id, kind, field });
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    touch();
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      // Первая стрелка вниз не двигает выбор, а зажигает его на первой строке:
      // иначе одно нажатие уводило бы сразу на вторую.
      setSelected((i) => (picking ? Math.min(results.length - 1, i + 1) : 0));
      setPicking(true);
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (picking ? Math.max(0, i - 1) : 0));
      setPicking(true);
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = results[selected];
      if (!item) return;
      if (e.shiftKey) {
        if (item.loginField) copy(item.id, "login", item.loginField);
      } else {
        copy(item.id, "password", item.passwordField);
      }
    }
  }

  return (
    <div className="qwin" onKeyDown={handleKeyDown}>
      <div className="qwin__drag" data-tauri-drag-region />
      <button type="button" className="qwin__close" onClick={hide} aria-label="Закрыть" title="Закрыть">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      <input
        ref={inputRef}
        type="search"
        className="qwin__search"
        placeholder="Поиск: название, логин, тег"
        aria-label="Поиск записей"
        value={query}
        onChange={(e) => runSearch(e.currentTarget.value)}
        autoFocus
      />

      <ul className="qwin__results">
        {results.length === 0 && <li className="qwin__empty">Ничего не найдено</li>}
        {results.map((item, index) => (
          <li
            // Индекс в ключе обязателен: в записи бывают два секретных поля с
            // одинаковым именем, и без него ключи совпадали бы.
            key={`${item.id}:${item.passwordField}:${index}`}
            className={`qwin__row${picking && index === selected ? " qwin__row--active" : ""}`}
            onMouseEnter={() => {
              setSelected(index);
              setPicking(true);
            }}
          >
            <span className="qwin__row-text">
              <span className="qwin__row-title">{item.title || "(без названия)"}</span>
              {/* Уточнение появляется только у записей с несколькими парами -
                  иначе оно было бы шумом в каждой строке. */}
              {item.detail && <span className="qwin__row-detail">{item.detail}</span>}
            </span>
            <span className="qwin__row-actions">
              {item.loginField && (
                <button
                  type="button"
                  className="qwin__btn"
                  aria-label="Скопировать логин"
                  title="Скопировать логин"
                  onClick={() => copy(item.id, "login", item.loginField ?? undefined)}
                >
                  {copied === "логин" && index === selected && picking ? <CheckIcon size={14} /> : <UserIcon size={14} />}
                </button>
              )}
              <button
                type="button"
                className="qwin__btn"
                aria-label="Скопировать пароль"
                title="Скопировать пароль"
                onClick={() => copy(item.id, "password", item.passwordField)}
              >
                {copied === "пароль" && index === selected && picking ? <CheckIcon size={14} /> : <KeyIcon size={14} />}
              </button>
              {item.hasTotp && (
                <button
                  type="button"
                  className="qwin__btn"
                  aria-label="Скопировать код двухфакторки"
                  title="Скопировать код двухфакторки"
                  onClick={() => copy(item.id, "totp")}
                >
                  {copied === "код" && index === selected && picking ? <CheckIcon size={14} /> : <ClockIcon size={14} />}
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      <p className={`qwin__hint${copied ? " qwin__hint--copied" : ""}${error ? " qwin__hint--error" : ""}`}>
        {error ?? (copied ? `Скопирован ${copied}` : HINT)}
      </p>
    </div>
  );
}
