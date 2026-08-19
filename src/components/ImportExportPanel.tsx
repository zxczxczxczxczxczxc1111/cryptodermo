import { useId, useState, type FormEvent, type KeyboardEvent, useRef } from "react";
import { useModalFocus } from "../hooks/useModalFocus";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Item, NewItemInput, VaultStore } from "../lib/vaultStore";
import { readVault, writeVaultAtomic } from "../lib/tauriApi";
import {
  buildCsvImportConfirmationMessage,
  buildExportFilename,
  buildManualCopyFilename,
  buildReplaceConfirmationMessage,
  parseCsvPasswordImport,
  parseImportFile,
  serializeExport,
  splitCsvImportDuplicates,
} from "../lib/importExport";
import { buildKdbxExportFilename, buildKdbxFile } from "../lib/kdbxExport";
import { parseKdbxFile, KdbxImportError, KDBX_IMPORT_FAILED_MESSAGE } from "../lib/kdbxImport";
import { PasswordField } from "./PasswordField";
import "./ImportExportPanel.css";

/**
 * Ручной бэкап и импорт/экспорт (тикет 10, R99/R100/R100.1, spec.md §12).
 *
 * Самостоятельный компонент с публичным контрактом через пропсы/колбэки
 * (`ImportExportPanelProps` ниже) - не смонтирован ни в `App.tsx`, ни в
 * какой-либо экран (тот же приём, что у `PasswordGenerator.tsx` и
 * `Editor.tsx`/`RecordCard.tsx`: интеграция - забота более позднего тикета
 * сведения экранов, не этого).
 *
 * Четыре независимых действия (первые три - исходные тикета 10, четвёртое
 * добавлено 19.08.2026):
 * - «Сохранить копию» (R99) - диалог `save()`, имя файла по умолчанию с
 *   датой, пишет байты текущей базы (`store.toBytes()`) напрямую через
 *   `writeVaultAtomic` в выбранный пользователем путь. Намеренно НЕ
 *   `store.save(path)` - тот метод (тикет 05) сам ведёт бэкап-ротацию
 *   `backups/` и считает копию в лимит `MAX_BACKUPS`, а «Сохранить копию» -
 *   отдельное действие пользователя, в этот лимит не входящее (дословно из
 *   тикета).
 * - «Экспорт» (R100) - весь `Item[]` (`store.search("")` - пустая строка
 *   возвращает все записи, см. контракт `VaultStore.search` в
 *   `vaultStore.ts`) в открытый форматированный JSON через тот же `save()`.
 *   Перед показом системного диалога сохранения - явное предупреждение
 *   (модалка `exportConfirmVisible`, тот же inline-паттерн `role="dialog"`,
 *   что и у модалки подтверждения импорта ниже): содержимое файла экспорта
 *   намеренно нешифрованное (R100, см. комментарий у `serializeExport` в
 *   `importExport.ts`), но до этой модалки ничего не предупреждало
 *   пользователя об этом ДО записи файла на диск - живая проверка нашла,
 *   что кнопка сразу открывала диалог сохранения. Сам формат экспорта эта
 *   модалка не меняет, только останавливает перед необратимой записью и
 *   даёт передумать («Отмена» - тот же диалог `save()` не открывается вовсе).
 * - «Импорт» (R100/R100.1) - `open()` -> чтение байт (`readVault`) ->
 *   `parseImportFile` (бросает `ImportValidationError` целиком на любой
 *   некорректной структуре, ничего не тронуто) -> второе явное
 *   подтверждение с текстом "Заменить N записей текущей базы на M из
 *   файла?" (первое подтверждение - сам выбор файла в системном диалоге,
 *   spec.md §12).
 * - «Импорт CSV» (19.08.2026) - СОВСЕМ ДРУГАЯ операция, не вариант «Импорта»
 *   выше: тот заменяет всю базу, этот ДОБАВЛЯЕТ записи к уже существующим из
 *   постороннего формата `name,url,username,password,note` (экспорт паролей
 *   Chrome/Google Password Manager) - см. `parseCsvPasswordImport` в
 *   `importExport.ts`. Перед подтверждением записи сверяются с уже
 *   существующими по названию/адресу сайта (`splitCsvImportDuplicates`) -
 *   похожие на уже внесённые не добавляются молча второй раз, их количество
 *   только показывается в тексте подтверждения. Добавление - обычный цикл
 *   `store.addItem()`, новые `id`/`createdAt` генерируются как при ручном
 *   создании записи, в отличие от «Импорта» выше.
 * - «Импорт KDBX» (19.08.2026, вечер) - обратная сторона моста: читает файл
 *   KeePass и ДОБАВЛЯЕТ его записи, как «Импорт CSV» (не заменяет базу, та же
 *   проверка дублей, то же подтверждение с числами). Как и «Экспорт в KDBX»,
 *   сначала спрашивает пароль, но ЧУЖОЙ, уже существующий - поэтому без
 *   подтверждения ввода, и неверный пароль не закрывает модалку, чтобы не
 *   заставлять заново выбирать файл из-за опечатки. Точного round-trip с
 *   нашим же экспортом не бывает - почему, разобрано в шапке `kdbxImport.ts`.
 * - «Экспорт в KDBX» (19.08.2026) - зашифрованный файл в формате KeePass 2,
 *   который открывают бесплатные офлайн-клиенты под iOS (KeePassium,
 *   Strongbox) и не только - см. подробный разбор формата, версии и
 *   проверку зависимости в шапке `kdbxExport.ts`. Единственное действие
 *   этой панели, которое СНАЧАЛА спрашивает не файл, а НОВЫЙ пароль -
 *   отдельный от мастер-пароля cryptodermo, потому что экспортированный файл
 *   живёт в другом приложении на другом устройстве и не должен зависеть от
 *   секрета основной базы. Дальше как у «Экспорта»: диалог `save()` ->
 *   запись байт.
 *
 * Фактическая замена коллекции после второго подтверждения идёт через
 * `store.replaceAllItems(items)` (тикет 05, `src/lib/vaultStore.ts`) -
 * метод сохраняет `id`/`createdAt`/`updatedAt`/`history` импортированных
 * записей как есть, не перегенерирует их (в отличие от `addItem`), поэтому
 * импорт - это буквально замена, а не пересоздание с потерей полей.
 * `replaceAllItems` только меняет память стора (`isDirty()` становится
 * `true`) - запись на диск (обычный `save()`) остаётся заботой вызывающего
 * кода вне этой панели, как и для любого другого изменения `VaultStore`.
 */

