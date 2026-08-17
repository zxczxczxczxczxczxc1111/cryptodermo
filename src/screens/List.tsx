import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Item, ItemType, VaultStore } from "../lib/vaultStore";
import { RecordCard, TYPE_LABELS, hasStaleSecretField } from "../components/RecordCard";
import { StatusDot } from "../components/StatusDot";
import { PlusIcon } from "../components/icons";
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
  /** Путь к файлу базы - нужен только для того, чтобы передать его в
   * `RecordCard` (кнопка "Удалить" у вложения, тикет 11, И кнопка "Удалить
   * запись", живой прогон 2026-08-17: без `store`+`vaultPath` вместе ни одна
   * из них не рендерится вовсе). Сам `List` файлов не читает и не пишет. */
  vaultPath: string;
  /** Открыть запись в редакторе - сам редактор строит тикет 08 и не
   * импортируется здесь. Вызывается из карточки записи (кнопка
   * "Редактировать"). */
  onOpenItem: (id: string) => void;
  /** Создать новую запись - кнопка "Добавить запись" (тулбар и приглашение
   * пустого списка, R87). Необязательный: без него обе кнопки не
   * рендерятся, компонент остаётся рабочим и без этого колбэка (тот же
   * принцип опциональности, что и у `RecordCardProps.onAttachmentsChanged`). */
  onCreateNew?: () => void;
  /**
   * Показывать только записи этого типа. `undefined` - показывать все.
   *
   * Фильтр применяется ПОВЕРХ поиска, а не вместо него: сузили тип, потом
   * ищете внутри него - обычное ожидание. Отдельный фильтр, а не подмешивание
   * типа в поисковую строку: строка ищет по тексту, и слово «карта» в
   * заметке не должно превращаться в выбор типа.
   */
  typeFilter?: ItemType;
  /** Показывать только записи, у которых есть вложения. */
  withAttachments?: boolean;
  /**
   * Стор был изменён прямо внутри этого экрана (сейчас - только удаление
   * вложения из карточки, см. `RecordCard.onAttachmentsChanged`) - сигнал
   * вызывающему коду (тикет 12), что данные "снаружи" `List` (например,
   * счётчик записей в сайдбаре или список "Недавние") тоже могли устареть
   * и стоит их пересчитать. Сам `List` уже обновляет СВОЁ отображение
   * независимо от этого колбэка (см. `localVersion` ниже) - колбэк только
   * для внешних потребителей.
   */
  onStoreChanged?: () => void;
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

/** R50/R85: фиксированный русский текст для отказа `store.search()` - сырое
 * `err.message` из `VaultStore` (например, `VaultNotLoadedError`) написано
 * по-английски и предназначено для лога/разработчика, не для интерфейса.
 * Техническая причина уходит в `console.error` (см. `safeSearch` ниже), в
 * тексте на экране остаётся только это. */
const SEARCH_FAILED_MESSAGE = "Не удалось получить список записей. Попробуйте перезапустить приложение.";

/** `store.search()` обёрнут в try/catch: `VaultStore` кидает
 * `VaultNotLoadedError`, если его вызвали до `loadFromBytes`/
 * `createNewVault` - контракт этого экрана предполагает уже загруженный
 * стор, но падать белым экраном вместо понятного текста ошибки хуже, чем
 * лишний try/catch (design states - error). */
