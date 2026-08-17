import { useEffect, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import type { Attachment, Item, ItemField, ItemType, VaultStore } from "../lib/vaultStore";
import { writeVaultAtomic } from "../lib/tauriApi";
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

/** base64 (стандартный алфавит) -> байты. Та же логика, что в
 * `vaultStore.ts`/`vaultFormat.ts`/`Settings.tsx`/`Editor.tsx` - приватные
 * хелперы других модулей не экспортированы (решение тикета 02), у каждого
 * файла своя маленькая копия. */
function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/** Человекочитаемый размер файла - тот же формат, что в `Editor.tsx`
 * (`formatFileSize`), своя маленькая копия по тому же принципу, что и
 * `base64ToBytes` выше. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const units = ["КБ", "МБ", "ГБ"];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(1)} ${units[unitIndex]}`;
}

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
  /**
   * Хранилище и путь к базе - нужны только для кнопки "Удалить" у вложения
   * (R44.2, §18: "вижу вложения в карточке с именем, размером и кнопками
   * «Скачать»/«Удалить»"). Карточка остаётся в основном view-only (R97):
   * "Скачать" не нуждается ни в чём из этого (просто декодирует
   * `attachment.data` и пишет файл через системный диалог, см.
   * `handleDownloadAttachment`), но "Удалить" - реальная правка записи,
   * которую нужно закоммитить в `store` и сохранить на диск, а не только
   * спрятать в локальном состоянии карточки (иначе повторное открытие
   * записи вернуло бы "удалённое" вложение обратно).
   *
   * Оба пропа опциональны и предполагаются парой: если хотя бы один не
   * передан, кнопка "Удалить" у вложений не рендерится вовсе - карточка
   * ведёт себя как раньше (полностью view-only для вложений), поэтому
   * существующий вызывающий код (`List.tsx`, тикет 07, вне зоны этого
   * тикета) остаётся рабочим без изменений, пока тикет 12 ("сведение
   * экранов") не передаст их по-настоящему.
   */
  store?: VaultStore;
  vaultPath?: string;
  /** Вложение удалено и сохранено на диск - `updated` (копия записи из
   * `store.updateItem`) передаётся вызывающему коду, чтобы он обновил
   * `item`, который передаёт этой карточке (сама карточка не хранит
   * отдельную копию `item.attachments` - см. `store`/`vaultPath` выше). */
  onAttachmentsChanged?: (updated: Item) => void;
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

export function RecordCard({ item, onEdit, store, vaultPath, onAttachmentsChanged }: RecordCardProps) {
  const [tab, setTab] = useState<Tab>("fields");
  const [revealed, setRevealed] = useState<Set<string>>(() => new Set());
  const [revealedHistory, setRevealedHistory] = useState<Set<string>>(() => new Set());
  const [copiedField, setCopiedField] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);

  const hasHistory = (item.history?.length ?? 0) > 0;
  const canDeleteAttachments = Boolean(store && vaultPath);

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
    setAttachmentError(null);
  }, [item.id]);

  /** Кнопка "Скачать" у вложения (R44.2) - диалог `save()` с именем файла
   * по умолчанию, декодирование base64 обратно в байты, запись через
   * `writeVaultAtomic`. Самодостаточно - не трогает `store`. */
  async function handleDownloadAttachment(attachment: Attachment) {
    setAttachmentError(null);
    let targetPath: string | null;
    try {
      targetPath = await save({ title: "Скачать вложение", defaultPath: attachment.name });
    } catch (err) {
      console.error("RecordCard: не удалось открыть системный диалог сохранения", err);
      setAttachmentError("Не удалось открыть системный диалог. Попробуйте ещё раз.");
      return;
    }
    if (targetPath === null) return; // пользователь отменил диалог - не ошибка

    try {
      await writeVaultAtomic(targetPath, base64ToBytes(attachment.data));
    } catch (err) {
      console.error("RecordCard: не удалось сохранить вложение на диск", err);
      setAttachmentError("Не удалось сохранить файл. Проверьте, что выбранное место доступно для записи.");
    }
  }

  /** Кнопка "Удалить" у вложения (R44.2) - реальная правка записи
   * (`store.updateItem` + `store.save`), не локальное скрытие: без этого
   * повторное открытие записи вернуло бы "удалённое" вложение обратно.
   * Рендерится только когда `store`/`vaultPath` оба переданы (см.
   * `canDeleteAttachments` выше и комментарий у `RecordCardProps`). R45 на
   * вложения не распространяется - без подтверждения и без `history`, как
   * удаление тега. */
  async function handleDeleteAttachment(attachmentId: string) {
    if (!store || !vaultPath) return; // defensive - кнопка не должна была отрендериться без обоих пропов
    setAttachmentError(null);
    try {
      const next = item.attachments.filter((a) => a.id !== attachmentId);
      const updated = store.updateItem(item.id, { attachments: next });
      await store.save(vaultPath);
      onAttachmentsChanged?.(updated);
    } catch (err) {
      console.error("RecordCard: не удалось удалить вложение", err);
      setAttachmentError("Не удалось удалить вложение. Попробуйте снова.");
    }
  }

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

          {item.attachments.length > 0 && (
            <div className="record-card__attachments">
              <span className="record-card__field-label-text">Вложения</span>

              {attachmentError && (
                <p className="record-card__copy-error" role="alert">
                  {attachmentError}
                </p>
              )}

              <ul className="record-card__attachments-list">
                {item.attachments.map((att) => (
                  <li className="record-card__attachment-row" key={att.id}>
                    <span className="record-card__attachment-name">{att.name}</span>
                    <span className="record-card__attachment-size">{formatFileSize(att.size)}</span>
                    <button
                      type="button"
                      className="record-card__field-btn"
                      onClick={() => {
                        void handleDownloadAttachment(att);
                      }}
                    >
                      Скачать
                    </button>
                    {canDeleteAttachments && (
                      <button
                        type="button"
                        className="record-card__field-btn"
                        onClick={() => {
                          void handleDeleteAttachment(att.id);
                        }}
                      >
                        Удалить
                      </button>
                    )}
                  </li>
                ))}
              </ul>
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
