/**
 * Маленькое окно, которое появляется по глобальному сочетанию клавиш.
 *
 * Отличается от `QuickAccess.tsx` тем, что основное приложение УЖЕ ЗАПУЩЕНО -
 * это то же самое окно/процесс, что и главное окно, просто спрятанное или
 * показанное. Данных у самого этого окна нет никогда: оно спрашивает у
 * основного окна названия и просит его же скопировать значение - см.
 * `lib/quickBridge.ts`, там объяснено почему.
 *
 * База в основном окне при этом может быть КАК открыта, так и заблокирована
 * (например, автоблокировкой, пока окно висело спрятанным) - при каждом
 * появлении окно заново спрашивает состояние (`QUICK_EVENTS.state`) и либо
 * сразу показывает поиск, либо просит PIN само (19.08.2026, найдено
 * пользователем: раньше в заблокированном случае поднималось ВСЁ основное
 * окно, что убивало саму идею быстрого вызова). PIN здесь работает по тому
 * же контракту, что и остальной `quickBridge.ts`: через границу окон уходят
 * только цифры PIN, а исход - основное окно расшифровывает базу у себя.
 *
 * Окно создаётся СКРЫТЫМ и показывается только после первой отрисовки: иначе
 * на долю секунды видна пустая рамка, и появление выглядит рывком, а не
 * возникновением.
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { emit, listen } from "@tauri-apps/api/event";
import {
  QUICK_EVENTS,
  type QuickCopiedPayload,
  type QuickCopyKind,
  type QuickResult,
  type QuickResultsPayload,
  type QuickStateResultPayload,
  type QuickUnlockedPayload,
} from "../lib/quickBridge";
import {
  visiblePinCellCount,
  shouldAttemptPinUnlock,
  isPinAttemptExhausted,
  PIN_SILENT_ATTEMPT_DELAY_MS,
  formatPinLockoutMessage,
} from "./LockScreen";
import { NO_PIN_MESSAGE } from "./QuickAccess";
import { PIN_MAX_LENGTH } from "../lib/pinLock";
import { UserIcon, KeyIcon, ClockIcon, CheckIcon } from "../components/icons";
import "../tokens.css";
import "./QuickWindow.css";

/** Через сколько окно закрывается само, если его бросили открытым. */
export const IDLE_HIDE_MS = 60_000;

/** Сколько держится подпись «скопировано». */
const COPIED_MS = 3000;

export const HINT = "Enter - пароль, Shift+Enter - логин, Esc - закрыть";

/** Состояние окна помимо самого поиска - что показывать, пока не выяснено
 * или пока база заблокирована. `search` - обычный режим, как было раньше. */
type Phase =
  | { kind: "loading" }
  | { kind: "noPin"; message: string }
  | { kind: "lockedOut" }
  | { kind: "pin" }
  | { kind: "search" };

