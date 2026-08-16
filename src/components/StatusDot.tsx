import "./StatusDot.css";

/**
 * Три случая, где в интерфейсе реально есть статус, требующий точки (R67).
 * Это единственное место в интерфейсе, где цвет статуса появляется вне
 * нижней полосы "Состояние хранилища" - поэтому набор случаев закрытый,
 * никаких новых kind без пересмотра спецификации.
 */
export type StatusDotKind = "unsaved" | "staleBackup" | "oldPassword";

export interface StatusDotProps {
  kind: StatusDotKind;
  /** Необязательный класс для позиционирования в месте использования. */
  className?: string;
}

/**
 * Подпись каждого случая - используется и как видимый текст для
 * скринридера (aria-label), и как title-подсказка при наведении.
 *
 * Цвет каждого случая - соответствующий семантический токен:
 *  - unsaved: --accent (обычное, не тревожное состояние - "есть что
 *    сохранить", а не ошибка);
 *  - staleBackup: --warn (прямо назван в спецификации §8, синхронно с
 *    нижней полосой);
 *  - oldPassword: --danger (единственный оставшийся из трёх токенов
 *    состояния - для реального риска "пароль не менялся год", решение
 *    тикета 03, в спецификации цвет этого случая не назван явно).
 */
const LABEL: Record<StatusDotKind, string> = {
  unsaved: "Есть несохранённые изменения",
  staleBackup: "Последний бэкап устарел",
  oldPassword: "Пароль не менялся больше года",
};

export function StatusDot({ kind, className }: StatusDotProps) {
  const classes = ["status-dot", `status-dot--${kind}`, className]
    .filter(Boolean)
    .join(" ");

  return (
    <span
      className={classes}
      role="img"
      aria-label={LABEL[kind]}
      title={LABEL[kind]}
    />
  );
}
