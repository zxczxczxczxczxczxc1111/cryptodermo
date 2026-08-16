import { useEffect, useState } from "react";
import type { Item, ItemField, ItemType } from "../lib/vaultStore";
import { copyWithAutoClear } from "../lib/clipboard";
import { StatusDot } from "./StatusDot";
import "./RecordCard.css";

/**
 * Карточка записи (R97, spec.md §9) - только просмотр: секретные поля
 * скрыты по умолчанию (точки), кнопки "Показать"/"Копировать" на каждом,
 * вкладка "История" видна только при непустой `history` (R45). Изменение
 * значений - не здесь, а в редакторе (тикет 08); карточка только
 * запрашивает переход туда через `onEdit`.
 */

/** Понятные пользователю подписи типа записи (R43) - ни карточка, ни
 * список (тикет List.tsx импортирует эту же карту, чтобы не расходиться в
 * формулировках) не показывают техническое имя `type` напрямую. */
export const TYPE_LABELS: Record<ItemType, string> = {
  login: "Пароль",
  note: "Заметка",
  card: "Карта",
  key: "Ключ",
  other: "Прочее",
};

const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

/**
 * ISO8601-дата, с которой отсчитывается возраст значения поля `fieldName`
 * (spec.md §8): "Возраст считается по дате последнего изменения этого
 * поля: если поле хотя бы раз попадало в history, берётся дата последней
 * записи history, иначе - updatedAt всей записи". Сравнение строк ISO8601
 * одного формата эквивалентно сравнению по времени - тот же приём, что и в
 * сортировке `VaultStore.search()`.
 */
function fieldValueSince(item: Item, fieldName: string): string {
  const changeDates = (item.history ?? [])
    .filter((entry) => entry.fields.some((f) => f.name === fieldName))
    .map((entry) => entry.changedAt);
  if (changeDates.length === 0) return item.updatedAt;
  return changeDates.reduce((latest, d) => (d > latest ? d : latest));
}

/** Секретное поле не менялось больше года (R67, spec.md §8) - основание
 * для точки-статуса `oldPassword` на самом поле в карточке. `now` -
 * параметр для тестируемости (момент "сейчас" не берётся неявно из
 * `Date.now()` внутри чистой функции). */
export function isSecretFieldStale(item: Item, fieldName: string, now: Date = new Date()): boolean {
  const since = new Date(fieldValueSince(item, fieldName)).getTime();
  return now.getTime() - since > YEAR_MS;
}

/** Есть ли у записи хотя бы одно устаревшее (>1 года) секретное поле -
 * используется `List.tsx` для точки-статуса на строке списка (spec.md §8:
 * "точка на самой записи в списке и на поле в карточке" - это агрегат для
 * первого места, `isSecretFieldStale` выше - для второго). */
export function hasStaleSecretField(item: Item, now: Date = new Date()): boolean {
  return item.fields.some((field) => field.secret && isSecretFieldStale(item, field.name, now));
}

export interface RecordCardProps {
  item: Item;
  /** Открыть эту запись в редакторе - сам редактор строит тикет 08, здесь
   * только запрос перехода по `id`. */
  onEdit: (id: string) => void;
}

type Tab = "fields" | "history";

