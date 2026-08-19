import { useEffect, useState, type KeyboardEvent, useRef } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { save } from "@tauri-apps/plugin-dialog";
import type { Attachment, Item, ItemField, ItemType, VaultStore } from "../lib/vaultStore";
import { passwordIssueLabel, NO_PASSWORD_ISSUES, type ItemPasswordIssues } from "../lib/passwordHealth";
import { writeVaultAtomic } from "../lib/tauriApi";
import { base64ToBytes } from "../lib/base64";
import { copyWithAutoClear } from "../lib/clipboard";
import { StatusDot } from "./StatusDot";
import { EyeIcon, CopyIcon, CheckIcon, QrIcon, StarIcon, DuplicateIcon, ExternalIcon } from "./icons";
import { isOpenableUrl, openExternal } from "../lib/openExternal";
import { buildQrMatrix, qrSvgPath, QrTooLongError, type QrMatrix } from "../lib/qr";
import { looksLikeTotp } from "../lib/totp";
import { TotpCode } from "./TotpCode";
import {
  previewKindFor,
  imageDataUrl,
  decodeTextPreview,
  truncateForPreview,
  previewUnavailableReason,
} from "../lib/attachmentPreview";
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

/** Человекочитаемый размер файла - тот же формат, что в `Editor.tsx`
 * (`formatFileSize`), своя маленькая копия по общему принципу проекта
 * (см. CLAUDE.md). */
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
  /** Проблемы паролей этой записи - считает вызывающий код (списку они и так
   * нужны для своих строк, пересчитывать второй раз незачем). `null` -
   * проверка выключена галочкой в настройках, значок не показывать. */
  passwordIssues?: ItemPasswordIssues | null;
  /** Открыть эту запись в редакторе - сам редактор строит тикет 08, здесь
   * только запрос перехода по `id`. */
  onEdit: (id: string) => void;
  /**
   * Хранилище и путь к базе - нужны для кнопки "Удалить" у вложения (R44.2,
   * §18: "вижу вложения в карточке с именем, размером и кнопками
   * «Скачать»/«Удалить»") И (живой прогон 2026-08-17) для кнопки "Удалить
   * запись" в шапке, которая удаляет всю запись целиком. Карточка остаётся
   * в основном view-only (R97): "Скачать" не нуждается ни в чём из этого
   * (просто декодирует `attachment.data` и пишет файл через системный
   * диалог, см. `handleDownloadAttachment`), но оба варианта "Удалить" -
   * реальная правка базы, которую нужно закоммитить в `store` и сохранить
   * на диск, а не только спрятать в локальном состоянии карточки (иначе
   * повторное открытие/запись вернула бы "удалённое" обратно).
   *
   * Оба пропа опциональны и предполагаются парой: если хотя бы один не
   * передан, ни кнопка "Удалить" у вложений, ни кнопка "Удалить запись" не
   * рендерятся вовсе - карточка ведёт себя как раньше (полностью view-only),
   * поэтому существующий вызывающий код, который не передаёт их (если
   * такой появится), остаётся рабочим без изменений.
   */
  store?: VaultStore;
  vaultPath?: string;
  /** Вложение удалено и сохранено на диск - `updated` (копия записи из
   * `store.updateItem`) передаётся вызывающему коду, чтобы он обновил
   * `item`, который передаёт этой карточке (сама карточка не хранит
   * отдельную копию `item.attachments` - см. `store`/`vaultPath` выше). */
  onAttachmentsChanged?: (updated: Item) => void;
  /** Запись удалена целиком и сохранена на диск (кнопка "Удалить запись" в
   * шапке, живой прогон 2026-08-17) - вызывающий код (`List.tsx`) решает,
   * что показать вместо закрытой карточки (сама карточка после этого больше
   * не должна рендериться с этим `item`, он не существует). Та же
   * опциональность и та же пара `store`/`vaultPath`, что и у
   * `onAttachmentsChanged` выше. */
  onDeleted?: (id: string) => void;
  /** Закрепить или открепить запись. Не передан - звезда не рисуется. */
  onTogglePinned?: (id: string, pinned: boolean) => void;
  /** Создать копию записи и открыть её в редакторе. */
  onDuplicate?: (id: string) => void;
}

