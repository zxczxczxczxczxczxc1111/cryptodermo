import type { ReactNode } from "react";
import "../tokens.css";
import "./AppShell.css";

/**
 * Каркас разблокированного приложения: сайдбар слева, центр, и всё.
 *
 * История раскладки за 17.08.2026, чтобы не ходить по кругу:
 *   - была нижняя полоса состояния - удалена, содержимое уехало в Настройки;
 *   - «Импорт и экспорт» перестал быть разделом и уехал туда же;
 *   - после этого в сайдбаре остался один пункт, и он ужался до полосы иконок
 *     в 56px;
 *   - затем в него добавились типы записей как фильтры, пунктов стало семь, и
 *     полоса безымянных значков перестала читаться - подписи вернулись;
 *   - правая колонка «Недавние» удалена: она дублировала список записей почти
 *     один в один, два одинаковых столбца рядом мешали понять, куда смотреть.
 *
 * Итог: одна колонка навигации с подписями и счётчиками, всё остальное место -
 * содержимому.
 */

export interface SidebarItem {
  id: string;
  label: string;
  count?: number;
  /** Пункт прижимается к низу (служебное действие, а не раздел данных). */
  pinnedToBottom?: boolean;
  /** Имя иконки. Без него рисуется иконка раздела по умолчанию. */
  icon?: string;
}

export interface SidebarSection {
  heading?: string;
  items: SidebarItem[];
}

export interface AppShellProps {
  /** Центральная зона. */
  children?: ReactNode;
  /** Разделы сайдбара. */
  sidebarSections?: SidebarSection[];
  /** id выбранного пункта сайдбара - контролируемый снаружи. */
  activeSidebarItemId?: string;
  onSidebarItemSelect?: (id: string) => void;
}

/**
 * Иконки пунктов. Нарисованы прямо здесь, а не подключены библиотекой: их
 * семь, и тянуть ради семи картинок зависимость означало бы отдельный вопрос
 * пользователю (R31) ради того, что рисуется десятком строк.
 *
 * Все в одной сетке 24x24 с одинаковой толщиной штриха: разнобой в этом
 * заметнее, чем кажется, и сразу читается как «иконки из разных наборов».
 */
const ICON_PATHS: Record<string, ReactNode> = {
  all: (
    <>
      <path d="M4 6a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M14 4v5h5" />
    </>
  ),
  login: (
    <>
      <path d="M15 7a4 4 0 1 0-3.9 5H13l2 2 2-2 2 2 2-2-2-2h-4.1" />
      <circle cx="7" cy="12" r="1" />
    </>
  ),
  note: (
    <>
      <path d="M5 4h11l3 3v13a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
      <path d="M8 10h8M8 14h6" />
    </>
  ),
  card: (
    <>
      <rect x="3" y="6" width="18" height="12" rx="2" />
      <path d="M3 10h18M7 15h3" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="12" r="3" />
      <path d="M11 12h9l-2 2 2 2" />
    </>
  ),
  other: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 8v4l3 2" />
    </>
  ),
  attachment: (
    <>
      <path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8.5-8.5a3.5 3.5 0 0 1 5 5L10.5 18a2 2 0 0 1-3-3l8-8" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
};

function SidebarIcon({ name }: { name?: string }) {
  return (
    <svg
      className="app-shell__nav-icon"
      width={18}
      height={18}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {ICON_PATHS[name ?? "all"] ?? ICON_PATHS.all}
    </svg>
  );
}

export function AppShell({
  children,
  sidebarSections = [],
  activeSidebarItemId,
  onSidebarItemSelect,
}: AppShellProps) {
  const bottomItems = sidebarSections.flatMap((s) => s.items.filter((i) => i.pinnedToBottom));
  const topSections = sidebarSections
    .map((s) => ({ ...s, items: s.items.filter((i) => !i.pinnedToBottom) }))
    .filter((s) => s.items.length > 0);

  const renderItem = (item: SidebarItem) => {
    const isActive = item.id === activeSidebarItemId;
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`app-shell__nav-item${isActive ? " app-shell__nav-item--active" : ""}`}
          aria-current={isActive ? "true" : undefined}
          onClick={() => onSidebarItemSelect?.(item.id)}
        >
          <SidebarIcon name={item.icon} />
          <span className="app-shell__nav-label">{item.label}</span>
          {item.count !== undefined && (
            /* Счётчик приглушён и не жирный: это справка, а не значение, за
               которым следят. Табличные цифры - чтобы числа разной ширины не
               дёргали правый край при фильтрации. */
            <span className="app-shell__nav-count">{item.count}</span>
          )}
        </button>
      </li>
    );
  };

  return (
    <div className="app-shell">
      <nav className="app-shell__sidebar" aria-label="Разделы">
        <div className="app-shell__nav-top">
          {topSections.map((section, index) => (
            <div className="app-shell__nav-section" key={section.heading ?? index}>
              {section.heading && (
                <span className="app-shell__nav-heading">{section.heading}</span>
              )}
              <ul className="app-shell__nav-list">{section.items.map(renderItem)}</ul>
            </div>
          ))}
        </div>
        {bottomItems.length > 0 && (
          <ul className="app-shell__nav-list">{bottomItems.map(renderItem)}</ul>
        )}
      </nav>

      <main className="app-shell__center">
        {children ?? (
          <div className="app-shell__center-placeholder">
            Здесь появится содержимое выбранного раздела.
          </div>
        )}
      </main>
    </div>
  );
}