export type ImportExportPanelProps = {
  /** Загруженный `VaultStore` (createNewVault/loadFromBytes выше по дереву
   * уже отработали) - источник `toBytes()`/`search("")` для копии и
   * экспорта. */
  store: VaultStore;
  /** Источник текущего момента для имени файла по умолчанию - необязателен,
   * по умолчанию `() => new Date()`; параметр существует ради
   * детерминированных тестов вызывающего кода, не используется этим файлом
   * напрямую в тестах (сам компонент не покрыт автотестами - см. комментарий
   * выше и `importExport.test.ts`). */
  now?: () => Date;
  /** Копия успешно записана по выбранному пользователем пути. */
  onSaveCopySuccess?: (path: string) => void;
  /** Экспорт успешно записан по выбранному пользователем пути. */
  onExportSuccess?: (path: string) => void;
  /** Импорт применён (`store.replaceAllItems` отработал) - `count` записей
   * заменило прежнюю коллекцию. */
  onImportSuccess?: (count: number) => void;
  /** Импорт CSV применён (`store.addItem` отработал `count` раз) - в отличие
   * от `onImportSuccess`, коллекция не заменена, а дополнена, счётчик не
   * может уменьшиться, и вызывающему коду не нужна логика R28. */
  onCsvImportSuccess?: (count: number) => void;
  /** Импорт KDBX применён (`store.addItem` отработал `count` раз) - тот же
   * контракт, что у `onCsvImportSuccess`: добавление, не замена. */
  onKdbxImportSuccess?: (count: number) => void;
  /** Экспорт в KDBX успешно записан по выбранному пользователем пути. Ничего
   * не меняет в `store` (в отличие от импортов выше) - как и обычный
   * «Экспорт», это чтение, не запись в базу. */
  onKdbxExportSuccess?: (path: string) => void;
  /** Любая ошибка этого блока (диалог, запись, чтение, разбор файла) -
   * техническое сообщение для лога вызывающего кода. Пользовательский текст
   * (R84-R88) панель показывает сама, этот колбэк не заменяет его. */
  onError?: (message: string) => void;
};

export const SAVE_COPY_LABEL = "Сохранить копию";
const SAVE_COPY_DONE_LABEL = "Копия сохранена";
export const EXPORT_LABEL = "Экспорт";
const EXPORT_DONE_LABEL = "Экспортировано";
export const IMPORT_LABEL = "Импорт";
export const REPLACE_LABEL = "Заменить";
export const CSV_IMPORT_LABEL = "Импорт CSV";
export const CSV_ADD_LABEL = "Добавить";
export const KDBX_EXPORT_LABEL = "Экспорт в KDBX";
export const KDBX_IMPORT_LABEL = "Импорт KDBX";
export const KDBX_EXPORT_CONFIRM_LABEL = "Экспортировать";
const CANCEL_LABEL = "Отмена";
const IMPORT_DONE_LABEL = "Записи заменены";
const CSV_IMPORT_DONE_LABEL = "Записи добавлены";
const KDBX_EXPORT_DONE_LABEL = "Экспортировано";
const KDBX_IMPORT_DONE_LABEL = "Записи добавлены";
const CSV_IMPORT_NOTHING_TO_ADD_MESSAGE =
  "Все записи файла уже есть в базе (совпали по названию или адресу сайта) - добавлять нечего.";