const SECRET_MASK = "••••••••";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function RecordCard({ item, onEdit }: RecordCardProps) {
  const [tab, setTab] = useState<Tab>("fields");
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [revealedHistory, setRevealedHistory] = useState<Set<string>>(() => new Set());
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);

  const hasHistory = (item.history?.length ?? 0) > 0;

  // Переключение на другую запись сбрасывает раскрытые поля и вкладку -
  // "Показать" одной записи не должно утекать в следующую только потому,
  // что карточка не была размонтирована (список переиспользует один и тот
  // же <RecordCard>, меняя только item).
  useEffect(() => {
    setTab("fields");
    setRevealed(new Set());
    setRevealedHistory(new Set());
    setCopiedField(null);
    setCopyError(null);
  }, [item.id]);

  function toggleReveal(name: string) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleHistoryReveal(key: string) {
    setRevealedHistory((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function handleCopy(field: ItemField) {
    // Буфер обмена - граница ОС, запись может отклоняться (нет разрешения,
    // недоступен в текущем контексте и т.п.) - падать тихо в необработанный
    // reject недопустимо (CLAUDE.md §5 "Handle failures where they can
    // occur"), пользователь должен увидеть, что копирование не удалось,
    // а не решить, что просто забыл нажать кнопку.
    try {
      setCopyError(null);
      // 30 секунд - буквально из брифа (R48), не настраивается с этого места.
      await copyWithAutoClear(field.value);
      setCopiedField(field.name);
      window.setTimeout(() => {
        setCopiedField((current) => (current === field.name ? null : current));
      }, 2000);
    } catch (err) {
      console.error("RecordCard: не удалось скопировать значение в буфер обмена", err);
      setCopyError("Не удалось скопировать значение в буфер обмена.");
    }
  }

  return (
    <section className="record-card" aria-label={`Запись: ${item.title}`}>
      <header className="record-card__header">
        <div className="record-card__heading">
          <span className="record-card__type">{TYPE_LABELS[item.type]}</span>
          <h2 className="record-card__title">{item.title}</h2>
        </div>
        <button type="button" className="record-card__edit-btn" onClick={() => onEdit(item.id)}>
          Редактировать
        </button>
      </header>

      {item.tags.length > 0 && (
        <ul className="record-card__tags">
          {item.tags.map((tag) => (
            <li className="record-card__tag" key={tag}>
              {tag}
            </li>
          ))}
        </ul>
      )}

      <div className="record-card__tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "fields"}
          className={`record-card__tab${tab === "fields" ? " record-card__tab--active" : ""}`}
          onClick={() => setTab("fields")}
        >
          Поля
        </button>
        {hasHistory && (
          <button
            type="button"
            role="tab"
            aria-selected={tab === "history"}
            className={`record-card__tab${tab === "history" ? " record-card__tab--active" : ""}`}
            onClick={() => setTab("history")}
          >
            История
          </button>
        )}
      </div>

      {tab === "fields" && (
        <div className="record-card__panel" role="tabpanel">
          {item.fields.some((f) => f.secret) && (
            <p className="record-card__clipboard-note">
              Скопированное значение исчезает из буфера обмена через 30 секунд. История буфера
              обмена Windows (Win+V) может сохранить его отдельно от приложения.
            </p>
          )}

          {copyError && (
            <p className="record-card__copy-error" role="alert">
              {copyError}
            </p>
          )}

          {item.fields.length === 0 && <p className="record-card__empty">У записи пока нет полей.</p>}

          {item.fields.map((field) => {
            const isRevealed = !field.secret || revealed.has(field.name);
            const stale = field.secret && isSecretFieldStale(item, field.name);
            return (
              <div className="record-card__field" key={field.name}>
                <div className="record-card__field-label">
                  {stale && <StatusDot kind="oldPassword" className="record-card__field-dot" />}
                  <span>{field.name}</span>
                </div>
                <div className="record-card__field-row">
                  <span
                    className={`record-card__field-value${
                      field.secret ? " record-card__field-value--mono" : ""
                    }`}
                  >
                    {isRevealed ? field.value : SECRET_MASK}
                  </span>
                  {field.secret && (
                    <button
                      type="button"
                      className="record-card__field-btn"
                      onClick={() => toggleReveal(field.name)}
                    >
                      {isRevealed ? "Скрыть" : "Показать"}
                    </button>
                  )}
                  <button type="button" className="record-card__field-btn" onClick={() => handleCopy(field)}>
                    {copiedField === field.name ? "Скопировано" : "Копировать"}
                  </button>
                </div>
              </div>
            );
          })}

          {item.note && (
            <div className="record-card__note">
              <span className="record-card__field-label-text">Заметка</span>
              <p>{item.note}</p>
            </div>
          )}
        </div>
      )}

      {tab === "history" && hasHistory && (
        <ul className="record-card__history" role="tabpanel">
          {[...(item.history ?? [])]
            .sort((a, b) => b.changedAt.localeCompare(a.changedAt))
            .map((entry, entryIdx) => (
              <li className="record-card__history-entry" key={`${entry.changedAt}-${entryIdx}`}>
                <span className="record-card__history-date">{formatDate(entry.changedAt)}</span>
                {entry.fields.map((f) => {
                  const key = `${entry.changedAt}-${entryIdx}-${f.name}`;
                  const shown = revealedHistory.has(key);
                  return (
                    <div className="record-card__history-field" key={key}>
                      <span className="record-card__history-field-name">{f.name}</span>
                      <span className="record-card__field-value record-card__field-value--mono">
                        {shown ? f.value : SECRET_MASK}
                      </span>
                      <button
                        type="button"
                        className="record-card__field-btn"
                        onClick={() => toggleHistoryReveal(key)}
                      >
                        {shown ? "Скрыть" : "Показать"}
                      </button>
                    </div>
                  );
                })}
              </li>
            ))}
        </ul>
      )}
    </section>
  );
}
