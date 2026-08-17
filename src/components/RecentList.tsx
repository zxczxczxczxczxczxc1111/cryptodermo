import { StatusDot } from "./StatusDot";
import "./RecentList.css";

/**
 * Правая колонка "Недавние" (R64, R65). Каркасный тикет 03 показывает
 * моковые записи по умолчанию - реальные данные подключаются позже просто
 * передачей другого массива в `items`, без изменения этого файла.
 */
export interface RecentListItem {
  id: string;
  title: string;
  /** Тип записи для служебной подписи, например "Пароль", "Карта". */
  typeLabel: string;
  /** Уже отформatированное относительное время, например "2 мин назад". */
  relativeTime: string;
  /** У записи есть несохранённые изменения - точка-статус (R67). */
  hasUnsavedChanges?: boolean;
}

export interface RecentListProps {
  items?: RecentListItem[];
  /**
   * Открыть эту запись в редакторе - вызывается по клику на строку (кнопка
   * `<button>` внутри `<li>`, тот же паттерн интерактивной строки, что и
   * `.list__row` в `List.tsx`: реальный `<button>`, Enter/Space работают
   * нативно, без ручного `onKeyDown`). Необязательный - без него строки
   * остаются некликабельными (обычная разметка без `<button>`), тот же
   * принцип опциональности, что и у `List.onCreateNew`: компонент остаётся
   * рабочим и без этого колбэка.
   */
  onSelect?: (id: string) => void;
}

// Моковые данные тикета 03 - нарочно больше, чем помещается на экране без
// прокрутки, чтобы градиентная маска снизу было видно, а не только в теории.
const MOCK_ITEMS: RecentListItem[] = [
  { id: "1", title: "Gmail — личная почта", typeLabel: "Пароль", relativeTime: "2 мин назад", hasUnsavedChanges: true },
  { id: "2", title: "Wi-Fi домашний роутер", typeLabel: "Пароль", relativeTime: "18 мин назад" },
  { id: "3", title: "Visa — основная карта", typeLabel: "Карта", relativeTime: "1 ч назад" },
  { id: "4", title: "Серийник Windows 11", typeLabel: "Заметка", relativeTime: "3 ч назад" },
  { id: "5", title: "GitHub — рабочий аккаунт", typeLabel: "Пароль", relativeTime: "5 ч назад" },
  { id: "6", title: "Договор аренды.pdf", typeLabel: "Файл", relativeTime: "вчера" },
  { id: "7", title: "Steam Guard — резервные коды", typeLabel: "Заметка", relativeTime: "вчера" },
  { id: "8", title: "Банковская ячейка — код", typeLabel: "Заметка", relativeTime: "2 дня назад" },
  { id: "9", title: "VPN конфигурация", typeLabel: "Файл", relativeTime: "2 дня назад" },
  { id: "10", title: "Netflix", typeLabel: "Пароль", relativeTime: "3 дня назад" },
  { id: "11", title: "MasterCard — запасная карта", typeLabel: "Карта", relativeTime: "4 дня назад" },
  { id: "12", title: "Домофон — код подъезда", typeLabel: "Заметка", relativeTime: "5 дней назад" },
  { id: "13", title: "Роутер администратора", typeLabel: "Пароль", relativeTime: "неделю назад" },
  { id: "14", title: "Синхронизация iCloud", typeLabel: "Пароль", relativeTime: "неделю назад" },
  { id: "15", title: "Гарантийный талон.jpg", typeLabel: "Файл", relativeTime: "2 недели назад" },
  { id: "16", title: "Кодовое слово банка", typeLabel: "Заметка", relativeTime: "3 недели назад" },
];

export function RecentList({ items = MOCK_ITEMS, onSelect }: RecentListProps) {
  return (
    <aside className="recent-list">
      <h2 className="recent-list__heading">Недавние</h2>
      <ul className="recent-list__items">
        {items.map((item) => {
          const rowContent = (
            <>
              {item.hasUnsavedChanges ? (
                <StatusDot kind="unsaved" className="recent-list__dot" />
              ) : (
                <span className="recent-list__dot recent-list__dot--empty" aria-hidden="true" />
              )}
              <span className="recent-list__text">
                <span className="recent-list__title">{item.title}</span>
                <span className="recent-list__meta">
                  {item.typeLabel} · {item.relativeTime}
                </span>
              </span>
            </>
          );
          return (
            <li key={item.id}>
              {onSelect ? (
                <button
                  type="button"
                  className="recent-list__row recent-list__row--btn"
                  onClick={() => onSelect(item.id)}
                >
                  {rowContent}
                </button>
              ) : (
                <div className="recent-list__row">{rowContent}</div>
              )}
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
