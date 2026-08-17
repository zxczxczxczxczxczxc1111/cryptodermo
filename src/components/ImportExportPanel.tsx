import { useId, useState } from "react";
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
  const confirmTitleId = useId();

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

  async function handleExport() {
    setErrorMessage(null);
    setStatusMessage(null);
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
    <section className="import-export-panel" aria-label="Резервная копия и обмен данными">
      <div className="import-export-panel__actions">
        <button type="button" onClick={() => void handleSaveCopy()} disabled={busy !== null}>
          {SAVE_COPY_LABEL}
        </button>
        <button type="button" onClick={() => void handleExport()} disabled={busy !== null}>
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
