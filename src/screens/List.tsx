import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Item, ItemField, ItemType, VaultStore } from "../lib/vaultStore";
import { copyWithAutoClear } from "../lib/clipboard";
import { RecordCard, TYPE_LABELS, hasStaleSecretField } from "../components/RecordCard";
import { StatusDot } from "../components/StatusDot";
import {
  createPasswordIssueChecker,
  passwordIssueLabel,
  NO_PASSWORD_ISSUES,
} from "../lib/passwordHealth";
import { PlusIcon, CopyIcon, CheckIcon, StarIcon } from "../components/icons";
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
  /** Проверка паролей включена галочкой в настройках - только тогда список
   * показывает значок у проблемных записей. Выключена: список чистый, как
   * и просил пользователь («без спама и навязчивых оповещений»). */
  passwordCheckEnabled?: boolean;
  /** Значения паролей, найденных в утечках - приходят из `App`, потому что
   * из базы это не выводится. */
  breachedValues?: ReadonlySet<string>;
  /** Показать только записи с этой проблемой пароля - переход из числа в
   * «Состоянии базы» настроек. `weak`/`reused` пересчитываются по текущей
   * базе (исправил пароль - запись уходит из фильтра сама), `breached`
   * опирается на набор значений последней проверки. */
  passwordIssue?: "weak" | "reused" | "breached";
  /** Снять фильтр по проблеме - крестик у пилюли. */
  onClearPasswordIssue?: () => void;
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

/* -------------------------------------------------------------------------
 * Клавиатура. Логика вынесена в чистые функции, как принято в проекте: сам
 * обработчик - тонкая обвязка, а решения проверяются тестами без DOM.
 * ---------------------------------------------------------------------- */

/** На сколько строк прыгают PageUp/PageDown. Не считается от высоты окна
 * намеренно: постоянный шаг предсказуем, а «страница» в списке, который
 * виртуализирован и меняет высоту вместе с окном, каждый раз разная. */
export const LIST_PAGE_JUMP = 10;

/** Сколько держится галочка после копирования из строки. */
export const COPIED_FEEDBACK_MS = 1600;

/** Пометка в названии копии - иначе в списке две неразличимые строки. */
export const DUPLICATE_SUFFIX = "(копия)";

/**
 * Куда перевести выделение по нажатию клавиши. `null` - клавиша не про
 * навигацию, обработчику делать нечего.
 *
 * Зацикливания нет намеренно: в списке на сотню записей перескок с последней
 * на первую читается как сбой, а не как удобство. С края движение просто
 * упирается.
 */
export function nextSelectionIndex(
  current: number,
  key: string,
  count: number,
  pageJump: number = LIST_PAGE_JUMP,
): number | null {
  if (count === 0) return null;
  const clamp = (n: number) => Math.max(0, Math.min(count - 1, n));
  switch (key) {
    // Из «ничего не выбрано» вниз ведёт к первой записи, вверх к последней.
    case "ArrowDown":
      return current < 0 ? 0 : clamp(current + 1);
    case "ArrowUp":
      return current < 0 ? count - 1 : clamp(current - 1);
    case "PageDown":
      return clamp((current < 0 ? 0 : current) + pageJump);
    case "PageUp":
      return clamp((current < 0 ? 0 : current) - pageJump);
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}

/**
 * Прокрутка, при которой строка `index` целиком попадает в окно просмотра.
 *
 * Нужна именно вручную: список виртуализирован, строки вне окна физически
 * отсутствуют в разметке, и `scrollIntoView` вызывать не на чем. Возвращает
 * прежнее значение, если строка и так видна - иначе список дёргался бы на
 * каждое нажатие стрелки.
 */
export function scrollTopToReveal(
  index: number,
  rowHeight: number,
  viewportHeight: number,
  scrollTop: number,
): number {
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  // Окно ниже одной строки (сильно сжатое окно приложения): показываем начало
  // строки, а не конец. Иначе подтягивание к низу выталкивало бы за экран
  // название записи, то есть ровно то, ради чего к ней и переходят.
  if (rowHeight >= viewportHeight) return top;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + viewportHeight) return Math.max(0, bottom - viewportHeight);
  return scrollTop;
}

/**
 * Какое поле копировать быстрым действием (кнопка на строке и Ctrl+C).
 *
 * Первое секретное - в записи типа «пароль» это и есть пароль, а копируют из
 * списка почти всегда именно его. Если секретных полей нет вовсе (заметка),
 * берётся первое поле: копировать нечего лучше, чем не копировать ничего.
 */
export function quickCopyField(item: Item): ItemField | null {
  return item.fields.find((f) => f.secret) ?? item.fields[0] ?? null;
}

