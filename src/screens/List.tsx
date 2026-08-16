import { useEffect, useMemo, useRef, useState } from "react";
import type { Item, VaultStore } from "../lib/vaultStore";
import { RecordCard, TYPE_LABELS, hasStaleSecretField } from "../components/RecordCard";
import { StatusDot } from "../components/StatusDot";
import "./List.css";

/**
 * Экран списка + поиска + карточки записи (R02, R04, R43, R45, R48, R53,
 * R96, R96.1, R97 - тикет 07). Самостоятельный компонент со своим
 * контрактом через пропсы: `src/App.tsx` его пока не монтирует (D02,
 * manifest.md) - это сделает тикет 12, когда все экраны будут собраны.
 *
 * Композиция сделана внутри этого файла (список слева, `RecordCard` для
 * выбранной записи справа) - craft-решение тикета, спецификация не
 * фиксирует layout буквально построчно (§8 описывает только "центр (поиск
 * + список)" на уровне каркаса, не то, где именно открывается карточка), а
 * зона тикета включает оба файла - решение о их совместной раскладке
 * принято здесь и задокументировано в отчёте по тикету.
 */

/** Высота строки списка в пикселях (см. List.css) - подобрана так, чтобы
 * 12-15 строк помещались без прокрутки на 1920x1080 (критерий приёмки
 * тикета), проверено визуально в предпросмотре. Виртуализация ниже не
 * зависит от общего числа записей - рендерится только видимое окно + запас
 * (`OVERSCAN`), поэтому 5000+ записей не создают тысяч DOM-узлов сразу. */
const ROW_HEIGHT = 64;
const OVERSCAN = 8;

export interface ListProps {
  /** Экземпляр `VaultStore` уже загруженной базы - создаётся и передаётся
   * вызывающим кодом (тикет 12), этот компонент его не создаёт. */
  store: VaultStore;
  /** Открыть запись в редакторе - сам редактор строит тикет 08 и не
   * импортируется здесь. Вызывается из карточки записи (кнопка
   * "Редактировать"). */
  onOpenItem: (id: string) => void;
  /**
   * Необязательный "маячок" внешнего изменения стора. `VaultStore` мутирует
   * коллекцию на месте (`addItem`/`updateItem`/`deleteItem`/повторный
   * `loadFromBytes`), поэтому сама ссылка на `store` не меняется, когда
   * записи изменились снаружи (например, после сохранения в редакторе
   * тикета 08). Родитель (тикет 12) должен передавать сюда новое значение
   * (например, увеличивающийся счётчик) при каждом внешнем изменении -
   * единственный сигнал этому компоненту перечитать `store.search()` без
   * полного размонтирования (что стёрло бы текущий текст поиска и выбор).
   */
  refreshToken?: number | string;
}

type SearchResult = { items: Item[]; error: string | null };

/** `store.search()` обёрнут в try/catch: `VaultStore` кидает
 * `VaultNotLoadedError`, если его вызвали до `loadFromBytes`/
 * `createNewVault` - контракт этого экрана предполагает уже загруженный
 * стор, но падать белым экраном вместо понятного текста ошибки хуже, чем
 * лишний try/catch (design states - error). */