type Tab = "fields" | "history";

const SECRET_MASK = "••••••••";

/*
 * Подписи кнопок значения переехали в `aria-label`/`title`.
 *
 * Раньше это были широкие капслочные кнопки «ПОКАЗАТЬ» и «КОПИРОВАТЬ», и в
 * строке из трёх полей они забирали больше места, чем сами значения
 * (пользователь назвал их «огромными» 17.08.2026). Иконки читаются с одного
 * взгляда и стоят одинаково во всех строках, а текст никуда не делся: он в
 * подсказке при наведении и в имени кнопки для экранной читалки.
 *
 * Подтверждение копирования при этом двойное - галочка вместо иконки и живая
 * область `aria-live` ниже по разметке: смену иконки читалки не замечают.
 */
/**
 * Разложить поля по аккаунтам, сохраняя порядок.
 *
 * Общие поля первыми, аккаунты в порядке появления. Та же логика, что в
 * редакторе (`groupFieldRows`), но на модели записи, а не на строках формы:
 * тащить сюда тип формы означало бы связать карточку с редактором ради шести
 * строк.
 */
export interface CardFieldEntry {
  field: ItemField;
  /**
   * Позиция поля в записи.
   *
   * Ею опознаются поля везде, где раньше использовалось имя: показ секрета,
   * подтверждение копирования, живые коды двухфакторки. Имя перестало быть
   * уникальным, как только у записи появились аккаунты - в каждом из них поле
   * зовётся «Пароль». Из-за этого один глаз открывал сразу оба пароля, а
   * копирование брало чужой (найдено пользователем 17.08.2026).
   */
  index: number;
}

export function cardFieldGroups(
  fields: ItemField[],
): Array<{ name: string | null; entries: CardFieldEntry[] }> {
  const groups: Array<{ name: string | null; entries: CardFieldEntry[] }> = [
    { name: null, entries: [] },
  ];
  fields.forEach((field, index) => {
    const name = field.group && field.group.trim() !== "" ? field.group : null;
    let group = groups.find((g) => g.name === name);
    if (!group) {
      group = { name, entries: [] };
      groups.push(group);
    }
    group.entries.push({ field, index });
  });
  return groups.filter((g) => g.entries.length > 0);
}

const COPY_LABEL = "Копировать";
const COPIED_LABEL = "Скопировано";
const REVEAL_SHOW_LABEL = "Показать";
const REVEAL_HIDE_LABEL = "Скрыть";
const QR_LABEL = "Показать QR-код";
const OPEN_LABEL = "Открыть в браузере";
const PIN_LABEL = "Закрепить наверху";
const UNPIN_LABEL = "Открепить";
const DUPLICATE_LABEL = "Дублировать запись";

/**
 * Через сколько окно с QR-кодом закрывается само.
 *
 * Тот же принцип, что и у автоочистки буфера обмена: значение не должно
 * оставаться на экране дольше, чем нужно для одного действия. Минута - это с
 * запасом на «достать телефон, разблокировать, открыть камеру», но заметно
 * меньше, чем «отошёл и забыл».
 */
export const QR_AUTO_CLOSE_MS = 60_000;

/** Значение не помещается в QR-код. Показывается вместо кода, в самом окне -
 * там же, где человек его ждал. */
export const QR_TOO_LONG_MESSAGE =
  "Значение слишком длинное для QR-кода. Скопируйте его обычной кнопкой.";

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Текст подтверждения кнопки "Удалить запись" в шапке карточки - вынесена
 * ради теста (см. RecordCard.test.ts), тот же приём, что и у
 * `formatCountDecreaseMessage` в Editor.tsx для текста своей модалки.
 * Запасное название для пустого `title` - тот же литерал, что уже
 * используется в List.tsx (`item.title || "(без названия)"`), чтобы текст
 * диалога не показывал пустые кавычки у записи без названия. */