/** Заголовок и текст кнопки подтверждения модалки перед экспортом (см.
 * комментарий у пункта «Экспорт» в шапке файла) - вынесены и экспортированы
 * по тому же принципу, что и остальные подписи выше (`SAVE_COPY_LABEL` и
 * т.д.): используются напрямую, а не хардкодом строки, если/когда для этого
 * компонента появятся тесты. Тело предупреждения (что именно нешифровано и
 * куда за защищённой копией) остаётся обычным текстом прямо в JSX ниже - тот
 * же приём, что уже применён для тела диалогов "Есть несохранённые
 * изменения"/"Число записей уменьшилось" в `Editor.tsx` (в константу
 * выносится заголовок/кнопка, не весь абзац). */
export const EXPORT_CONFIRM_TITLE = "Экспортировать без шифрования?";
export const EXPORT_CONFIRM_LABEL = "Экспортировать";

const DIALOG_OPEN_FAILED_MESSAGE = "Не удалось открыть системный диалог. Попробуйте ещё раз.";
const SAVE_COPY_FAILED_MESSAGE =
  "Не удалось сохранить копию базы. Проверьте, что выбранное место доступно для записи, и попробуйте снова.";
const EXPORT_FAILED_MESSAGE =
  "Не удалось сохранить файл экспорта. Проверьте, что выбранное место доступно для записи, и попробуйте снова.";
const IMPORT_READ_FAILED_MESSAGE =
  "Файл повреждён или не в формате экспорта Vault. Выберите файл, созданный кнопкой «Экспорт». База не изменена.";
const IMPORT_APPLY_FAILED_MESSAGE = "Не удалось заменить записи. База не изменена, попробуйте снова.";
const CSV_IMPORT_READ_FAILED_MESSAGE =
  "Не похоже на экспорт паролей Chrome/Google (нужны колонки name/url/username/password), либо файл повреждён. База не изменена.";
const CSV_IMPORT_APPLY_FAILED_MESSAGE = "Не удалось добавить записи, попробуйте снова.";
const KDBX_EXPORT_FAILED_MESSAGE =
  "Не удалось создать или сохранить файл KDBX. Проверьте, что выбранное место доступно для записи, и попробуйте снова.";
const KDBX_PASSWORD_MISMATCH_MESSAGE = "Пароли не совпадают.";

type ImportState = { kind: "idle" } | { kind: "confirming"; items: Item[]; currentCount: number };

type CsvImportState =
  | { kind: "idle" }
  | { kind: "confirming"; toAdd: NewItemInput[]; duplicateCount: number };

