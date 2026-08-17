/**
 * Иконки, которые используются больше чем в одном месте.
 *
 * Здесь лежат только те, что реально делят между собой два и более компонента:
 * глаз (поля пароля на входе и в настройках, значения полей и история в
 * карточке записи) и копирование с галочкой (карточка записи). Иконки
 * бокового меню остаются внутри `AppShell.tsx` - они там одни и наружу не
 * ходят, выносить их сюда значило бы плодить общий склад ради симметрии.
 *
 * Все рисуются одинаково: viewBox 24, обводка `currentColor`, толщина 1.6 -
 * те же параметры, что у `SidebarIcon`, иначе иконки соседних размеров
 * выглядят разной жирности.
 */
import type { ReactNode } from "react";

function Glyph({ size = 16, children }: { size?: number; children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

/** Глаз (`off` - перечёркнутый, состояние «значение сейчас видно»). */
export function EyeIcon({ off = false, size }: { off?: boolean; size?: number }) {
  return (
    <Glyph size={size}>
      {off ? (
        <>
          <path d="M3 3l18 18" />
          <path d="M10.6 10.6a3 3 0 0 0 4.2 4.2" />
          <path d="M9.9 5.2A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17.5 17.5 0 0 1-3.4 4.2" />
          <path d="M6.5 6.6A17.5 17.5 0 0 0 2 12s3.6 7 10 7a10 10 0 0 0 3.4-.6" />
        </>
      ) : (
        <>
          <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7-10-7-10-7z" />
          <circle cx="12" cy="12" r="3" />
        </>
      )}
    </Glyph>
  );
}

/** Две карточки друг за другом - общепринятый знак копирования. */
export function CopyIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </Glyph>
  );
}

/** Галочка - подтверждение, что значение легло в буфер. */
export function CheckIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M4 12.5l5 5L20 6.5" />
    </Glyph>
  );
}

/** Плюс - добавление записи. */
export function PlusIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <path d="M12 5v14M5 12h14" />
    </Glyph>
  );
}

/**
 * QR-код: три поисковых узора по углам и пара модулей внутри. Не настоящий
 * код, а знак - настоящий рисуется по матрице из `lib/qr.ts`.
 */
export function QrIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="3" y="3" width="7" height="7" rx="1" />
      <rect x="14" y="3" width="7" height="7" rx="1" />
      <rect x="3" y="14" width="7" height="7" rx="1" />
      <path d="M14 14h3v3h-3zM19 19h2M14 21h1M21 14v1" />
    </Glyph>
  );
}

/** Звезда. `filled` - запись закреплена. */
export function StarIcon({ filled = false, size }: { filled?: boolean; size?: number }) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3.5l2.6 5.3 5.9.9-4.2 4.1 1 5.8-5.3-2.8-5.3 2.8 1-5.8-4.2-4.1 5.9-.9z" />
    </svg>
  );
}

/** Две наложенные страницы - дублирование записи. */
export function DuplicateIcon({ size }: { size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="8" y="3" width="13" height="13" rx="2" />
      <path d="M16 19v1a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1h1" />
    </Glyph>
  );
}

/** Канцелярская кнопка - окно поверх остальных. */
export function PinIcon({ filled = false, size }: { filled?: boolean; size?: number }) {
  return (
    <svg
      width={size ?? 16}
      height={size ?? 16}
      viewBox="0 0 24 24"
      fill={filled ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M9 3h6l-1 5 3 3v2H7v-2l3-3z" />
      <path d="M12 13v8" fill="none" />
    </svg>
  );
}