function safeSearch(store: VaultStore, query: string): SearchResult {
  try {
    return { items: store.search(query), error: null };
  } catch (err) {
    return { items: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Русское склонение "запись/записи/записей" по числу (1, 2-4, 5+ с
 * исключением на 11-14) - используется в счётчике результатов поиска. */
function pluralizeRecords(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return "запись";
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return "записи";
  return "записей";
}

export interface VisibleRange {
  startIndex: number;
  endIndex: number;
}

/**
 * Диапазон индексов, которые нужно реально отрендерить как DOM-строки, при
 * заданной позиции прокрутки - сердце виртуализации (R96.1): вне
 * зависимости от `totalCount` (5000+ записей), рендерится только
 * видимая часть окна + запас `overscan` с каждой стороны, а не весь список
 * сразу. Чистая функция без побочных эффектов - тестируется отдельно от
 * компонента (см. `List.test.ts`).
 */
export function computeVisibleRange(params: {
  scrollTop: number;
  viewportHeight: number;
  rowHeight: number;
  overscan: number;
  totalCount: number;
}): VisibleRange {
  const { scrollTop, viewportHeight, rowHeight, overscan, totalCount } = params;
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2;
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const endIndex = Math.min(totalCount, startIndex + visibleCount);
  return { startIndex, endIndex };
}

function formatRelativeTime(iso: string, now: number): string {
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 60_000) return "только что";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес назад`;
  const years = Math.floor(months / 12);
  return `${years} г назад`;
}

export function List({ store, onOpenItem, refreshToken }: ListProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);

  // Полный список (без фильтра) - источник для карточки выбранной записи,
  // отдельно от отфильтрованного списка строк ниже. Так выбранная запись
  // остаётся открытой в карточке, даже если пользователь потом сузил поиск
  // так, что сама запись больше не входит в видимые строки - строка search
  // сужает только ЛЕВУЮ колонку, а не то, какая карточка открыта.
  const full = useMemo<SearchResult>(() => safeSearch(store, ""), [store, refreshToken]);

  const filtered = useMemo<SearchResult>(() => {
    if (query.trim() === "") return full;
    return safeSearch(store, query);
  }, [store, query, refreshToken, full]);

  const items = filtered.items;
  const error = filtered.error ?? full.error;
  const selectedItem = selectedId ? (full.items.find((i) => i.id === selectedId) ?? null) : null;

  // Новый поисковый запрос - список строк логично начинать сверху, а не с
  // той позиции прокрутки, что осталась от предыдущих результатов.
  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [query]);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    setViewportHeight(el.clientHeight);
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) setViewportHeight(entry.contentRect.height);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const totalHeight = items.length * ROW_HEIGHT;
  const { startIndex, endIndex } = computeVisibleRange({
    scrollTop,
    viewportHeight,
    rowHeight: ROW_HEIGHT,
    overscan: OVERSCAN,
    totalCount: items.length,
  });
  const visibleItems = items.slice(startIndex, endIndex);

  const now = Date.now();

  return (
    <div className="list">
      <div className="list__rows-column">
        <div className="list__search">
          <input
            type="search"
            className="list__search-input"
            placeholder="Поиск по названию, тегам, полям…"
            aria-label="Поиск записей"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            autoFocus
          />
        </div>

        {error ? (
          <p className="list__error" role="alert">
            Не удалось получить список записей: {error}
          </p>
        ) : (
          <>
            <p className="list__count">
              {items.length} {pluralizeRecords(items.length)}
              {query.trim() !== "" ? " найдено" : ""}
            </p>

            {items.length === 0 ? (
              <p className="list__empty">
                {query.trim() === "" ? "Записей пока нет." : "Совпадений не найдено."}
              </p>
            ) : (
              <div className="list__viewport" ref={viewportRef} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
                <div className="list__spacer" style={{ height: totalHeight }}>
                  {visibleItems.map((item, i) => {
                    const index = startIndex + i;
                    const isActive = item.id === selectedId;
                    const stale = hasStaleSecretField(item, new Date(now));
                    return (
                      <button
                        type="button"
                        key={item.id}
                        className={`list__row${isActive ? " list__row--active" : ""}`}
                        style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT }}
                        onClick={() => setSelectedId(item.id)}
                        aria-current={isActive ? "true" : undefined}
                      >
                        <span className="list__row-title-line">
                          {stale && <StatusDot kind="oldPassword" className="list__row-dot" />}
                          <span className="list__row-title">{item.title || "(без названия)"}</span>
                        </span>
                        <span className="list__row-meta">
                          {TYPE_LABELS[item.type]} · {formatRelativeTime(item.updatedAt, now)}
                          {item.tags.length > 0 ? ` · ${item.tags.join(", ")}` : ""}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="list__detail">
        {selectedItem ? (
          <RecordCard item={selectedItem} onEdit={onOpenItem} />
        ) : (
          <div className="list__detail-placeholder">Выберите запись слева, чтобы посмотреть детали.</div>
        )}
      </div>
    </div>
  );
}
