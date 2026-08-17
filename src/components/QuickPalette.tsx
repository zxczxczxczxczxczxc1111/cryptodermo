/**
 * Быстрый поиск внутри приложения. Ctrl+K из любого экрана.
 *
 * То же, что окно быстрого доступа, только когда приложение уже открыто:
 * набрал несколько букв, Enter кладёт пароль в буфер, Shift+Enter логин,
 * Escape закрывает. Разница в том, что здесь не нужен ни PIN, ни запуск - база
 * уже расшифрована и лежит в памяти.
 *
 * Зачем отдельно от списка, в котором и так есть поиск: чтобы добраться до него
 * из редактора или настроек, надо сначала уйти оттуда, а это как раз то, чего
 * не хочется в момент «нужен пароль прямо сейчас». Палитра открывается поверх
 * чего угодно и ничего не закрывает под собой.
 *
 * Логика выбора полей общая с окном быстрого доступа (`primaryField` и
 * соседи импортируются оттуда) - иначе Enter копировал бы в двух местах разное.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { VaultStore } from "../lib/vaultStore";
import { copyWithAutoClear } from "../lib/clipboard";
import { parseOtpauth, totpCode } from "../lib/totp";
import { totpField, MAX_RESULTS } from "../screens/QuickAccess";
import { buildQuickRows, type QuickResult } from "../lib/quickBridge";
import { useModalFocus } from "../hooks/useModalFocus";
import { UserIcon, KeyIcon, ClockIcon, CheckIcon } from "./icons";
import "./QuickPalette.css";

/** Сколько держится подтверждение копирования. */
const COPIED_MS = 2500;

export const PALETTE_HINT = "Enter - пароль, Shift+Enter - логин, Esc - закрыть";

/** Открывает ли это нажатие палитру. Вынесено отдельной функцией: сочетание
 * проверяется в глобальном обработчике, и его стоит уметь проверить тестом. */
