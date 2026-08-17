import { useId, useState, type KeyboardEvent } from "react";
import { open, save } from "@tauri-apps/plugin-dialog";
import type { Item, VaultStore } from "../lib/vaultStore";
import { readVault, writeVaultAtomic } from "../lib/tauriApi";
import {
  buildExportFilename,
  buildManualCopyFilename,
  buildReplaceConfirmationMessage,
  parseImportFile,
  serializeExport,
} from "../lib/importExport";
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
 * Три независимых действия:
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
const CANCEL_LABEL = "Отмена";
const IMPORT_DONE_LABEL = "Записи заменены";
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

type ImportState = { kind: "idle" } | { kind: "confirming"; items: Item[]; currentCount: number };

export function ImportExportPanel({
  store,
  now = () => new Date(),
  onSaveCopySuccess,
  onExportSuccess,
  onImportSuccess,
  onError,
}: ImportExportPanelProps) {
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState<"copy" | "export" | "import" | null>(null);
  const [importState, setImportState] = useState<ImportState>({ kind: "idle" });
  const [exportConfirmVisible, setExportConfirmVisible] = useState(false);
  const confirmTitleId = useId();
  const exportConfirmTitleId = useId();

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
        filters: [{ name: "Vault", extensions: ["dat"] }],
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

  /** R89: Esc закрывает открытое - здесь это либо модалка предупреждения
   * перед экспортом, либо модалка подтверждения замены записей при импорте
   * (Esc = "Отмена", тот же путь, что и кнопка каждой из них; открыться
   * одновременно они не могут - разные пользовательские действия их
   * показывают). Останавливает всплытие, чтобы то же нажатие не закрыло
   * следом ещё и весь экран позади (тикет 12 монтирует эту панель как раздел
   * приложения со своим Esc "назад к списку" - закрывается только самое
   * верхнее открытое). Вне модалок ничего не делает - тикету 12 есть куда
   * отдать это нажатие самому. */
  function handlePanelKeyDown(e: KeyboardEvent<HTMLElement>) {
    if (e.key !== "Escape") return;
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
    </section>
  );
}