/**
 * Перехватывать ли Ctrl+C как «скопировать пароль выбранной записи».
 *
 * Нет, если человек в этот момент выделил текст: он копирует именно его, и
 * подмена буфера паролем была бы кражей действия. Проверка идёт по живому
 * выделению, а не по типу элемента: выделить можно и в поле поиска, и в
 * карточке записи справа.
 */
export function shouldHijackCopy(selectionText: string | null | undefined): boolean {
  return !selectionText || selectionText.length === 0;
}

/**
 * Клик по тегу в строке списка (19.08.2026) - тег становится фильтром списка,
 * повторный клик по уже активному тегу снимает его. Тот же принцип, что у
 * фильтра-переключателя в остальном приложении: одно и то же действие и
 * включает, и выключает, отдельной кнопки «сбросить» для этого не нужно (она
 * всё равно есть отдельно, у самого индикатора активного фильтра).
 */
export function toggleTagFilter(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

export function List({
  store,
  vaultPath,
  onOpenItem,
  onCreateNew,
  onStoreChanged,
  refreshToken,
  typeFilter,
  withAttachments,
  passwordCheckEnabled,
  breachedValues,
  passwordIssue,
  onClearPasswordIssue,
}: ListProps) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(0);
  // Изменение стора ИЗНУТРИ этого экрана (сейчас - только удаление вложения
  // из RecordCard, см. handleAttachmentsChanged ниже). `refreshToken` из
  // пропсов сигнализирует об изменениях СНАРУЖИ (тикет 12) - это отдельный,
  // локальный счётчик для изменений, о которых внешний код знать не может.
  const [localVersion, setLocalVersion] = useState(0);
  // Фильтр по тегу (19.08.2026) - выставляется кликом по тегу в строке
  // списка (`toggleTagFilter`), полностью локален этому экрану: теги не
  // часть навигации сайдбара (тикет 12, `Screen`), в отличие от
  // `typeFilter`/`withAttachments`, которые приходят пропсами.
  const [tagFilter, setTagFilter] = useState<string | null>(null);

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

  /**
   * Проверка проблем пароля, подготовленная ОДИН раз на всю базу: карта
   * повторов строится по всем записям, а список виртуализирован и спрашивает
   * про каждую видимую строку - пересобирать её на строку значило бы квадрат
   * на базе в тысячи записей.
   *
   * Считается по `full` (вся база), а не по отфильтрованному списку: повтор
   * это свойство базы целиком, и в отфильтрованном виде он бы «исчезал».
   */
  const checkIssues = useMemo(
    () => createPasswordIssueChecker(full.items, breachedValues),
    [full, breachedValues],
  );

  const filtered = useMemo<SearchResult>(() => {
    let items = searched.items;
    if (typeFilter) items = items.filter((i) => i.type === typeFilter);
    if (withAttachments) items = items.filter((i) => i.attachments.length > 0);
    if (tagFilter) items = items.filter((i) => i.tags.includes(tagFilter));
    if (passwordIssue) items = items.filter((i) => checkIssues(i)[passwordIssue]);
    return items === searched.items ? searched : { items, error: searched.error };
  }, [searched, typeFilter, withAttachments, tagFilter, passwordIssue, checkIssues]);

  const items = filtered.items;

  const detailPlaceholderText =
    items.length > 0
      ? "Выберите запись слева, чтобы посмотреть детали."
      : query.trim() !== ""
        ? "По этому запросу ничего нет."
        : tagFilter
          ? "Записей с этим тегом пока нет."
          : withAttachments
            ? "Записей с вложениями пока нет."
            : typeFilter
              ? "Записей этого типа пока нет."
            : "Здесь появится содержимое выбранной записи.";

  // Смена раздела сайдбара (тип/вложения) - тег из другого раздела мог бы
  // молча дать пустой список без объяснимой причины, поэтому фильтр по тегу
  // сбрасывается вместе со сменой раздела, а не переживает её.
  useEffect(() => {
    setTagFilter(null);
  }, [typeFilter, withAttachments]);

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
  /** Строка, по которой только что скопировали - для короткой галочки. */
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectedItem = selectedId ? (full.items.find((i) => i.id === selectedId) ?? null) : null;

  // Новый поисковый запрос - список строк логично начинать сверху, а не с
  // той позиции прокрутки, что осталась от предыдущих результатов.
  useEffect(() => {
    setScrollTop(0);
    if (viewportRef.current) viewportRef.current.scrollTop = 0;
  }, [query, typeFilter, withAttachments, tagFilter]);

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

  /** Копирование пароля без открытия записи - кнопкой на строке и по Ctrl+C.
   * Отдельно от копирования в карточке: там своя индикация на каждом поле, а
   * здесь подтверждать нужно на строке, по которой человек и попал. */
  async function handleQuickCopy(item: Item) {
    const field = quickCopyField(item);
    if (!field) return;
    try {
      await copyWithAutoClear(field.value);
      setCopiedId(item.id);
      window.setTimeout(() => {
        setCopiedId((current) => (current === item.id ? null : current));
      }, COPIED_FEEDBACK_MS);
    } catch (err) {
      console.error("List: не удалось скопировать значение в буфер обмена", err);
    }
  }

  /**
   * Закрепить или открепить запись.
   *
   * Пишется на диск сразу: закрепление это состояние, которое человек ожидает
   * увидеть и после перезапуска, а откладывать запись до какого-то будущего
   * «сохранить» в этом приложении негде - явной кнопки сохранения у списка
   * нет.
   */
  async function handleTogglePinned(id: string, pinned: boolean) {
    try {
      store.setPinned(id, pinned);
      await store.save(vaultPath);
      setLocalVersion((v) => v + 1);
      onStoreChanged?.();
    } catch (err) {
      console.error("List: не удалось изменить закрепление записи", err);
    }
  }

  /**
   * Копия записи, сразу открытая в редакторе.
   *
   * Название получает пометку, иначе в списке окажутся две неразличимые
   * строки. История НЕ копируется: это журнал изменений исходной записи, к
   * новой он отношения не имеет. Закрепление тоже не наследуется - копия
   * заводится, чтобы её править, а не чтобы она сразу заняла место наверху.
   */
  async function handleDuplicate(id: string) {
    const source = full.items.find((i) => i.id === id);
    if (!source) return;
    try {
      const copy = store.addItem({
        type: source.type,
        title: `${source.title} ${DUPLICATE_SUFFIX}`,
        tags: [...source.tags],
        fields: source.fields.map((f) => ({ ...f })),
        note: source.note,
        attachments: source.attachments.map((a) => ({ ...a, id: crypto.randomUUID() })),
      });
      await store.save(vaultPath);
      setLocalVersion((v) => v + 1);
      onStoreChanged?.();
      onOpenItem(copy.id);
    } catch (err) {
      console.error("List: не удалось создать копию записи", err);
    }
  }

  /**
   * Клавиатура списка. Всё, что делается мышью в левой колонке, должно
   * делаться и с клавиатуры: до этого работал единственный Escape, и любое
   * действие требовало руки на мыши.
   *
   * Обработчик висит на всём экране, а не на поле поиска: фокус по ходу
   * работы уходит и на строки, и в карточку справа, а стрелки должны водить
   * по списку отовсюду.
   */
  function handleListKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const target = e.target as HTMLElement | null;
    const inTextField =
      target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

    if (e.key === "Escape") {
      // Сначала снимается поиск, потом выбор: иначе Escape закрывал бы
      // карточку, оставляя список отфильтрованным, и человек не понимал бы,
      // куда делись остальные записи.
      if (query !== "") {
        setQuery("");
        searchRef.current?.focus();
      } else if (selectedId !== null) {
        setSelectedId(null);
      }
      return;
    }

    if (e.ctrlKey && (e.key === "f" || e.key === "F")) {
      e.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
      return;
    }

    // «/» как быстрый путь в поиск - привычка из почты и трекеров. Только
    // когда не печатают: иначе слэш нельзя было бы ввести в текст.
    if (e.key === "/" && !inTextField) {
      e.preventDefault();
      searchRef.current?.focus();
      return;
    }

    if (e.ctrlKey && (e.key === "n" || e.key === "N") && onCreateNew) {
      e.preventDefault();
      onCreateNew();
      return;
    }

    if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
      if (!shouldHijackCopy(window.getSelection()?.toString())) return;
      if (!selectedItem) return;
      e.preventDefault();
      void handleQuickCopy(selectedItem);
      return;
    }

    if (e.key === "Enter" && selectedItem && !inTextField) {
      e.preventDefault();
      onOpenItem(selectedItem.id);
      return;
    }

    const currentIndex = selectedId === null ? -1 : items.findIndex((i) => i.id === selectedId);
    const next = nextSelectionIndex(currentIndex, e.key, items.length);
    if (next === null) return;
    e.preventDefault();
    const item = items[next];
    setSelectedId(item.id);
    const viewport = viewportRef.current;
    if (viewport) {
      const desired = scrollTopToReveal(next, ROW_HEIGHT, viewport.clientHeight, viewport.scrollTop);
      if (desired !== viewport.scrollTop) viewport.scrollTop = desired;
    }
  }

  return (
    <div className="list" onKeyDown={handleListKeyDown}>
      <div className="list__rows-column">
        <div className="list__search">
          <input
            ref={searchRef}
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

        {/* Пилюля фильтра по проблеме пароля - тот же вид, что у фильтра по
            тегу: без неё короткий список выглядел бы так, будто записи
            пропали, и выйти из него было бы нечем. */}
        {passwordIssue && (
          <div className="list__tag-filter">
            <span className="list__tag-filter-text">
              {passwordIssue === "weak"
                ? "Записи со слабым паролем"
                : passwordIssue === "reused"
                  ? "Записи с повторяющимся паролем"
                  : "Записи с паролем из утечки"}
            </span>
            {onClearPasswordIssue && (
              <button
                type="button"
                className="list__tag-filter-clear"
                onClick={onClearPasswordIssue}
                aria-label="Показать все записи"
                title="Показать все записи"
              >
                ✕
              </button>
            )}
          </div>
        )}

        {tagFilter && (
          <div className="list__tag-filter">
            <span className="list__tag-filter-text">Тег: {tagFilter}</span>
            <button
              type="button"
              className="list__tag-filter-clear"
              onClick={() => setTagFilter(null)}
              aria-label="Убрать фильтр по тегу"
              title="Убрать фильтр по тегу"
            >
              ✕
            </button>
          </div>
        )}

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
                    // Одна точка на все поводы, а не две подряд: «слабый» и
                    // «не менялся год» об одном и том же, а причины
                    // перечислены в подсказке. Пока проверка выключена
                    // галочкой, остаётся прежнее поведение - только «старый».
                    const issues = passwordCheckEnabled ? checkIssues(item) : NO_PASSWORD_ISSUES;
                    const issueLabel = passwordCheckEnabled
                      ? passwordIssueLabel(issues, stale)
                      : stale
                        ? passwordIssueLabel(NO_PASSWORD_ISSUES, true)
                        : null;
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
                          {issueLabel && (
                            <StatusDot kind="passwordIssue" className="list__row-dot" label={issueLabel} />
                          )}
                          {/* Звезда только у закреплённых: пустой контур в
                              каждой строке превратил бы список в частокол. */}
                          {item.pinned && (
                            <span className="list__row-pin" aria-label="Закреплена" title="Закреплена">
                              <StarIcon filled size={12} />
                            </span>
                          )}
                          <span className="list__row-title">{item.title || "(без названия)"}</span>
                        </span>
                        <span className="list__row-meta">
                          {TYPE_LABELS[item.type]} · {formatRelativeTime(item.updatedAt, now)}
                          {/* Каждый тег - отдельная цель клика (фильтр списка
                              по этому тегу), а не просто текст. `<span
                              role="button">`, не настоящая кнопка - строка
                              сама уже `<button>`, а вложенная кнопка в кнопку
                              запрещена разметкой (тот же приём, что у
                              `list__row-copy` ниже). `stopPropagation`
                              обязателен - иначе клик заодно выбирал бы
                              строку. */}
                          {item.tags.length > 0 && (
                            <>
                              {" · "}
                              {item.tags.map((tag, tagIndex) => (
                                <span key={tag}>
                                  <span
                                    role="button"
                                    tabIndex={-1}
                                    className={`list__row-tag${tagFilter === tag ? " list__row-tag--active" : ""}`}
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setTagFilter((current) => toggleTagFilter(current, tag));
                                    }}
                                  >
                                    {tag}
                                  </span>
                                  {tagIndex < item.tags.length - 1 ? ", " : ""}
                                </span>
                              ))}
                            </>
                          )}
                        </span>
                        {/*
                          Копирование прямо со строки. Раньше путь был в четыре
                          шага: найти, кликнуть, дождаться карточки, кликнуть
                          копирование. Здесь их два. Кнопка проявляется по
                          наведению и на выбранной строке (см. CSS), чтобы
                          список в покое оставался списком, а не панелью
                          кнопок. `stopPropagation` обязателен: без него клик
                          заодно выбирал бы строку и дёргал карточку.
                        */}
                        {quickCopyField(item) && (
                          <span
                            role="button"
                            tabIndex={-1}
                            className="list__row-copy"
                            aria-label={copiedId === item.id ? "Скопировано" : "Копировать пароль"}
                            title={copiedId === item.id ? "Скопировано" : "Копировать пароль"}
                            onClick={(e) => {
                              e.stopPropagation();
                              void handleQuickCopy(item);
                            }}
                          >
                            {copiedId === item.id ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
                          </span>
                        )}
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
            passwordIssues={passwordCheckEnabled ? checkIssues(selectedItem) : null}
            onEdit={onOpenItem}
            onTogglePinned={(id, pinned) => void handleTogglePinned(id, pinned)}
            onDuplicate={(id) => void handleDuplicate(id)}
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
