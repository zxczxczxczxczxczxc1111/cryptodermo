import type { ReactNode } from "react";
import { RecentList, type RecentListProps } from "./RecentList";
import "../tokens.css";
import "./AppShell.css";

/**
 * Каркас разблокированного приложения.
 *
 * Раскладка (17.08.2026): узкая полоса иконок слева, центр, «Недавние» справа.
 * Нижней полосы состояния больше нет - её содержимое переехало в Настройки, а
 * `StatusBar` удалён из проекта целиком.
 *
 * Сайдбар стал полосой иконок, а не колонкой в 220 пикселей, по простой
 * причине: после переезда «Импорта и экспорта» в Настройки в нём остался ровно
 * один пункт. Держать под один пункт пятую часть ширины экрана незачем,
 * освободившееся место уходит списку и карточке.
 */

export interface SidebarItem {
  id: string;
  label: string;
  count?: number;
  /** Пункт прижимается к низу полосы (служебное действие, а не раздел данных). */
  pinnedToBottom?: boolean;
}

export interface SidebarSection {
  heading: string;
  items: SidebarItem[];
}

export interface AppShellProps {
  /** Центральная зона (поиск + список записей). */
  children?: ReactNode;
  /** Разделы сайдбара. */
  sidebarSections?: SidebarSection[];
  /** Пропсы для правой колонки "Недавние". */
  recentListProps?: RecentListProps;
  /**
   * Показывать ли правую колонку «Недавние». Настройки открываются как
   * отдельная вкладка на всю ширину: список недавних записей рядом с полями
   * смены мастер-пароля не помогает, а отвлекает и режет место.
   */
  showRecent?: boolean;
  /** id выбранного пункта сайдбара - контролируемый снаружи. */
  activeSidebarItemId?: string;
  onSidebarItemSelect?: (id: string) => void;
}

/**
 * Иконка пункта. Сайдбар стал полосой иконок, и подписи в нём больше нет -
 * значит нужен рисунок, а не первая буква названия, как было в свёрнутом
 * состоянии прежнего сайдбара: буква «З» ничего не сообщает.
 *
 * Иконки нарисованы прямо здесь, а не подключены библиотекой: их две, и
 * тянуть ради двух картинок зависимость означало бы отдельный вопрос
 * пользователю (R31) ради того, что рисуется десятью строчками.
 */
function SidebarIcon({ name }: { name: string }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (name === "settings") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <path d="M4 6a2 2 0 0 1 2-2h9l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" />
      <path d="M14 4v5h5" />
    </svg>
  );
}

export function AppShell({
  children,
  sidebarSections = [],
  recentListProps,
  showRecent = true,
  activeSidebarItemId,
  onSidebarItemSelect,
}: AppShellProps) {
  const items = sidebarSections.flatMap((section) => section.items);
  const top = items.filter((item) => !item.pinnedToBottom);
  const bottom = items.filter((item) => item.pinnedToBottom);

  const renderItem = (item: SidebarItem) => {
    const isActive = item.id === activeSidebarItemId;
    return (
      <li key={item.id}>
        <button
          type="button"
          className={`app-shell__nav-item${isActive ? " app-shell__nav-item--active" : ""}`}
          /* Подписи на экране нет, поэтому имя обязано быть и во всплывающей
             подсказке (для мыши), и в aria-label (для клавиатуры и читалок).
             Голая иконка без имени недоступна ни тем, ни другим. */
          title={item.label}
          aria-label={item.label}
          aria-current={isActive ? "true" : undefined}
          onClick={() => onSidebarItemSelect?.(item.id)}
        >
          <SidebarIcon name={item.id === "settings" ? "settings" : "records"} />
        </button>
      </li>
    );
  };

  return (
    <div className={`app-shell${showRecent ? "" : " app-shell--no-recent"}`}>
      <nav className="app-shell__sidebar" aria-label="Разделы">
        <ul className="app-shell__nav-list">{top.map(renderItem)}</ul>
        {bottom.length > 0 && (
          <ul className="app-shell__nav-list app-shell__nav-list--bottom">{bottom.map(renderItem)}</ul>
        )}
      </nav>

      <main className="app-shell__center">
        {children ?? (
          <div className="app-shell__center-placeholder">
            Здесь появится содержимое выбранного раздела.
          </div>
        )}
      </main>

      {showRecent && <RecentList {...recentListProps} />}
    </div>
  );
}