function safeSearch(store: VaultStore, query: string): SearchResult {
  try {
    return { items: store.search(query), error: null };
  } catch (err) {
    console.error("List: store.search() failed", err);
    return { items: [], error: SEARCH_FAILED_MESSAGE };
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

/**
 * Подпись поиска и кнопки добавления.
 *
 * Колонка списка узкая (около 360px), и подпись «Добавить запись» съедала в
 * ней 144px из 358 - в остатке плейсхолдер обрезался на полуслове
 * (пользователь прислал скриншот 17.08.2026). Кнопка стала иконкой с тем же
 * текстом в подсказке и в имени для экранной читалки, а перечисление того,
 * где именно ищем, сокращено до того, что физически помещается.
 *
 * Сокращать пришлось дважды. Первый вариант «Поиск по названию и тегам» помещался,
 * но занижал правду: `VaultStore.search` смотрит ещё и в значения несекретных
 * полей (то есть находит по логину или почте) и в имена вложений. Подсказка,
 * которая обещает меньше, чем умеет поиск, стоит пользователю неудачных попыток.
 */
const SEARCH_PLACEHOLDER = "Поиск: название, логин, тег";
const ADD_LABEL = "Добавить запись";

export function List({ store, vaultPath, onOpenItem, onCreateNew, onStoreChanged, refreshToken, typeFilter, withAttachments }: ListProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Изменение стора ИЗНУТРИ этого экрана (сейчас - только удаление вложения
  // из RecordCard, см. handleAttachmentsChanged ниже). `refreshToken` из
  // пропсов сигнализирует об изменениях СНАРУЖИ (тикет 12) - это отдельный,
  // локальный счётчик для изменений, о которых внешний код знать не может.
  const [localVersion, setLocalVersion] = useState(0);

  const viewportRef = useRef<HTMLDivElement>(null);

  // Полный список (без фильтра) - источник для карточки выбранной записи,
  // отдельно от отфильтрованного списка строк ниже. Так выбранная запись
  // остаётся открытой в карточке, даже если пользователь потом сузил поиск
  // так, что сама запись больше не входит в видимые строки - строка search
  // сужает только ЛЕВУЮ колонку, а не то, какая карточка открыта.
  const full = useMemo<SearchResult>(() => safeSearch(store, ""), [store, refreshToken, localVersion]);

  const searched = useMemo<SearchResult>(() => {
    if (query.trim() === "") return full;
    return safeSearch(store, query);
  }, [store, query, refreshToken, full]);

  const filtered = useMemo<SearchResult>(() => {
    let items = searched.items;
    if (typeFilter) items = items.filter((i) => i.type === typeFilter);
    if (withAttachments) items = items.filter((i) => i.attachments.length > 0);
    return items === searched.items ? searched : { items, error: searched.error };
  }, [searched, typeFilter, withAttachments]);

  const items = filtered.items;

  const detailPlaceholderText =
    items.length > 0
      ? "Выберите запись слева, чтобы посмотреть детали."
      : query.trim() !== ""
        ? "По этому запросу ничего нет."
        : withAttachments
          ? "Записей с вложениями пока нет."
          : typeFilter
            ? "Записей этого типа пока нет."
          : "Здесь появится содержимое выбранной записи.";

  /*
   * Автовыбор первой записи.
   *
   * После удаления колонки «Недавние» правая половина экрана при пустом
   * выборе оставалась дырой на пол-окна с одной строчкой посередине. Открытая
   * первая запись убирает эту дыру и заодно отвечает на вопрос «а что вообще
   * внутри», не требуя ни одного щелчка.
   *
   * Условия важны: выбираем только если НИЧЕГО не выбрано (не перебиваем
   * выбор пользователя) и только если выбранное выпало из текущей выборки -
   * иначе смена фильтра оставляла бы открытой запись чужого типа.
   */
  useEffect(() => {
    if (items.length === 0) {
      if (selectedId !== null) setSelectedId(null);
      return;
    }
    const stillVisible = selectedId !== null && items.some((i) => i.id === selectedId);
    if (!stillVisible) setSelectedId(items[0].id);
  }, [items, selectedId]);
  const error = filtered.error ?? full.error;
  const selectedItem = selectedId ? (full.items.find((i) => i.id === selectedId) ?? null) : null;

  // Новый поисковый запрос - список строк логично начинать сверху, а не с
  // той позиции прокрутки, что осталась от предыдущих результатов.
  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [query, typeFilter, withAttachments]);

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

  /** Вложение удалено в карточке (RecordCard.onAttachmentsChanged, тикет 11)
   * - сама запись в `store` уже обновлена и сохранена на диск к этому
   * моменту, здесь только пересчёт отображения: `localVersion` заставляет
   * `full`/`filtered` перечитать `store.search()` заново (иначе карточка
   * продолжала бы показывать старый список вложений до следующего внешнего
   * `refreshToken`), а `onStoreChanged` сообщает наверх (тикет 12), что
   * данные вне этого экрана (например, счётчик в сайдбаре) тоже устарели. */
  function handleAttachmentsChanged() {
    setLocalVersion((v) => v + 1);
    onStoreChanged?.();
  }

  /** Запись удалена целиком (RecordCard.onDeleted, кнопка "Удалить запись" в
   * шапке карточки, живой прогон 2026-08-17) - та же логика пересчёта
   * отображения, что и у `handleAttachmentsChanged` выше (`localVersion` +
   * `onStoreChanged`), плюс явное закрытие карточки: удалённой записи
   * больше нет в `store`, показывать её (или молча ждать, пока `full.items`
   * сам не перестанет её находить) неверно - карточка должна сразу
   * показать плейсхолдер "Выберите запись слева". Проверка `current === id`
   * вместо безусловного `null` не меняет наблюдаемое поведение сегодня
   * (`RecordCard` рендерится только для `selectedItem`, так что `id` здесь
   * всегда совпадает с текущим выбором) - но не даёт этому обработчику по
   * ошибке сбросить чужой выбор, если он когда-нибудь станет вызываться не
   * только для текущей выбранной записи. */
  function handleItemDeleted(id: string) {
    setLocalVersion((v) => v + 1);
    onStoreChanged?.();
    setSelectedId((current) => (current === id ? null : current));
  }

  /** R89: Esc закрывает открытое - на этом экране "открытое" это карточка
   * выбранной записи в правой колонке. Ничего не делает, если ничего не
   * выбрано (нечего закрывать). */
  function handleListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Escape" && selectedId !== null) {
      setSelectedId(null);
    }
  }

  return (
    <div className="list" onKeyDown={handleListKeyDown}>
      <div className="list__rows-column">
        <div className="list__search">
          <input
            type="search"
            className="list__search-input"
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Поиск записей"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            autoFocus
          />
          {onCreateNew && (
            <button
              type="button"
              className="list__add-btn"
              onClick={onCreateNew}
              aria-label={ADD_LABEL}
              title={ADD_LABEL}
            >
              <PlusIcon />
            </button>
          )}
        </div>

        {error ? (
          <p className="list__error" role="alert">
            {error}
          </p>
        ) : (
          <>
            <p className="list__count">
              {items.length} {pluralizeRecords(items.length)}
              {query.trim() !== "" ? " найдено" : ""}
            </p>

            {items.length === 0 ? (
              <div className="list__empty">
                <p className="list__empty-text">
                  {query.trim() === "" ? "Записей пока нет. Добавьте первую." : "Совпадений не найдено."}
                </p>
                {query.trim() === "" && onCreateNew && (
                  <button type="button" className="list__empty-btn" onClick={onCreateNew}>
                    Добавить запись
                  </button>
                )}
              </div>
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
          <RecordCard
            item={selectedItem}
            onEdit={onOpenItem}
            store={store}
            vaultPath={vaultPath}
            onAttachmentsChanged={handleAttachmentsChanged}
            onDeleted={handleItemDeleted}
          />
        ) : (
          /*
            Текст зависит от того, ПОЧЕМУ справа пусто.
            Раньше здесь всегда стояло «Выберите запись слева» - и при пустом
            поиске это прямо врало: выбирать было нечего, а подсказка
            отправляла к списку, в котором ноль строк.
            Когда записи есть, но ни одна не выбрана, состояние практически
            недостижимо (первая выбирается сама), но текст оставлен: он
            корректен именно для этого случая.
          */
          <div className="list__detail-placeholder">{detailPlaceholderText}</div>
        )}
      </div>
    </div>
  );
}