export function formatDeleteConfirmMessage(title: string): string {
  const displayTitle = title || "(без названия)";
  return `Удалить запись «${displayTitle}»? Действие нельзя отменить.`;
}

export function RecordCard({ item, onEdit, store, vaultPath, onAttachmentsChanged, onDeleted,
  onTogglePinned,
  onDuplicate,
  passwordIssues,
}: RecordCardProps) {
  const [tab, setTab] = useState<Tab>("fields");
  /** Позиции полей, значения которых сейчас показаны. Позиции, а не имена:
   * у записи с аккаунтами поля называются одинаково. */
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set());
  const [revealedHistory, setRevealedHistory] = useState<Set<string>>(() => new Set());
  /** Позиция поля, которое только что скопировали. Позиция, а не имя: имена
   * в записи с аккаунтами повторяются. */
  const [copiedField, setCopiedField] = useState<number | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  /**
   * Какие вложения раскрыты. Свёрнуто по умолчанию и намеренно: содержимое
   * вложения - такой же секрет, как значение поля, и разворачивать его на
   * весь экран без спроса нельзя. Тот же принцип, что у кнопки «Показать» у
   * секретных полей.
   */
  const [expandedAttachments, setExpandedAttachments] = useState<Set<string>>(new Set());

  function toggleAttachmentPreview(id: string) {
    setExpandedAttachments((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [deleteConfirmVisible, setDeleteConfirmVisible] = useState(false);
  const deleteConfirmRef = useRef<HTMLDivElement>(null);
  useModalFocus(deleteConfirmRef, deleteConfirmVisible);

  /**
   * Поле, значение которого сейчас показано QR-кодом, и сама матрица.
   *
   * Матрица считается один раз при открытии, а не на каждый кадр отрисовки:
   * это перебор Reed-Solomon по всем маскам, и держать его в теле рендера
   * значило бы пересчитывать код на любое изменение состояния карточки.
   */
  const [qrView, setQrView] = useState<{ fieldName: string; matrix: QrMatrix | null } | null>(null);
  /**
   * Текущие коды двухфакторки по имени поля.
   *
   * Нужны для копирования: копировать надо ШЕСТЬ ЦИФР, а не ссылку
   * `otpauth://` из значения поля. Вставить ссылку в форму входа на сайте
   * означает получить отказ и не понять почему.
   */
  const [totpCodes, setTotpCodes] = useState<Record<number, string | null>>({});
  const qrRef = useRef<HTMLDivElement>(null);
  useModalFocus(qrRef, qrView !== null);

  // Окно с кодом закрывается само - см. QR_AUTO_CLOSE_MS. Таймер живёт ровно
  // столько, сколько открыто окно: без очистки повторное открытие копило бы
  // таймеры, и второй код закрылся бы раньше времени.
  useEffect(() => {
    if (!qrView) return;
    const timer = window.setTimeout(() => setQrView(null), QR_AUTO_CLOSE_MS);
    return () => window.clearTimeout(timer);
  }, [qrView]);

  function showQr(field: ItemField) {
    try {
      setQrView({ fieldName: field.name, matrix: buildQrMatrix(field.value) });
    } catch (err) {
      if (err instanceof QrTooLongError) {
        setQrView({ fieldName: field.name, matrix: null });
        return;
      }
      throw err;
    }
  }
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const hasHistory = (item.history?.length ?? 0) > 0;
  // Означает "есть право мутировать store" - изначально только для удаления
  // вложения, живой прогон 2026-08-17 добавил второго потребителя (кнопка
  // "Удалить запись" в шапке), имя переменной оставлено как есть (см.
  // комментарий у RecordCardProps.store/vaultPath выше).
  const canDeleteAttachments = Boolean(store && vaultPath);

  // Переключение на другую запись сбрасывает раскрытые поля, вкладку и
  // состояние обеих операций удаления - "Показать"/ошибка/открытая модалка
  // одной записи не должны утекать в следующую только потому, что карточка
  // не была размонтирована (список переиспользует один и тот же
  // <RecordCard>, меняя только item).
  useEffect(() => {
    setTab("fields");
    setRevealed(new Set());
    setRevealedHistory(new Set());
    setCopiedField(null);
    setCopyError(null);
    setAttachmentError(null);
    setDeleteConfirmVisible(false);
    setDeleteError(null);
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

  /**
   * Кнопка "Удалить запись" в шапке, после подтверждения в модалке ниже
   * (живой прогон 2026-08-17) - реальное необратимое удаление всей записи
   * (`store.deleteItem` + `store.save`), не локальное скрытие. Рендерится
   * только когда `store`/`vaultPath` оба переданы (см. `canDeleteAttachments`
   * выше).
   *
   * `store.save` вызывается сразу с `{ allowCountDecrease: true }` - без
   * этого флага `save()` бросал бы `ItemCountDecreasedError` на КАЖДОЕ
   * удаление одной записи: удаление всегда уменьшает число записей
   * относительно `loadedCount` (R28, vaultStore.ts, выставляется при
   * последней успешной загрузке/сохранении) - см. vaultStore.test.ts,
   * describe "VaultStore: save() refuses a silent item-count decrease
   * (R28)". Модалка подтверждения ниже ("Действие нельзя отменить") - и
   * есть то самое явное согласие пользователя на уменьшение числа записей;
   * второй диалог R28 поверх неё был бы избыточным повтором одного и того
   * же решения (тот же принцип, что и `confirmCountWarningAndSave` в
   * Editor.tsx применяет к уже подтверждённому пользователем сохранению).
   */
  async function handleDeleteItem() {
    if (!store || !vaultPath) return; // defensive - кнопка не должна была отрендериться без обоих пропов
    setDeleteError(null);
    try {
      store.deleteItem(item.id);
      await store.save(vaultPath, { allowCountDecrease: true });
      onDeleted?.(item.id);
    } catch (err) {
      console.error("RecordCard: не удалось удалить запись", err);
      setDeleteError("Не удалось удалить запись. Попробуйте снова.");
    }
  }

  /** R89: Esc закрывает открытое - единственное, что может быть открыто в
   * этом компоненте, это модалка подтверждения удаления записи.
   * `stopPropagation` - иначе то же нажатие Esc заодно закрыло бы и саму
   * карточку через обработчик `List.tsx` (тот же приём, что в Editor.tsx
   * применяет к своим модалкам поверх `requestCloseInternal`). */
  function handleRecordCardKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape") return;
    // Окно с QR закрывается первым: оно и открывается последним, поверх всего
    // остального.
    if (qrView) {
      e.stopPropagation();
      setQrView(null);
      return;
    }
    if (!deleteConfirmVisible) return;
    e.stopPropagation();
    setDeleteConfirmVisible(false);
  }

  function toggleReveal(index: number) {
    setRevealed((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
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

  async function handleCopy(field: ItemField, index: number) {
    // Буфер обмена - граница ОС, запись может отклоняться (нет разрешения,
    // недоступен в текущем контексте и т.п.) - падать тихо в необработанный
    // reject недопустимо (CLAUDE.md §5 "Handle failures where they can
    // occur"), пользователь должен увидеть, что копирование не удалось,
    // а не решить, что просто забыл нажать кнопку.
    try {
      setCopyError(null);
      // 30 секунд - буквально из брифа (R48), не настраивается с этого места.
      // У поля двухфакторки копируется текущий код, а не ссылка otpauth://.
      const totp = looksLikeTotp(field.value) ? totpCodes[index] : null;
      await copyWithAutoClear(totp ?? field.value);
      setCopiedField(index);
      window.setTimeout(() => {
        setCopiedField((current) => (current === index ? null : current));
      }, 2000);
    } catch (err) {
      console.error("RecordCard: не удалось скопировать значение в буфер обмена", err);
      setCopyError("Не удалось скопировать значение в буфер обмена.");
    }
  }

  return (
    <section className="record-card" aria-label={`Запись: ${item.title}`} onKeyDown={handleRecordCardKeyDown}>
      <header className="record-card__header">
        <div className="record-card__heading">
          <span className="record-card__type">{TYPE_LABELS[item.type]}</span>
          <h2 className="record-card__title">{item.title}</h2>
        </div>
        <div className="record-card__header-actions">
          {/* Звезда и дублирование - иконками, как и всё остальное в карточке:
              подписи здесь соревновались бы за место с «Редактировать». */}
          {onTogglePinned && (
            <button
              type="button"
              className={
                "record-card__icon-btn" + (item.pinned ? " record-card__icon-btn--on" : "")
              }
              onClick={() => onTogglePinned(item.id, !item.pinned)}
              aria-pressed={item.pinned === true}
              aria-label={item.pinned ? UNPIN_LABEL : PIN_LABEL}
              title={item.pinned ? UNPIN_LABEL : PIN_LABEL}
            >
              <StarIcon filled={item.pinned === true} />
            </button>
          )}
          {onDuplicate && (
            <button
              type="button"
              className="record-card__icon-btn"
              onClick={() => onDuplicate(item.id)}
              aria-label={DUPLICATE_LABEL}
              title={DUPLICATE_LABEL}
            >
              <DuplicateIcon />
            </button>
          )}
          <button type="button" className="record-card__edit-btn" onClick={() => onEdit(item.id)}>
            Редактировать
          </button>
          {canDeleteAttachments && (
            <button
              type="button"
              className="record-card__delete-btn"
              onClick={() => setDeleteConfirmVisible(true)}
            >
              Удалить запись
            </button>
          )}
        </div>
      </header>

      {deleteError && (
        <p className="record-card__copy-error" role="alert">
          {deleteError}
        </p>
      )}

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
              обмена Windows (Win+V) может сохранить его отдельно от приложения - её отключают
              в «Параметры → Система → Буфер обмена → Журнал буфера обмена».
            </p>
          )}

          {/* Живая область для экранных читалок: смену подписи на кнопке они
              не замечают, а подтверждение копирования получить обязаны. */}
          <span className="visually-hidden" role="status" aria-live="polite">
            {copiedField ? `Значение поля «${copiedField}» скопировано` : ""}
          </span>

          {copyError && (
            <p className="record-card__copy-error" role="alert">
              {copyError}
            </p>
          )}

          {item.fields.length === 0 && <p className="record-card__empty">У записи пока нет полей.</p>}

          {/* Аккаунты внутри записи: поля с одинаковой пометкой `group`
              собираются в блок с заголовком. Без разделения три учётки одного
              сервиса лежали одной кашей, и понять, какой пароль к какой почте,
              было нельзя. */}
          {cardFieldGroups(item.fields).map((group) => (
            <div
              className={`record-card__group${group.name !== null ? " record-card__group--account" : ""}`}
              key={group.name ?? "__common"}
            >
              {group.name !== null && <h3 className="record-card__group-title">{group.name}</h3>}
              {group.entries.map(({ field, index }) => {
            const isRevealed = !field.secret || revealed.has(index);
            const stale = field.secret && isSecretFieldStale(item, field.name);
            // Значок ставится только у полей «Пароль»: проблемы считаются
            // именно для них (CVC и ключи секретные, но «слабый пароль» для
            // них бессмысленно). Одна точка на все поводы - см. StatusDot.
            const isPasswordField =
              field.secret && field.name.trim().toLowerCase() === "пароль";
            const fieldIssueLabel = isPasswordField
              ? passwordIssueLabel(passwordIssues ?? NO_PASSWORD_ISSUES, Boolean(stale))
              : stale
                ? passwordIssueLabel(NO_PASSWORD_ISSUES, true)
                : null;
            return (
              <div className="record-card__field" key={index}>
                <div className="record-card__field-label">
                  {fieldIssueLabel && (
                    <StatusDot
                      kind="passwordIssue"
                      className="record-card__field-dot"
                      label={fieldIssueLabel}
                    />
                  )}
                  <span>{field.name}</span>
                </div>
                <div className="record-card__field-row">
                  {looksLikeTotp(field.value) ? (
                    <TotpCode
                      value={field.value}
                      onCodeChange={(code) =>
                        setTotpCodes((prev) =>
                          prev[index] === code ? prev : { ...prev, [index]: code },
                        )
                      }
                    />
                  ) : (
                    <span
                      className={`record-card__field-value${
                        field.secret ? " record-card__field-value--mono" : ""
                      }`}
                    >
                      {isRevealed ? field.value : SECRET_MASK}
                    </span>
                  )}
                  {/* У кода двухфакторки прятать нечего: он живёт тридцать
                      секунд и бесполезен без пароля. */}
                  {field.secret && !looksLikeTotp(field.value) && (
                    <button
                      type="button"
                      className="record-card__field-btn record-card__field-btn--icon"
                      onClick={() => toggleReveal(index)}
                      aria-pressed={isRevealed}
                      aria-label={isRevealed ? REVEAL_HIDE_LABEL : REVEAL_SHOW_LABEL}
                      title={isRevealed ? REVEAL_HIDE_LABEL : REVEAL_SHOW_LABEL}
                    >
                      <EyeIcon off={isRevealed} />
                    </button>
                  )}
                  {/*
                    Отклик на копирование - самое частое действие в
                    приложении. Раньше он был чисто текстовым: подпись менялась
                    на «Скопировано» и через две секунды возвращалась, без
                    единого движения. В монохроме такую смену легко пропустить,
                    особенно если смотришь в этот момент на значение, а не на
                    кнопку.
                    Класс-модификатор даёт короткую вспышку (см. CSS), а
                    Экранной читалке то же самое сообщает живая область ниже
                    по разметке: без неё подтверждение существовало только для
                    зрячих.
                  */}
                  <button
                    type="button"
                    className={
                      "record-card__field-btn record-card__field-btn--icon" +
                      (copiedField === index ? " record-card__field-btn--copied" : "")
                    }
                    onClick={() => handleCopy(field, index)}
                    aria-label={copiedField === index ? COPIED_LABEL : COPY_LABEL}
                    title={copiedField === index ? COPIED_LABEL : COPY_LABEL}
                  >
                    {copiedField === index ? <CheckIcon /> : <CopyIcon />}
                  </button>
                  {/* QR - рядом с копированием: это тот же жест «забрать
                      значение отсюда», только приёмник не буфер обмена, а
                      телефон. Отдельной крупной кнопки не заводим, иначе
                      строка поля превращается в панель инструментов. */}
                  {/* Поле с адресом открывается в браузере одним нажатием -
                      раньше его можно было только скопировать и вставить
                      руками. Открываются только http и https, см.
                      `openExternal`: отдать системе произвольную строку из
                      базы значит позволить ей запускать посторонние программы. */}
                  {isOpenableUrl(field.value) && (
                    <button
                      type="button"
                      className="record-card__field-btn record-card__field-btn--icon"
                      onClick={() => void openExternal(field.value)}
                      aria-label={OPEN_LABEL}
                      title={OPEN_LABEL}
                    >
                      <ExternalIcon />
                    </button>
                  )}
                  {/* QR со ссылкой otpauth:// - это перенос секрета на другое
                      устройство, а не передача кода, и здесь он был бы
                      ловушкой: сканирующий получил бы вечный доступ вместо
                      одноразового числа. */}
                  {!looksLikeTotp(field.value) && (
                  <button
                    type="button"
                    className="record-card__field-btn record-card__field-btn--icon"
                    onClick={() => showQr(field)}
                    aria-label={QR_LABEL}
                    title={QR_LABEL}
                  >
                    <QrIcon />
                  </button>
                  )}
                </div>
              </div>
            );
              })}
            </div>
          ))}

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
                  <li className="record-card__attachment" key={att.id}>
                   <div className="record-card__attachment-row">
                    <span className="record-card__attachment-name">{att.name}</span>
                    <span className="record-card__attachment-size">{formatFileSize(att.size)}</span>
                    {previewKindFor(att.mimeType, att.size) !== "none" && (
                      <button
                        type="button"
                        className="record-card__field-btn"
                        aria-expanded={expandedAttachments.has(att.id)}
                        onClick={() => toggleAttachmentPreview(att.id)}
                      >
                        {expandedAttachments.has(att.id) ? "Свернуть" : "Показать"}
                      </button>
                    )}
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
                   </div>

                   {/* Причина показывается на самой строке, а не общей справкой
                       сверху: человек спрашивает «почему не открывается»,
                       глядя на конкретный файл, и ответ должен быть там же. */}
                   {previewUnavailableReason(att.mimeType, att.size) && (
                     <p className="record-card__attachment-note">
                       {previewUnavailableReason(att.mimeType, att.size)}
                     </p>
                   )}

                   {expandedAttachments.has(att.id) && (
                     <div className="record-card__attachment-preview">
                       {previewKindFor(att.mimeType, att.size) === "image" ? (
                         <img
                           className="record-card__attachment-image"
                           src={imageDataUrl(att.mimeType, att.data)}
                           alt={`Предпросмотр вложения ${att.name}`}
                         />
                       ) : (
                         (() => {
                           const text = decodeTextPreview(att.data);
                           // Отдельная ветка вместо молчаливого показа мусора:
                           // файл с расширением .txt вполне может оказаться
                           // двоичным, и тогда честнее сказать это словами.
                           return text === null ? (
                             <p className="record-card__attachment-note">
                               Не удалось прочитать файл как текст. Скачайте его, чтобы открыть.
                             </p>
                           ) : (
                             <pre className="record-card__attachment-text">{truncateForPreview(text)}</pre>
                           );
                         })()
                       )}
                     </div>
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
                        className="record-card__field-btn record-card__field-btn--icon"
                        onClick={() => toggleHistoryReveal(key)}
                        aria-pressed={shown}
                        aria-label={shown ? REVEAL_HIDE_LABEL : REVEAL_SHOW_LABEL}
                        title={shown ? REVEAL_HIDE_LABEL : REVEAL_SHOW_LABEL}
                      >
                        <EyeIcon off={shown} />
                      </button>
                    </div>
                  );
                })}
              </li>
            ))}
        </ul>
      )}

      {qrView && (
        <div className="record-card__modal-overlay" role="presentation">
          <div
            ref={qrRef}
            className="record-card__modal record-card__qr-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-card-qr-title"
          >
            <h2 id="record-card-qr-title">{qrView.fieldName}</h2>
            {qrView.matrix ? (
              <>
                {/* Код рисуется одним путём по матрице (см. lib/qr.ts).
                    Белый фон здесь не из палитры и не ошибка: сканеру нужен
                    контраст тёмного по светлому, и тёмная плитка на тёмном
                    фоне читалась бы через раз. */}
                <svg
                  className="record-card__qr"
                  viewBox={qrSvgPath(qrView.matrix).viewBox}
                  role="img"
                  aria-label={`QR-код со значением поля «${qrView.fieldName}»`}
                  shapeRendering="crispEdges"
                >
                  <rect width="100%" height="100%" fill="#ffffff" />
                  <path d={qrSvgPath(qrView.matrix).path} fill="#000000" />
                </svg>
                <p className="record-card__qr-note">
                  Наведите камеру телефона. Значение нигде не сохраняется и не уходит в сеть,
                  окно закроется само через минуту.
                </p>
              </>
            ) : (
              <p className="record-card__qr-note">{QR_TOO_LONG_MESSAGE}</p>
            )}
            <div className="record-card__modal-actions">
              <button type="button" onClick={() => setQrView(null)}>
                Закрыть
              </button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirmVisible && (
        <div className="record-card__modal-overlay" role="presentation">
          <div
            ref={deleteConfirmRef}
            className="record-card__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="record-card-delete-title"
          >
            <h2 id="record-card-delete-title">Удаление записи</h2>
            <p>{formatDeleteConfirmMessage(item.title)}</p>
            <div className="record-card__modal-actions">
              <button type="button" onClick={() => setDeleteConfirmVisible(false)}>
                Отмена
              </button>
              <button
                type="button"
                className="record-card__modal-delete-btn"
                onClick={() => {
                  setDeleteConfirmVisible(false);
                  void handleDeleteItem();
                }}
              >
                Удалить
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