export function ImportExportPanel({
  store,
  now = () => new Date(),
  onSaveCopySuccess,
  onExportSuccess,
  onImportSuccess,
  onCsvImportSuccess,
  onKdbxImportSuccess,
  onKdbxExportSuccess,
  onError,
}: ImportExportPanelProps) {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"copy" | "export" | "import" | "csvImport" | "kdbxExport" | "kdbxImport" | null>(null);
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const [csvImportState, setCsvImportState] = useState<CsvImportState>({ kind: "idle" });
  const [exportConfirmVisible, setExportConfirmVisible] = useState(false);
  /** Импорт KDBX: пароль ЧУЖОГО файла. Отдельно от пароля экспорта - это
   * разные вещи (там мы пароль назначаем, здесь вводим существующий), и
   * подтверждение ввода здесь не нужно. `wrong` включается после неудачной
   * попытки: человек чаще всего просто опечатался, и переоткрывать диалог
   * выбора файла ради этого незачем. */
  const [kdbxImportPasswordVisible, setKdbxImportPasswordVisible] = useState(false);
  const [kdbxImportPassword, setKdbxImportPassword] = useState("");
  const [kdbxImportError, setKdbxImportError] = useState<string | null>(null);
  const [kdbxImportState, setKdbxImportState] = useState<CsvImportState>({ kind: "idle" });
  const [kdbxPasswordVisible, setKdbxPasswordVisible] = useState(false);
  const [kdbxPassword, setKdbxPassword] = useState("");
  const [kdbxConfirmPassword, setKdbxConfirmPassword] = useState("");
  const [kdbxPasswordError, setKdbxPasswordError] = useState<string | null>(null);
  const exportConfirmRef = useRef<HTMLDivElement>(null);
  const importConfirmRef = useRef<HTMLDivElement>(null);
  const csvImportConfirmRef = useRef<HTMLDivElement>(null);
  const kdbxPasswordRef = useRef<HTMLDivElement>(null);
  const kdbxImportPasswordRef = useRef<HTMLDivElement>(null);
  const kdbxImportConfirmRef = useRef<HTMLDivElement>(null);
  useModalFocus(exportConfirmRef, exportConfirmVisible);
  useModalFocus(importConfirmRef, importState.kind === "confirming");
  useModalFocus(csvImportConfirmRef, csvImportState.kind === "confirming");
  useModalFocus(kdbxPasswordRef, kdbxPasswordVisible);
  useModalFocus(kdbxImportPasswordRef, kdbxImportPasswordVisible);
  useModalFocus(kdbxImportConfirmRef, kdbxImportState.kind === "confirming");
  const confirmTitleId = useId();
  const kdbxImportTitleId = useId();
  const kdbxImportFieldId = useId();
  const kdbxImportConfirmTitleId = useId();
  const kdbxTitleId = useId();
  const kdbxPasswordFieldId = useId();
  const kdbxConfirmFieldId = useId();
  const exportConfirmTitleId = useId();
  const csvConfirmTitleId = useId();

  function reportError(userMessage: string, technicalDetail: unknown) {
    setStatusMessage(null);
    setErrorMessage(userMessage);
    onError?.(technicalDetail instanceof Error ? technicalDetail.message : String(technicalDetail));
  }

  async function handleSaveCopy() {
    setErrorMessage(null);
    setStatusMessage(null);
    let path: string | null;
    try {
      path = await save({
        title: "Сохранить копию базы",
        defaultPath: buildManualCopyFilename(now()),
        filters: [{ name: "cryptodermo", extensions: ["dat"] }],
      });
    } catch (err) {
      reportError(DIALOG_OPEN_FAILED_MESSAGE, err);
      return;
    }
    if (path === null) return; // пользователь отменил диалог - не ошибка

    setBusy("copy");
    try {
      const bytes = await store.toBytes();
      await writeVaultAtomic(path, bytes);
      setStatusMessage(`${SAVE_COPY_DONE_LABEL}: ${path}`);
      onSaveCopySuccess?.(path);
    } catch (err) {
      reportError(SAVE_COPY_FAILED_MESSAGE, err);
    } finally {
      setBusy(null);
    }
  }

  /** Клик по кнопке «Экспорт» - только открывает модалку предупреждения, не
   * трогает диалог сохранения. Само действие (диалог `save()` -> запись
   * файла) переехало в `confirmExport` ниже без изменений в этой части -
   * модалка встала строго ПЕРЕД прежним началом `handleExport`. */
  function requestExport() {
    setErrorMessage(null);
    setStatusMessage(null);
    setExportConfirmVisible(true);
  }

  /** «Отмена» в модалке предупреждения - модалка закрывается, диалог
   * сохранения при этом не открывается вовсе (в отличие от отмены уже
   * открытого системного диалога `save()`, которая и раньше не была
   * ошибкой). */
  function cancelExport() {
    setExportConfirmVisible(false);
  }

  /** Подтверждение модалки предупреждения - дальше тот же поток, что раньше
   * был в `handleExport` целиком: диалог `save()` -> запись открытого JSON. */
  async function confirmExport() {
    setExportConfirmVisible(false);
    let path: string | null;
    try {
      path = await save({
        title: "Экспорт записей",
        defaultPath: buildExportFilename(now()),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch (err) {
      reportError(DIALOG_OPEN_FAILED_MESSAGE, err);
      return;
    }
    if (path === null) return;

    setBusy("export");
    try {
      const json = serializeExport(store.search(""));
      await writeVaultAtomic(path, new TextEncoder().encode(json));
      setStatusMessage(`${EXPORT_DONE_LABEL}: ${path}`);
      onExportSuccess?.(path);
    } catch (err) {
      reportError(EXPORT_FAILED_MESSAGE, err);
    } finally {
      setBusy(null);
    }
  }

  async function handleImportPick() {
    setErrorMessage(null);
    setStatusMessage(null);
    let path: string | string[] | null;
    try {
      path = await open({
        title: "Импорт записей",
        multiple: false,
        directory: false,
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
    } catch (err) {
      reportError(DIALOG_OPEN_FAILED_MESSAGE, err);
      return;
    }
    if (path === null || Array.isArray(path)) return; // отмена диалога

    setBusy("import");
    try {
      const bytes = await readVault(path);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const items = parseImportFile(text);
      // Второе подтверждение (R100): выбор файла выше - первое действие,
      // этот экран с точным числом N/M - второе, явное. `parseImportFile`
      // бросает `ImportValidationError` на любой некорректной структуре -
      // единый пользовательский текст ниже не различает причину (сломанный
      // JSON / неизвестный `type` / не наш файл вообще), что случилось
      // технически - уходит в `onError` через `reportError`.
      setImportState({ kind: "confirming", items, currentCount: store.search("").length });
    } catch (err) {
      reportError(IMPORT_READ_FAILED_MESSAGE, err);
    } finally {
      setBusy(null);
    }
  }

  function cancelImport() {
    setImportState({ kind: "idle" });
  }

  /**
   * Выбор CSV-файла - в отличие от `handleImportPick`, здесь нет операции
   * "заменить": `parseCsvPasswordImport` разбирает файл, `splitCsvImportDuplicates`
   * сразу же отделяет записи, похожие на уже существующие (не показываются в
   * модалке подтверждения вовсе, только их количество). Если добавлять
   * нечего (весь файл - дубликаты), модалка не открывается, статус
   * сообщается прямо здесь - показывать "Добавить 0 записей?" было бы
   * бессмысленным подтверждением.
   */
  async function handleCsvImportPick() {
    setErrorMessage(null);
    setStatusMessage(null);
    let path: string | string[] | null;
    try {
      path = await open({
        title: "Импорт CSV (Chrome, Google Password Manager)",
        multiple: false,
        directory: false,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
    } catch (err) {
      reportError(DIALOG_OPEN_FAILED_MESSAGE, err);
      return;
    }
    if (path === null || Array.isArray(path)) return; // отмена диалога

    setBusy("csvImport");
    try {
      const bytes = await readVault(path);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const candidates = parseCsvPasswordImport(text);
      const { toAdd, duplicateCount } = splitCsvImportDuplicates(candidates, store.search(""));
      if (toAdd.length === 0) {
        setStatusMessage(CSV_IMPORT_NOTHING_TO_ADD_MESSAGE);
        return;
      }
      setCsvImportState({ kind: "confirming", toAdd, duplicateCount });
    } catch (err) {
      reportError(CSV_IMPORT_READ_FAILED_MESSAGE, err);
    } finally {
      setBusy(null);
    }
  }

  function cancelCsvImport() {
    setCsvImportState({ kind: "idle" });
  }

  /** Подтверждение CSV-импорта - обычный цикл `addItem` (новые `id`/`createdAt`
   * генерируются как при ручном создании записи, в отличие от «Импорта» выше,
   * который сохраняет чужие `id` как есть). Если `addItem` бросит на записи
   * посреди цикла (не должен - `parseCsvPasswordImport` уже гарантировал
   * форму `NewItemInput`), уже добавленные записи остаются в сторе: частичный
   * успех здесь не противоречит R100.1 - это ДОБАВЛЕНИЕ, не замена, отменять
   * уже добавленные записи означало бы прятать чужую работу без причины. */
  function confirmCsvImport() {
    if (csvImportState.kind !== "confirming") return;
    const { toAdd } = csvImportState;
    try {
      for (const input of toAdd) store.addItem(input);
    } catch (err) {
      reportError(CSV_IMPORT_APPLY_FAILED_MESSAGE, err);
      return;
    }
    setCsvImportState({ kind: "idle" });
    setErrorMessage(null);
    setStatusMessage(CSV_IMPORT_DONE_LABEL);
    onCsvImportSuccess?.(toAdd.length);
  }

  /**
   * Импорт KDBX. Порядок шагов тот же, что у экспорта (сначала пароль, потом
   * файл), но пароль здесь ЧУЖОЙ, уже существующий, поэтому подтверждения
   * ввода нет.
   *
   * Дальше всё как у CSV-импорта: разбор, отсев дубликатов по названию и
   * адресу сайта, подтверждение с числами, добавление через `addItem`.
   * Заменять базу этот путь не умеет вовсе - см. шапку файла.
   */
  function requestKdbxImport() {
    setErrorMessage(null);
    setStatusMessage(null);
    setKdbxImportPassword("");
    setKdbxImportError(null);
    setKdbxImportPasswordVisible(true);
  }

  function cancelKdbxImport() {
    setKdbxImportPasswordVisible(false);
    setKdbxImportPassword("");
    setKdbxImportError(null);
  }

  async function confirmKdbxImportPassword(e: FormEvent) {
    e.preventDefault();
    if (kdbxImportPassword.length === 0) return;

    let path: string | string[] | null;
    try {
      path = await open({
        title: "Импорт KDBX (KeePass)",
        multiple: false,
        directory: false,
        filters: [{ name: "KeePass", extensions: ["kdbx"] }],
      });
    } catch (err) {
      reportError(DIALOG_OPEN_FAILED_MESSAGE, err);
      return;
    }
    if (path === null || Array.isArray(path)) return; // отмена диалога

    setBusy("kdbxImport");
    try {
      const bytes = await readVault(path);
      const candidates = await parseKdbxFile(bytes, kdbxImportPassword);
      const { toAdd, duplicateCount } = splitCsvImportDuplicates(candidates, store.search(""));
      // Пароль больше не нужен - убираем из состояния сразу, не дожидаясь
      // конца всего сценария подтверждения.
      setKdbxImportPassword("");
      setKdbxImportPasswordVisible(false);
      if (toAdd.length === 0) {
        setStatusMessage(CSV_IMPORT_NOTHING_TO_ADD_MESSAGE);
        return;
      }
      setKdbxImportState({ kind: "confirming", toAdd, duplicateCount });
    } catch (err) {
      // Неверный пароль - самый частый исход, и он не должен закрывать
      // модалку: человек дописывает пароль и пробует снова, не проходя заново
      // весь путь с выбором файла.
      if (err instanceof KdbxImportError) {
        setKdbxImportError(err.message);
        console.error("ImportExportPanel: не удалось прочитать файл KDBX", err);
      } else {
        setKdbxImportPasswordVisible(false);
        setKdbxImportPassword("");
        reportError(KDBX_IMPORT_FAILED_MESSAGE, err);
      }
    } finally {
      setBusy(null);
    }
  }

  function cancelKdbxImportConfirm() {
    setKdbxImportState({ kind: "idle" });
  }

  function confirmKdbxImport() {
    if (kdbxImportState.kind !== "confirming") return;
    const { toAdd } = kdbxImportState;
    try {
      for (const input of toAdd) store.addItem(input);
    } catch (err) {
      reportError(CSV_IMPORT_APPLY_FAILED_MESSAGE, err);
      return;
    }
    setKdbxImportState({ kind: "idle" });
    setErrorMessage(null);
    setStatusMessage(KDBX_IMPORT_DONE_LABEL);
    onKdbxImportSuccess?.(toAdd.length);
  }

  /** Открывает модалку ввода пароля - в отличие от остальных действий,
   * первый шаг «Экспорта в KDBX» не диалог выбора файла, а НОВЫЙ пароль
   * (см. комментарий у пункта в шапке файла). Прошлый ввод сбрасывается на
   * случай повторного открытия после отмены. */
  function requestKdbxExport() {
    setErrorMessage(null);
    setStatusMessage(null);
    setKdbxPassword("");
    setKdbxConfirmPassword("");
    setKdbxPasswordError(null);
    setKdbxPasswordVisible(true);
  }

  function cancelKdbxExport() {
    setKdbxPasswordVisible(false);
    setKdbxPassword("");
    setKdbxConfirmPassword("");
    setKdbxPasswordError(null);
  }

  /**
   * Подтверждение пароля -> дальше тот же поток, что у обычного «Экспорта»:
   * диалог `save()` -> запись байт. Сборка файла (`buildKdbxFile`) - и есть
   * самая тяжёлая часть (реальное шифрование KDBX), поэтому `busy`
   * выставляется вокруг неё, а не только вокруг записи на диск.
   *
   * Пароль убирается из состояния сразу после использования - и при успехе,
   * и при ошибке (`finally`), не остаётся висеть в памяти компонента дольше,
   * чем нужно.
   */
  async function confirmKdbxExport(e: FormEvent) {
    e.preventDefault();
    if (kdbxPassword.length === 0) return;
    if (kdbxPassword !== kdbxConfirmPassword) {
      setKdbxPasswordError(KDBX_PASSWORD_MISMATCH_MESSAGE);
      return;
    }
    setKdbxPasswordVisible(false);
    setKdbxPasswordError(null);

    let path: string | null;
    try {
      path = await save({
        title: "Экспорт в KDBX",
        defaultPath: buildKdbxExportFilename(now()),
        filters: [{ name: "KeePass", extensions: ["kdbx"] }],
      });
    } catch (err) {
      reportError(DIALOG_OPEN_FAILED_MESSAGE, err);
      setKdbxPassword("");
      setKdbxConfirmPassword("");
      return;
    }
    if (path === null) {
      setKdbxPassword("");
      setKdbxConfirmPassword("");
      return;
    }

    setBusy("kdbxExport");
    try {
      const data = await buildKdbxFile(store.search(""), kdbxPassword, "cryptodermo");
      await writeVaultAtomic(path, new Uint8Array(data));
      setStatusMessage(`${KDBX_EXPORT_DONE_LABEL}: ${path}`);
      onKdbxExportSuccess?.(path);
    } catch (err) {
      reportError(KDBX_EXPORT_FAILED_MESSAGE, err);
    } finally {
      setBusy(null);
      setKdbxPassword("");
      setKdbxConfirmPassword("");
    }
  }

  /** R89: Esc закрывает открытое - здесь это модалка предупреждения перед
   * экспортом, модалка подтверждения замены записей при импорте, модалка
   * подтверждения CSV-импорта, либо форма пароля перед экспортом в KDBX
   * (Esc = "Отмена", тот же путь, что и кнопка каждой из них; открыться
   * одновременно они не могут - разные пользовательские действия их
   * показывают). Останавливает всплытие, чтобы то же нажатие не закрыло
   * следом ещё и весь экран позади (тикет 12 монтирует эту панель как раздел
   * приложения со своим Esc "назад к списку" - закрывается только самое
   * верхнее открытое). Вне модалок ничего не делает - тикету 12 есть куда
   * отдать это нажатие самому. */
  function handlePanelKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape") return;
    if (kdbxPasswordVisible) {
      e.stopPropagation();
      cancelKdbxExport();
      return;
    }
    if (csvImportState.kind === "confirming") {
      e.stopPropagation();
      cancelCsvImport();
      return;
    }
    if (exportConfirmVisible) {
      e.stopPropagation();
      cancelExport();
      return;
    }
    if (importState.kind === "confirming") {
      e.stopPropagation();
      cancelImport();
    }
  }

  function confirmImport() {
    if (importState.kind !== "confirming") return;
    const { items } = importState;
    try {
      store.replaceAllItems(items);
    } catch (err) {
      reportError(IMPORT_APPLY_FAILED_MESSAGE, err);
      return;
    }
    setImportState({ kind: "idle" });
    setErrorMessage(null);
    setStatusMessage(IMPORT_DONE_LABEL);
    onImportSuccess?.(items.length);
  }

  return (
    <section
      className="import-export-panel"
      aria-label="Резервная копия и обмен данными"
      onKeyDown={handlePanelKeyDown}
    >
      <div className="import-export-panel__actions">
        <button type="button" onClick={() => void handleSaveCopy()} disabled={busy !== null}>
          {SAVE_COPY_LABEL}
        </button>
        <button type="button" onClick={requestExport} disabled={busy !== null}>
          {EXPORT_LABEL}
        </button>
        <button type="button" onClick={() => void handleImportPick()} disabled={busy !== null}>
          {IMPORT_LABEL}
        </button>
        <button type="button" onClick={() => void handleCsvImportPick()} disabled={busy !== null}>
          {CSV_IMPORT_LABEL}
        </button>
        <button type="button" onClick={requestKdbxImport} disabled={busy !== null}>
          {KDBX_IMPORT_LABEL}
        </button>
        <button type="button" onClick={requestKdbxExport} disabled={busy !== null}>
          {KDBX_EXPORT_LABEL}
        </button>
      </div>

      <p className="import-export-panel__status" aria-live="polite">
        {statusMessage ?? ""}
      </p>
      {errorMessage && (
        <p className="import-export-panel__error" role="alert">
          {errorMessage}
        </p>
      )}

      {exportConfirmVisible && (
        <div className="import-export-panel__modal-overlay" role="presentation">
          <div
ref={exportConfirmRef}
            className="import-export-panel__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={exportConfirmTitleId}
          >
            <h2 id={exportConfirmTitleId}>{EXPORT_CONFIRM_TITLE}</h2>
            <p>
              Файл экспорта будет содержать все пароли и секреты в открытом, нешифрованном виде - как обычный текст,
              без какой-либо защиты.
            </p>
            <p>Любой, у кого окажется доступ к этому файлу, сможет прочитать его содержимое целиком.</p>
            <p>Для защищённой резервной копии используйте «{SAVE_COPY_LABEL}» - она пишет базу в зашифрованном виде.</p>
            <div className="import-export-panel__modal-actions">
              <button type="button" onClick={cancelExport}>
                {CANCEL_LABEL}
              </button>
              <button type="button" onClick={() => void confirmExport()}>
                {EXPORT_CONFIRM_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}

      {importState.kind === "confirming" && (
        <div className="import-export-panel__modal-overlay" role="presentation">
          <div
ref={importConfirmRef}
            className="import-export-panel__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={confirmTitleId}
          >
            <h2 id={confirmTitleId}>Заменить записи</h2>
            <p>{buildReplaceConfirmationMessage(importState.currentCount, importState.items.length)}</p>
            <div className="import-export-panel__modal-actions">
              <button type="button" onClick={cancelImport}>
                {CANCEL_LABEL}
              </button>
              <button type="button" onClick={confirmImport}>
                {REPLACE_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}

      {csvImportState.kind === "confirming" && (
        <div className="import-export-panel__modal-overlay" role="presentation">
          <div
            ref={csvImportConfirmRef}
            className="import-export-panel__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={csvConfirmTitleId}
          >
            <h2 id={csvConfirmTitleId}>Добавить записи</h2>
            <p>{buildCsvImportConfirmationMessage(csvImportState.toAdd.length, csvImportState.duplicateCount)}</p>
            <div className="import-export-panel__modal-actions">
              <button type="button" onClick={cancelCsvImport}>
                {CANCEL_LABEL}
              </button>
              <button type="button" onClick={confirmCsvImport}>
                {CSV_ADD_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}

      {kdbxImportState.kind === "confirming" && (
        <div className="import-export-panel__modal-overlay" role="presentation">
          <div
            ref={kdbxImportConfirmRef}
            className="import-export-panel__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={kdbxImportConfirmTitleId}
          >
            <h2 id={kdbxImportConfirmTitleId}>Добавить записи</h2>
            <p>
              {buildCsvImportConfirmationMessage(
                kdbxImportState.toAdd.length,
                kdbxImportState.duplicateCount,
              )}
            </p>
            <div className="import-export-panel__modal-actions">
              <button type="button" onClick={cancelKdbxImportConfirm}>
                {CANCEL_LABEL}
              </button>
              <button type="button" onClick={confirmKdbxImport}>
                {CSV_ADD_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}

      {kdbxImportPasswordVisible && (
        <div className="import-export-panel__modal-overlay" role="presentation">
          <div
            ref={kdbxImportPasswordRef}
            className="import-export-panel__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={kdbxImportTitleId}
          >
            <h2 id={kdbxImportTitleId}>Пароль файла KDBX</h2>
            <p>
              Введите пароль файла, который собираетесь открыть - тот, которым он защищён в
              KeePass-совместимом приложении. Записи будут ДОБАВЛЕНЫ к существующим, база не
              заменяется.
            </p>
            <form onSubmit={(e) => void confirmKdbxImportPassword(e)}>
              <label className="import-export-panel__label" htmlFor={kdbxImportFieldId}>
                Пароль
              </label>
              <PasswordField
                id={kdbxImportFieldId}
                inputClassName="import-export-panel__input"
                value={kdbxImportPassword}
                onChange={(v) => {
                  setKdbxImportPassword(v);
                  setKdbxImportError(null);
                }}
                autoFocus
              />
              {kdbxImportError && (
                <p className="import-export-panel__error" role="alert">
                  {kdbxImportError}
                </p>
              )}
              <div className="import-export-panel__modal-actions">
                <button type="button" onClick={cancelKdbxImport}>
                  {CANCEL_LABEL}
                </button>
                <button type="submit" disabled={kdbxImportPassword.length === 0 || busy === "kdbxImport"}>
                  {busy === "kdbxImport" ? "Читаем файл..." : "Выбрать файл"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {kdbxPasswordVisible && (
        <div className="import-export-panel__modal-overlay" role="presentation">
          <div
            ref={kdbxPasswordRef}
            className="import-export-panel__modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby={kdbxTitleId}
          >
            <h2 id={kdbxTitleId}>Пароль для файла KDBX</h2>
            <p>
              Придумайте пароль для экспортированного файла - отдельный от мастер-пароля cryptodermo. Он понадобится
              при открытии файла в KeePass-совместимом приложении (KeePassXC, Strongbox, KeePassium и т.д.).
            </p>
            <form onSubmit={(e) => void confirmKdbxExport(e)}>
              <label className="import-export-panel__label" htmlFor={kdbxPasswordFieldId}>
                Пароль
              </label>
              <PasswordField
                id={kdbxPasswordFieldId}
                inputClassName="import-export-panel__input"
                value={kdbxPassword}
                onChange={(v) => {
                  setKdbxPassword(v);
                  setKdbxPasswordError(null);
                }}
                autoFocus
              />
              <label className="import-export-panel__label" htmlFor={kdbxConfirmFieldId}>
                Повторите пароль
              </label>
              <PasswordField
                id={kdbxConfirmFieldId}
                inputClassName="import-export-panel__input"
                value={kdbxConfirmPassword}
                onChange={(v) => {
                  setKdbxConfirmPassword(v);
                  setKdbxPasswordError(null);
                }}
              />
              {kdbxPasswordError && (
                <p className="import-export-panel__error" role="alert">
                  {kdbxPasswordError}
                </p>
              )}
              <div className="import-export-panel__modal-actions">
                <button type="button" onClick={cancelKdbxExport}>
                  {CANCEL_LABEL}
                </button>
                <button type="submit" disabled={kdbxPassword.length === 0 || kdbxConfirmPassword.length === 0}>
                  {KDBX_EXPORT_CONFIRM_LABEL}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </section>
  );
}