export function isPaletteHotkey(e: { ctrlKey: boolean; metaKey: boolean; key: string }): boolean {
  return (e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K");
}

export interface QuickPaletteProps {
  store: VaultStore;
  /** Растущий счётчик - просьба открыть палитру снаружи (глобальное сочетание).
   * Счётчик, а не флаг: повторное нажатие должно срабатывать снова, а флаг
   * после первого раза остался бы в том же значении. */
  openSignal?: number;
  /** Открыть запись целиком - палитра при этом закрывается. */
  onOpenItem: (id: string) => void;
}

export function QuickPalette({ store, openSignal = 0, onOpenItem }: QuickPaletteProps) {
  const [open, setOpen] = useState(false);
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

  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | null>(null);
  useModalFocus(boxRef, open);

  // Глобальное сочетание. На window, а не на корневом элементе экрана: фокус
  // может быть в поле ввода редактора, и обработчик экрана до него не дойдёт.
  useEffect(() => {
    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (!isPaletteHotkey(e)) return;
      e.preventDefault();
      setOpen((prev) => !prev);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  // Просьба снаружи. Пропускается при первом рендере: начальное значение
  // счётчика не должно распахивать палитру на старте приложения.
  const firstSignalRef = useRef(true);
  useEffect(() => {
    if (firstSignalRef.current) {
      firstSignalRef.current = false;
      return;
    }
    setOpen(true);
  }, [openSignal]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelected(0);
    setPicking(false);
    setCopied(null);
    setResults(buildQuickRows(store.search("")).slice(0, MAX_RESULTS));
    // Фокус ставится после отрисовки: до неё поля ещё нет в документе.
    const id = window.setTimeout(() => inputRef.current?.focus(), 0);
    return () => window.clearTimeout(id);
  }, [open, store]);

  useEffect(() => {
    return () => {
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
    };
  }, []);

  if (!open) return null;

  function runSearch(next: string) {
    setQuery(next);
    setSelected(0);
    setResults(buildQuickRows(store.search(next)).slice(0, MAX_RESULTS));
  }

  async function copyValue(value: string, label: string) {
    try {
      await copyWithAutoClear(value);
      setCopied(label);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => setCopied(null), COPIED_MS);
    } catch (err) {
      console.error("QuickPalette: не удалось скопировать значение", err);
    }
  }

  /** Значение конкретного поля записи. Поле называется явно: в записи может
   * быть несколько паролей, и «первое подходящее» - та самая ошибка, из-за
   * которой строки стали парами. */
  function fieldValue(id: string, name: string | null): string | null {
    if (!name) return null;
    const item = store.search("").find((i) => i.id === id);
    return item?.fields.find((f) => f.name === name)?.value ?? null;
  }

  async function copyTotp(id: string) {
    const item = store.search("").find((i) => i.id === id);
    const field = item ? totpField(item) : null;
    if (!field) return;
    try {
      await copyValue(await totpCode(parseOtpauth(field.value), Date.now() / 1000), "код");
    } catch (err) {
      console.error("QuickPalette: не удалось посчитать код двухфакторки", err);
    }
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
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
      // Ctrl+Enter открывает запись целиком: иногда нужен не пароль, а сама
      // карточка, и возвращаться за ней в список было бы лишним шагом.
      if (e.ctrlKey) {
        setOpen(false);
        onOpenItem(item.id);
        return;
      }
      const value = e.shiftKey
        ? fieldValue(item.id, item.loginField)
        : fieldValue(item.id, item.passwordField);
      if (value !== null) void copyValue(value, e.shiftKey ? "логин" : "пароль");
    }
  }

  return (
    <div className="palette-overlay" role="presentation" onMouseDown={() => setOpen(false)}>
      {/* `stopPropagation` на самом окне: щелчок по затемнению закрывает
          палитру, щелчок внутри - нет. */}
      <div
        ref={boxRef}
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Быстрый поиск"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <input
          ref={inputRef}
          type="search"
          className="palette__input"
          placeholder="Поиск: название, логин, тег"
          aria-label="Быстрый поиск записей"
          value={query}
          onChange={(e) => runSearch(e.currentTarget.value)}
        />
        <ul className="palette__results">
          {results.length === 0 && <li className="palette__empty">Ничего не найдено</li>}
          {results.map((item, index) => (
            <li
              // Индекс в ключе обязателен: в записи бывают два секретных поля с
            // одинаковым именем, и без него ключи совпадали бы.
            key={`${item.id}:${item.passwordField}:${index}`}
              className={`palette__row${picking && index === selected ? " palette__row--active" : ""}`}
              onMouseEnter={() => {
              setSelected(index);
              setPicking(true);
            }}
            >
              <span className="palette__row-text">
                <span className="palette__row-title">{item.title || "(без названия)"}</span>
                {item.detail && <span className="palette__row-detail">{item.detail}</span>}
              </span>
              <span className="palette__row-actions">
                {item.loginField && (
                  <button
                    type="button"
                    className="palette__btn"
                    aria-label="Скопировать логин"
                    title="Скопировать логин"
                    onClick={() => {
                      const v = fieldValue(item.id, item.loginField);
                      if (v !== null) void copyValue(v, "логин");
                    }}
                  >
                    {copied === "логин" && index === selected && picking ? <CheckIcon size={14} /> : <UserIcon size={14} />}
                  </button>
                )}
                <button
                  type="button"
                  className="palette__btn"
                  aria-label="Скопировать пароль"
                  title="Скопировать пароль"
                  onClick={() => {
                    const v = fieldValue(item.id, item.passwordField);
                    if (v !== null) void copyValue(v, "пароль");
                  }}
                >
                  {copied === "пароль" && index === selected && picking ? <CheckIcon size={14} /> : <KeyIcon size={14} />}
                </button>
                {item.hasTotp && (
                  <button
                    type="button"
                    className="palette__btn"
                    aria-label="Скопировать код двухфакторки"
                    title="Скопировать код двухфакторки"
                    onClick={() => void copyTotp(item.id)}
                  >
                    {copied === "код" && index === selected && picking ? <CheckIcon size={14} /> : <ClockIcon size={14} />}
                  </button>
                )}
              </span>
            </li>
          ))}
        </ul>
        <p className={`palette__hint${copied ? " palette__hint--copied" : ""}`}>
          {copied ? `Скопирован ${copied}` : PALETTE_HINT}
        </p>
      </div>
    </div>
  );
}
