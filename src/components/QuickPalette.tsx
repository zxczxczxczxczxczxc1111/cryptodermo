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
import type { Item, VaultStore } from "../lib/vaultStore";
import { copyWithAutoClear } from "../lib/clipboard";
import { parseOtpauth, totpCode } from "../lib/totp";
import { primaryField, secondaryField, totpField, MAX_RESULTS } from "../screens/QuickAccess";
import { useModalFocus } from "../hooks/useModalFocus";
import { CopyIcon, CheckIcon } from "./icons";
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
  const [results, setResults] = useState<Item[]>([]);
  const [selected, setSelected] = useState(0);
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
    setCopied(null);
    setResults(store.search("").slice(0, MAX_RESULTS));
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
    setResults(store.search(next).slice(0, MAX_RESULTS));
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

  async function copyTotp(item: Item) {
    const field = totpField(item);
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
      // Ctrl+Enter открывает запись целиком: иногда нужен не пароль, а сама
      // карточка, и возвращаться за ней в список было бы лишним шагом.
      if (e.ctrlKey) {
        setOpen(false);
        onOpenItem(item.id);
        return;
      }
      const field = e.shiftKey ? secondaryField(item) : primaryField(item);
      if (field) void copyValue(field.value, e.shiftKey ? "логин" : "пароль");
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
              key={item.id}
              className={`palette__row${index === selected ? " palette__row--active" : ""}`}
              onMouseEnter={() => setSelected(index)}
            >
              <span className="palette__row-title">{item.title || "(без названия)"}</span>
              <span className="palette__row-actions">
                {totpField(item) && (
                  <button type="button" className="palette__btn" onClick={() => void copyTotp(item)}>
                    2FA
                  </button>
                )}
                {secondaryField(item) && (
                  <button
                    type="button"
                    className="palette__btn"
                    onClick={() => {
                      const f = secondaryField(item);
                      if (f) void copyValue(f.value, "логин");
                    }}
                  >
                    Логин
                  </button>
                )}
                {primaryField(item) && (
                  <button
                    type="button"
                    className="palette__btn palette__btn--icon"
                    aria-label="Скопировать пароль"
                    title="Скопировать пароль"
                    onClick={() => {
                      const f = primaryField(item);
                      if (f) void copyValue(f.value, "пароль");
                    }}
                  >
                    {copied === "пароль" && index === selected ? (
                      <CheckIcon size={14} />
                    ) : (
                      <CopyIcon size={14} />
                    )}
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
