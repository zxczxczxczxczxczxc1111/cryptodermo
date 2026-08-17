/**
 * Окно быстрого доступа.
 *
 * Запускается ярлыком с флагом `--quick`, на который человек вешает сочетание
 * клавиш в свойствах ярлыка Windows (поле «Быстрый вызов»). Отдельного
 * плагина глобальных горячих клавиш для этого не нужно, и приложение не обязано
 * постоянно висеть в памяти - решение принято с пользователем 17.08.2026,
 * когда выяснилось, что резидентная программа ради одной клавиши не нужна.
 *
 * Сценарий целиком: вызвал, ввёл PIN, набрал три буквы, Enter, пароль в буфере,
 * окно исчезло. Мышь не нужна ни разу, но всё то же можно сделать и мышью.
 *
 * ТРИ РЕШЕНИЯ, КОТОРЫЕ ВАЖНЕЕ ОСТАЛЬНОГО:
 *
 * 1. Окно НЕ закрывается по потере фокуса. Так делает большинство подобных
 *    всплывашек, и здесь это было бы прямо вредно: окно и вызывают затем,
 *    чтобы уйти в браузер и вставить пароль. Вместо этого есть крестик и
 *    самозакрытие по бездействию (`IDLE_CLOSE_MS`).
 *
 * 2. После копирования окно прячется мгновенно, но ПРОЦЕСС ЖИВЁТ до тех пор,
 *    пока не сработает автоочистка буфера обмена. Иначе получилось бы, что
 *    быстрый режим тихо ломает главную защитную механику приложения: таймер
 *    очистки живёт внутри процесса, и завершись процесс сразу - пароль остался
 *    бы в буфере навсегда.
 *
 * 3. Режим работает только с настроенным PIN. Мастер-пароль это пять миллионов
 *    итераций и несколько секунд ожидания, что убивает саму идею «быстро».
 */
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { getCurrentWindow, LogicalSize } from "@tauri-apps/api/window";
import { VaultStore, type Item } from "../lib/vaultStore";
import { readVault, exeDir } from "../lib/tauriApi";
import { readSettings } from "../lib/settingsConfig";
import { copyWithAutoClear, CLIPBOARD_CLEAR_MS } from "../lib/clipboard";
import { submitPinUnlock, visiblePinCellCount, shouldAttemptPinUnlock } from "./LockScreen";
import { PIN_MAX_LENGTH, type PinWrap } from "../lib/pinLock";
import { looksLikeTotp, parseOtpauth, totpCode } from "../lib/totp";
import { CopyIcon, CheckIcon } from "../components/icons";
import "../tokens.css";
import "./QuickAccess.css";

/** Размер окна до ввода PIN и после, логические пиксели. */
const SIZE_LOCKED = { width: 380, height: 150 };
const SIZE_OPEN = { width: 560, height: 420 };

/** Сколько окно ждёт без единого действия, прежде чем закрыться само. Отсчёт
 * идёт от последнего действия, а не от открытия: иначе окно исчезало бы прямо
 * посреди набора. */
export const IDLE_CLOSE_MS = 60_000;

/** Сколько результатов показывать. Больше семи в окне такой высоты не
 * помещается, а листать длинный список в режиме «быстро» никто не станет:
 * проще дописать буквы. */
export const MAX_RESULTS = 7;

const VAULT_FILENAME = "vault.dat";

/** Что копирует Enter и что Shift+Enter. Выбрано пользователем 17.08.2026. */
export const PRIMARY_HINT = "Enter - пароль, Shift+Enter - логин, Esc - закрыть";

export const NO_PIN_MESSAGE =
  "Быстрый доступ работает только с настроенным PIN-кодом. Откройте приложение обычным способом и включите PIN в настройках.";

/** Какое поле отдать по Enter и какое по Shift+Enter. Те же правила, что у
 * быстрого копирования в списке: первое секретное - это и есть пароль. */
export function primaryField(item: Item) {
  return item.fields.find((f) => f.secret && !looksLikeTotp(f.value)) ?? item.fields[0] ?? null;
}

export function secondaryField(item: Item) {
  return item.fields.find((f) => !f.secret) ?? null;
}

export function totpField(item: Item) {
  return item.fields.find((f) => looksLikeTotp(f.value)) ?? null;
}

/** Путь к базе - та же логика, что в App.tsx: сохранённый путь, иначе рядом
 * с исполняемым файлом. */
async function resolveVaultPath(): Promise<string> {
  const dir = await exeDir();
  const separator = dir.includes("\\") ? "\\" : "/";
  const defaultPath = `${dir}${dir.endsWith(separator) ? "" : separator}${VAULT_FILENAME}`;
  const settings = await readSettings(defaultPath);
  return settings.lastVaultPath && settings.lastVaultPath.trim() !== ""
    ? settings.lastVaultPath
    : defaultPath;
}