export function QuickWindow() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
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

  const [pinValue, setPinValue] = useState("");
  const [pinProbedLength, setPinProbedLength] = useState(0);
  const [pinError, setPinError] = useState(false);
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [lockoutRemainingMs, setLockoutRemainingMs] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const idleRef = useRef<number | null>(null);
  const copiedRef = useRef<number | null>(null);
  const pinTimerRef = useRef<number | null>(null);
  const lockoutIntervalRef = useRef<number | null>(null);
  /** Порядковый номер попытки - устаревший ответ на уже неактуальный PIN
   * игнорируется, см. комментарий у `QuickUnlockPayload`. */
  const pinAttemptSeqRef = useRef(0);
  const readyEmittedRef = useRef(false);

  /** Спрятать окно, а не закрыть: следующий вызов сочетания должен быть
   * мгновенным, а создание окна заново стоит заметно дороже показа. */
  const hide = useCallback(() => {
    void getCurrentWindow().hide();
  }, []);

  const touch = useCallback(() => {
    if (idleRef.current !== null) window.clearTimeout(idleRef.current);
    idleRef.current = window.setTimeout(hide, IDLE_HIDE_MS);
  }, [hide]);

  /** Сообщить основному окну, что можно показывать. Ровно один раз за жизнь
   * окна: к моменту первого вызова уже известно, что рисовать - поиск, PIN
   * или сообщение - и человек увидит содержимое, а не пустую рамку. Повторные
   * показы (после `hide()`) окно уже видимо, эмитировать незачем. */
  const emitReadyOnce = useCallback(() => {
    if (readyEmittedRef.current) return;
    readyEmittedRef.current = true;
    void emit(QUICK_EVENTS.ready, {});
  }, []);

  const enterSearch = useCallback(() => {
    setPhase({ kind: "search" });
    setQuery("");
    setResults([]);
    setSelected(0);
    setPicking(false);
    setError(null);
    setCopied(null);
    void emit(QUICK_EVENTS.query, { query: "" });
    emitReadyOnce();
  }, [emitReadyOnce]);

  const enterLockedOut = useCallback((remainingMs: number) => {
    setPhase({ kind: "lockedOut" });
    setLockoutRemainingMs(remainingMs);
    setPinValue("");
    setPinProbedLength(0);
    if (lockoutIntervalRef.current !== null) window.clearInterval(lockoutIntervalRef.current);
    const deadline = Date.now() + remainingMs;
    // Тот же приём, что в LockScreen.tsx: форма сама открывается по
    // истечении срока, без нового обращения к основному окну.
    lockoutIntervalRef.current = window.setInterval(() => {
      const left = deadline - Date.now();
      if (left <= 0) {
        if (lockoutIntervalRef.current !== null) window.clearInterval(lockoutIntervalRef.current);
        lockoutIntervalRef.current = null;
        setPhase({ kind: "pin" });
        return;
      }
      setLockoutRemainingMs(left);
    }, 1000);
  }, []);

  /**
   * Заново спросить состояние блокировки. Вызывается и при первом монтировании,
   * и при каждом повторном показе: окно прячут, а не уничтожают, и за время,
   * пока оно было спрятано, база вполне могла заблокироваться автоблокировкой
   * или, наоборот, кто-то мог разблокировать её вручную в основном окне.
   */
  const refresh = useCallback(() => {
    setPhase({ kind: "loading" });
    setPinValue("");
    setPinProbedLength(0);
    setPinError(false);
    setPinMessage(null);
    if (lockoutIntervalRef.current !== null) {
      window.clearInterval(lockoutIntervalRef.current);
      lockoutIntervalRef.current = null;
    }
    if (pinTimerRef.current !== null) {
      window.clearTimeout(pinTimerRef.current);
      pinTimerRef.current = null;
    }
    void emit(QUICK_EVENTS.state, {});
  }, []);

  /**
   * Одна попытка PIN-а. Круговой путь через основное окно (запрос -> ответ),
   * поэтому `seq` - тот же приём, что `pinAttemptSeqRef`/`isCurrent()` в
   * LockScreen.tsx: за время ожидания ответа человек мог стереть/дописать
   * PIN, и запоздавший результат более старой попытки не должен подменить
   * уже более новое состояние экрана.
   */
  function requestUnlock(pin: string, counted: boolean, seq: number): Promise<QuickUnlockedPayload> {
    return new Promise((resolve) => {
      let off: (() => void) | null = null;
      void listen<QuickUnlockedPayload>(QUICK_EVENTS.unlocked, (event) => {
        if (event.payload.seq !== seq) return;
        off?.();
        resolve(event.payload);
      }).then((unlisten) => {
        off = unlisten;
      });
      void emit(QUICK_EVENTS.unlock, { pin, counted, seq });
    });
  }

  async function attemptPinUnlock(pin: string, counted: boolean) {
    const seq = ++pinAttemptSeqRef.current;
    const isCurrent = () => seq === pinAttemptSeqRef.current;
    const result = await requestUnlock(pin, counted, seq);
    if (!isCurrent()) return;

    if (result.ok) {
      enterSearch();
      return;
    }
    if (result.lockedOutRemainingMs !== undefined && result.lockedOutRemainingMs > 0) {
      enterLockedOut(result.lockedOutRemainingMs);
      return;
    }
    if (!counted) {
      // Тихая неудача: ничего не показываем, но теперь известно, что
      // набранного не хватило - открываем следующую пустую ячейку.
      setPinProbedLength((prev) => Math.max(prev, pin.length));
      return;
    }
    setPinValue("");
    setPinProbedLength(0);
    setPinError(true);
    setPinMessage(result.message ?? null);
  }

  // Подписки. Один раз за жизнь окна.
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
      const offState = await listen<QuickStateResultPayload>(QUICK_EVENTS.stateResult, (event) => {
        const { locked, hasPin, lockedOutRemainingMs } = event.payload;
        if (!locked) {
          enterSearch();
          return;
        }
        if (!hasPin) {
          setPhase({ kind: "noPin", message: NO_PIN_MESSAGE });
          emitReadyOnce();
          return;
        }
        if (lockedOutRemainingMs !== undefined && lockedOutRemainingMs > 0) {
          enterLockedOut(lockedOutRemainingMs);
          emitReadyOnce();
          return;
        }
        setPhase({ kind: "pin" });
        emitReadyOnce();
      });
      if (!alive) {
        offResults();
        offCopied();
        offState();
        return;
      }
      offs.push(offResults, offCopied, offState);
      refresh();
    })();

    touch();

    return () => {
      alive = false;
      for (const off of offs) off();
      if (idleRef.current !== null) window.clearTimeout(idleRef.current);
      if (copiedRef.current !== null) window.clearTimeout(copiedRef.current);
      if (lockoutIntervalRef.current !== null) window.clearInterval(lockoutIntervalRef.current);
      if (pinTimerRef.current !== null) window.clearTimeout(pinTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [touch]);

  /** Окно прячут, а не уничтожают, поэтому при повторном показе оно остаётся
   * в прошлом состоянии - сброс делается по возвращению фокуса, это ровно
   * момент нового вызова. */
  useEffect(() => {
    const onFocus = () => {
      refresh();
      touch();
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [touch, refresh]);

  /** Фокус в нужное поле при смене фазы - то же самое, что делает QuickAccess.tsx. */
  useEffect(() => {
    if (phase.kind === "pin") pinInputRef.current?.focus();
    if (phase.kind === "search") inputRef.current?.focus();
  }, [phase.kind]);

  function runSearch(next: string) {
    setQuery(next);
    touch();
    void emit(QUICK_EVENTS.query, { query: next });
  }

  function copy(id: string, kind: QuickCopyKind, index?: number) {
    touch();
    void emit(QUICK_EVENTS.copy, { id, kind, index });
  }

  function handlePinChange(next: string) {
    setPinValue(next);
    setPinError(false);
    setPinMessage(null);
    if (next === "") setPinProbedLength(0);
    touch();
    if (pinTimerRef.current !== null) window.clearTimeout(pinTimerRef.current);
    if (!shouldAttemptPinUnlock(next)) return;
    pinTimerRef.current = window.setTimeout(() => {
      void attemptPinUnlock(next, isPinAttemptExhausted(next));
    }, PIN_SILENT_ATTEMPT_DELAY_MS);
  }

  /** Тот же приём, что на обычном экране входа: щелчок в любое свободное
   * место возвращает курсор в ввод PIN. Попадать в маленькую мишень мышью
   * незачем. */
  function handleClick(e: MouseEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    if (target?.closest("button, input, textarea, a, [role='button']")) return;
    if (phase.kind === "pin") pinInputRef.current?.focus();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    touch();
    if (e.key === "Escape") {
      e.preventDefault();
      hide();
      return;
    }
    if (phase.kind === "pin") {
      if (e.key === "Enter") {
        e.preventDefault();
        if (!shouldAttemptPinUnlock(pinValue)) return;
        if (pinTimerRef.current !== null) window.clearTimeout(pinTimerRef.current);
        void attemptPinUnlock(pinValue, true);
      }
      return;
    }
    if (phase.kind !== "search") return;
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
        if (item.loginIndex !== null) copy(item.id, "login", item.loginIndex);
      } else {
        copy(item.id, "password", item.passwordIndex);
      }
    }
  }

  return (
    <div className="qwin" onKeyDown={handleKeyDown} onClick={handleClick}>
      <div className="qwin__drag" data-tauri-drag-region />
      <button type="button" className="qwin__close" onClick={hide} aria-label="Закрыть" title="Закрыть">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      {phase.kind === "loading" && <p className="qwin__message">Открываю...</p>}
      {phase.kind === "noPin" && <p className="qwin__message">{phase.message}</p>}

      {phase.kind === "lockedOut" && (
        <p className="qwin__message qwin__message--error">
          {formatPinLockoutMessage(lockoutRemainingMs)}
        </p>
      )}

      {phase.kind === "pin" && (
        <div className="qwin__pin" onClick={() => pinInputRef.current?.focus()} role="presentation">
          <div className={`qwin__pin-row${pinError ? " qwin__pin--error" : ""}`}>
            <input
              ref={pinInputRef}
              type="password"
              inputMode="numeric"
              autoComplete="off"
              maxLength={PIN_MAX_LENGTH}
              className="qwin__pin-input"
              aria-label="PIN-код"
              value={pinValue}
              onChange={(e) => handlePinChange(e.currentTarget.value.replace(/\D/g, ""))}
            />
            {Array.from({ length: visiblePinCellCount(pinValue.length, pinProbedLength) }, (_, i) => (
              <span
                key={i}
                aria-hidden="true"
                className={
                  "qwin__pin-cell" +
                  (i < pinValue.length ? " qwin__pin-cell--filled" : "") +
                  (i === pinValue.length ? " qwin__pin-cell--next" : "")
                }
              />
            ))}
          </div>
          {pinMessage && <p className="qwin__message qwin__message--error qwin__message--pin">{pinMessage}</p>}
        </div>
      )}

      {phase.kind === "search" && (
        <>
          <input
            ref={inputRef}
            type="search"
            className="qwin__search"
            placeholder="Поиск: название, логин, тег"
            aria-label="Поиск записей"
            value={query}
            onChange={(e) => runSearch(e.currentTarget.value)}
          />

          <ul className="qwin__results">
            {results.length === 0 && <li className="qwin__empty">Ничего не найдено</li>}
            {results.map((item, index) => (
              <li
                // Индекс в ключе обязателен: в записи бывают два секретных поля с
                // одинаковым именем, и без него ключи совпадали бы.
                key={`${item.id}:${item.passwordIndex}`}
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
                  {item.loginIndex !== null && (
                    <button
                      type="button"
                      className="qwin__btn"
                      aria-label="Скопировать логин"
                      title="Скопировать логин"
                      onClick={() => copy(item.id, "login", item.loginIndex ?? undefined)}
                    >
                      {copied === "логин" && index === selected && picking ? <CheckIcon size={14} /> : <UserIcon size={14} />}
                    </button>
                  )}
                  <button
                    type="button"
                    className="qwin__btn"
                    aria-label="Скопировать пароль"
                    title="Скопировать пароль"
                    onClick={() => copy(item.id, "password", item.passwordIndex)}
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
        </>
      )}
    </div>
  );
}
