import type { ReactNode } from "react";
import { RecentList, type RecentListProps } from "./RecentList";
import { StatusBar, type StatusBarProps } from "./StatusBar";
import "../tokens.css";
import "./AppShell.css";

export interface SidebarItem {
  id: string;
  label: string;
  count?: number;
}

export interface SidebarSection {
  heading: string;
  items: SidebarItem[];
}

export interface AppShellProps {
  /** Центральная зона (поиск + список записей) - подключит тикет 07. */
  children?: ReactNode;
  /** Разделы сайдбара (типы, теги). По умолчанию - моковый набор тикета 03. */
  sidebarSections?: SidebarSection[];
  /** Пропсы для правой колонки "Недавние". По умолчанию - моковые записи. */
  recentListProps?: RecentListProps;
  /** Пропсы для нижней полосы "Состояние хранилища". По умолчанию - моковые значения. */
  statusBarProps?: StatusBarProps;
  /** id выбранного пункта сайдбара - контролируемый снаружи (фильтрация появится позже). */
  activeSidebarItemId?: string;
  onSidebarItemSelect?: (id: string) => void;
}

// Моковые разделы тикета 03 - реальные типы/теги подключит тикет 07, просто
// передав другой sidebarSections снаружи, без изменения этого файла.
const MOCK_SIDEBAR_SECTIONS: SidebarSection[] = [
  {
    heading: "Типы",
    items: [
      { id: "type-password", label: "Пароли", count: 24 },
      { id: "type-card", label: "Карты", count: 5 },
      { id: "type-note", label: "Заметки", count: 11 },
      { id: "type-file", label: "Файлы", count: 3 },
      { id: "type-other", label: "Прочее", count: 2 },
    ],
  },
  {
    heading: "Теги",
    items: [
      { id: "tag-work", label: "Работа", count: 14 },
      { id: "tag-personal", label: "Личное", count: 19 },
      { id: "tag-finance", label: "Финансы", count: 8 },
    ],
  },
];

const MOCK_STATUS_BAR: StatusBarProps = {
  itemsCount: 45,
  lastBackupAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
  autoLockRemainingMs: 4 * 60 * 1000 + 12 * 1000,
  formatVersion: "v1",
};

export function AppShell({
  children,
  sidebarSections = MOCK_SIDEBAR_SECTIONS,
  recentListProps,
  statusBarProps = MOCK_STATUS_BAR,
  activeSidebarItemId,
  onSidebarItemSelect,
}: AppShellProps) {
  return (
    <div className="app-shell">
      <nav className="app-shell__sidebar" aria-label="Типы и теги">
        {sidebarSections.map((section) => (
          <div className="app-shell__nav-section" key={section.heading}>
            <span className="app-shell__nav-heading">{section.heading}</span>
            <ul className="app-shell__nav-list">
              {section.items.map((item) => {
                const isActive = item.id === activeSidebarItemId;
                return (
                  <li key={item.id}>
                    <button
                      type="button"
                      className={`app-shell__nav-item${isActive ? " app-shell__nav-item--active" : ""}`}
                      title={item.label}
                      aria-current={isActive ? "true" : undefined}
                      onClick={() => onSidebarItemSelect?.(item.id)}
                    >
                      <span className="app-shell__nav-badge" aria-hidden="true">
                        {item.label.charAt(0).toUpperCase()}
                      </span>
                      <span className="app-shell__nav-label">{item.label}</span>
                      {item.count !== undefined && (
                        <span className="app-shell__nav-count">{item.count}</span>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <main className="app-shell__center">
        {children ?? (
          <div className="app-shell__center-placeholder">
            Здесь будет поиск и список записей (тикет 07)
          </div>
        )}
      </main>

      <RecentList {...recentListProps} />

      <StatusBar {...statusBarProps} />
    </div>
  );
}