type Phase =
  | { kind: "loading" }
  | { kind: "noPin" }
  | { kind: "error"; message: string }
  | { kind: "pin" }
  | { kind: "open" };

export function QuickAccess() {
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [pinValue, setPinValue] = useState("");
  const [pinProbedLength, setPinProbedLength] = useState(0);
  const [pinError, setPinError] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Item[]>([]);
  const [selected, setSelected] = useState(0);
  const [copied, setCopied] = useState<string | null>(null);

  const storeRef = useRef<VaultStore | null>(null);
  const bytesRef = useRef<Uint8Array | null>(null);
  const wrapRef = useRef<PinWrap | null>(null);
  const pathRef = useRef<string>("");
  const searchRef = useRef<HTMLInputElement>(null);
  const pinInputRef = useRef<HTMLInputElement>(null);
  const idleTimerRef = useRef<number | null>(null);

  /** Закрыть окно и завершить процесс. Единственная точка выхода. */
  const quit = useCallback(() => {
    void getCurrentWindow().destroy();
  }, []);

  /** Любое действие человека отодвигает самозакрытие. */
  const touch = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(quit, IDLE_CLOSE_MS);
  }, [quit]);

  useEffect(() => {
    touch();
    return () => {
      if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current);
    };
  }, [touch]);

  // Начальная подготовка: размер окна, путь к базе, наличие PIN.
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const win = getCurrentWindow();
        await win.setResizable(false);
        await win.setSize(new LogicalSize(SIZE_LOCKED.width, SIZE_LOCKED.height));
        await win.center();
      } catch (err) {
        console.error("QuickAccess: не удалось настроить окно", err);
      }

      try {
        const path = await resolveVaultPath();
        if (!alive) return;
        pathRef.current = path;
        const settings = await readSettings(path);
        if (!alive) return;
        if (!settings.pin) {
          setPhase({ kind: "noPin" });
          return;
        }
        wrapRef.current = settings.pin;
        bytesRef.current = await readVault(path);
        if (!alive) return;
        setPhase({ kind: "pin" });
      } catch (err) {
        console.error("QuickAccess: не удалось подготовить быстрый доступ", err);
        if (alive) setPhase({ kind: "error", message: "База не найдена или недоступна" });
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (phase.kind === "pin") pinInputRef.current?.focus();
    if (phase.kind === "open") searchRef.current?.focus();
  }, [phase.kind]);

  async function attemptUnlock(pin: string) {
    const bytes = bytesRef.current;
    const wrap = wrapRef.current;
    if (!bytes || !wrap) return;
    const result = await submitPinUnlock({
      existingBytes: bytes,
      pinWrap: wrap,
      pin,
      vaultPath: pathRef.current,
      onUnlock: (store) => {
        storeRef.current = store;
        setResults(store.search("").slice(0, MAX_RESULTS));
        setPhase({ kind: "open" });
        void (async () => {
          try {
            const win = getCurrentWindow();
            await win.setSize(new LogicalSize(SIZE_OPEN.width, SIZE_OPEN.height));
            await win.center();
          } catch (err) {
            console.error("QuickAccess: не удалось увеличить окно", err);
          }
        })();
      },
    });
    if (!result.ok) {
      // Ячейки растут только по факту неудачи - тот же принцип, что и на
      // обычном экране входа: иначе верный короткий PIN успевал бы дорисовать
      // лишнюю пустую ячейку.
      setPinProbedLength((prev) => Math.max(prev, pin.length));
      if (pin.length >= PIN_MAX_LENGTH) {
        setPinError(true);
        setPinValue("");
        setPinProbedLength(0);
      }
    }
  }

  function handlePinChange(next: string) {
    setPinValue(next);
    setPinError(false);
    if (next === "") setPinProbedLength(0);
    touch();
    if (shouldAttemptPinUnlock(next)) void attemptUnlock(next);
  }

  function runSearch(next: string) {
    setQuery(next);
    setSelected(0);
    touch();
    const store = storeRef.current;
    if (store) setResults(store.search(next).slice(0, MAX_RESULTS));
  }

  /**
   * Скопировать и уйти.
   *
   * Окно прячется сразу, а процесс доживает до автоочистки буфера - см.
   * комментарий модуля. Дополнительный запас в секунду: очистка ставится тем же
   * таймером, и завершиться ровно в его миллисекунду значит иногда не успеть.
   */
  async function copyAndLeave(value: string, label: string) {
    try {
      await copyWithAutoClear(value);
      setCopied(label);
      const win = getCurrentWindow();
      await win.hide();
      window.setTimeout(quit, CLIPBOARD_CLEAR_MS + 1000);
    } catch (err) {
      console.error("QuickAccess: не удалось скопировать значение", err);
      setCopied(null);
    }
  }

  /** Код двухфакторки считается по требованию: держать его тикающим в окне,
   * которое живёт секунды, незачем. */
  async function copyTotp(item: Item) {
    const field = totpField(item);
    if (!field) return;
    try {
      const code = await totpCode(parseOtpauth(field.value), Date.now() / 1000);
      await copyAndLeave(code, "код");
    } catch (err) {
      console.error("QuickAccess: не удалось посчитать код двухфакторки", err);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    touch();
    if (e.key === "Escape") {
      e.preventDefault();
      quit();
      return;
    }
    if (phase.kind !== "open") return;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => Math.min(results.length - 1, i + 1));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => Math.max(0, i - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const item = results[selected];
      if (!item) return;
      const field = e.shiftKey ? secondaryField(item) : primaryField(item);
      if (field) void copyAndLeave(field.value, e.shiftKey ? "логин" : "пароль");
      return;
    }
  }

  return (
    <div className="quick" onKeyDown={handleKeyDown}>
      <div className="quick__drag" data-tauri-drag-region />
      <button type="button" className="quick__close" onClick={quit} aria-label="Закрыть" title="Закрыть">
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path d="M0 0l10 10M10 0L0 10" stroke="currentColor" strokeWidth="1" />
        </svg>
      </button>

      {phase.kind === "loading" && <p className="quick__message">Открываю...</p>}
      {phase.kind === "noPin" && <p className="quick__message">{NO_PIN_MESSAGE}</p>}
      {phase.kind === "error" && <p className="quick__message quick__message--error">{phase.message}</p>}

      {phase.kind === "pin" && (
        <div className={`quick__pin${pinError ? " quick__pin--error" : ""}`} onClick={() => pinInputRef.current?.focus()} role="presentation">
          <input
            ref={pinInputRef}
            type="password"
            inputMode="numeric"
            autoComplete="off"
            maxLength={PIN_MAX_LENGTH}
            className="quick__pin-input"
            aria-label="PIN-код"
            value={pinValue}
            onChange={(e) => handlePinChange(e.currentTarget.value.replace(/\D/g, ""))}
          />
          {Array.from({ length: visiblePinCellCount(pinValue.length, pinProbedLength) }, (_, i) => (
            <span
              key={i}
              aria-hidden="true"
              className={
                "quick__pin-cell" +
                (i < pinValue.length ? " quick__pin-cell--filled" : "") +
                (i === pinValue.length ? " quick__pin-cell--next" : "")
              }
            />
          ))}
        </div>
      )}

      {phase.kind === "open" && (
        <>
          <input
            ref={searchRef}
            type="search"
            className="quick__search"
            placeholder="Поиск: название, логин, тег"
            aria-label="Поиск записей"
            value={query}
            onChange={(e) => runSearch(e.currentTarget.value)}
          />
          <ul className="quick__results">
            {results.length === 0 && <li className="quick__empty">Ничего не найдено</li>}
            {results.map((item, index) => (
              <li
                key={item.id}
                className={`quick__row${index === selected ? " quick__row--active" : ""}`}
                onMouseEnter={() => setSelected(index)}
              >
                <span className="quick__row-title">{item.title || "(без названия)"}</span>
                <span className="quick__row-actions">
                  {totpField(item) && (
                    <button
                      type="button"
                      className="quick__row-btn"
                      onClick={() => void copyTotp(item)}
                      title="Скопировать код двухфакторки"
                      aria-label="Скопировать код двухфакторки"
                    >
                      2FA
                    </button>
                  )}
                  {secondaryField(item) && (
                    <button
                      type="button"
                      className="quick__row-btn"
                      onClick={() => {
                        const f = secondaryField(item);
                        if (f) void copyAndLeave(f.value, "логин");
                      }}
                      title="Скопировать логин"
                      aria-label="Скопировать логин"
                    >
                      Логин
                    </button>
                  )}
                  {primaryField(item) && (
                    <button
                      type="button"
                      className="quick__row-btn quick__row-btn--icon"
                      onClick={() => {
                        const f = primaryField(item);
                        if (f) void copyAndLeave(f.value, "пароль");
                      }}
                      title="Скопировать пароль"
                      aria-label="Скопировать пароль"
                    >
                      {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                    </button>
                  )}
                </span>
              </li>
            ))}
          </ul>
          <p className="quick__hint">{copied ? `Скопирован ${copied}` : PRIMARY_HINT}</p>
        </>
      )}
    </div>
  );
}
