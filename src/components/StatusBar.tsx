import "./StatusBar.css";

/**
 * Нижняя полоса "Состояние хранилища" (R66) - четыре блока: количество
 * записей, время последнего бэкапа, обратный отсчёт до автоблокировки,
 * версия формата контейнера. Значения - пропсы, компонент их не считает
 * сам; тикеты 06/07/09 подключат реальные данные, просто передав другие
 * пропсы, без изменения этого файла.
 */
export interface StatusBarProps {
  /** Число записей в открытой базе. */
  itemsCount: number;
  /** Время последнего успешного бэкапа; null - бэкапов ещё не было. */
  lastBackupAt: Date | null;
  /** Остаток времени до автоблокировки, мс. */
  autoLockRemainingMs: number;
  /** Версия формата контейнера vault.dat (например "v1"). */
  formatVersion: string;
  /** Последняя запись на диск завершилась ошибкой - включает --danger. */
  lastWriteFailed?: boolean;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function formatRelative(date: Date | null, now: number): string {
  if (date === null) {
    return "ещё не было";
  }
  const diffMs = now - date.getTime();
  if (diffMs < 60_000) {
    return "только что";
  }
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) {
    return `${minutes} мин назад`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} ч назад`;
  }
  const days = Math.floor(hours / 24);
  return `${days} дн назад`;
}

function formatCountdown(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function StatusBar({
  itemsCount,
  lastBackupAt,
  autoLockRemainingMs,
  formatVersion,
  lastWriteFailed = false,
}: StatusBarProps) {
  const now = Date.now();
  const backupStale = lastBackupAt === null || now - lastBackupAt.getTime() > DAY_MS;

  // Приоритет по §"Приоритеты" спецификации: потеря/повреждение данных
  // важнее всего остального - ошибка записи перекрывает предупреждение о
  // бэкапе, если оба условия верны одновременно.
  const state: "normal" | "warn" | "danger" = lastWriteFailed
    ? "danger"
    : backupStale
      ? "warn"
      : "normal";

  return (
    <footer className={`status-bar status-bar--${state}`}>
      <div className="status-bar__block">
        <span className="status-bar__label">Записей</span>
        <span className="status-bar__value">{itemsCount}</span>
      </div>

      <div className="status-bar__block">
        <span className="status-bar__label">Бэкап</span>
        <span
          className={`status-bar__value${backupStale ? " status-bar__value--warn" : ""}`}
        >
          {formatRelative(lastBackupAt, now)}
        </span>
      </div>

      <div className="status-bar__block">
        <span className="status-bar__label">Автоблокировка</span>
        <span className="status-bar__value status-bar__value--mono">
          {formatCountdown(autoLockRemainingMs)}
        </span>
      </div>

      <div className="status-bar__block">
        <span className="status-bar__label">Версия формата</span>
        <span className="status-bar__value">{formatVersion}</span>
      </div>
    </footer>
  );
}
