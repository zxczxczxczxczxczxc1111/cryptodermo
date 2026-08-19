import { useRef, useState, type RefObject } from "react";
import { ItemCountDecreasedError, type Item, type VaultStore } from "../lib/vaultStore";
import type { CountDecreaseWarning } from "../screens/Editor";
import { useModalFocus } from "./useModalFocus";

/**
 * Логика импорта с откатом (тикет 13 сегодняшней очереди - вынесена из
 * `App.tsx`, 1004 строки на момент выноса, без переписывания самой логики).
 *
 * Что вернуть в `store` при "Отмена" на модалке R28-после-импорта - снимок
 * коллекции ДО импорта, если он есть. Найдено ревью (см. история в
 * `App.tsx` до выноса): `ImportExportPanel.confirmImport()` уже вызывает
 * `store.replaceAllItems()` СИНХРОННО, до того как R28 вообще стало
 * известно - без явного отката "Отмена" только прятала модалку, а store
 * оставался с урезанной коллекцией в памяти. Пустой массив - защитный
 * фолбэк на случай отсутствующего снимка (не должен случаться на практике -
 * снимок выставляется раньше, чем вообще появляется возможность показать
 * модалку).
 */
export function importCancelTarget(preImportSnapshot: Item[] | null): Item[] {
  return preImportSnapshot ?? [];
}

const IMPORT_SAVE_FAILED_MESSAGE =
  "Записи заменены, но сохранить базу на диск не удалось. Проверьте, что каталог доступен для записи, и попробуйте снова";
const CSV_IMPORT_SAVE_FAILED_MESSAGE =
  "Записи добавлены, но сохранить базу на диск не удалось. Проверьте, что каталог доступен для записи, и попробуйте снова";

export type UseImportRollbackParams = {
  store: VaultStore | null;
  vaultPath: string | null;
  /** Текущая коллекция записей ДО импорта - тот же `allItems`, что уже
   * держит `App.tsx` (`store.search("")`, замемоизировано на
   * `[store, dataVersion]`). Читается в момент `handleImportSuccess`, когда
   * `store.replaceAllItems()` внутри `ImportExportPanel` уже применил
   * замену В ПАМЯТИ, но этот компонент ещё не перерисовался - значение в
   * замыкании этого вызова ещё старое, ДО импорта, ровно то, к чему нужно
   * вернуться при отмене. */
  allItems: Item[];
  /** `App.tsx.bumpDataVersion` - зовётся и сразу после импорта (обновить
   * отображение независимо от исхода сохранения), и после отката/успешного
   * сохранения. */
  bumpDataVersion: () => void;
};

export type UseImportRollbackResult = {
  importCountWarning: CountDecreaseWarning | null;
  importCountWarningRef: RefObject<HTMLDivElement | null>;
  importSaveError: string | null;
  /** `ImportExportPanel.onImportSuccess` - обычный импорт (замена базы). */
  handleImportSuccess: () => void;
  /** `ImportExportPanel.onCsvImportSuccess` - CSV-импорт (только
   * добавление, без машинерии R28). */
  handleCsvImportSuccess: () => Promise<void>;
  /** "Всё равно сохранить" на модалке R28. */
  persistAfterImport: (opts?: { allowCountDecrease?: boolean }) => Promise<void>;
  /** "Отмена" на модалке R28 / Esc - откатывает `store` к снимку до импорта. */
  rollbackPendingImport: () => void;
  /** Сброс переходного состояния - обязателен на блокировке и разблокировке
   * (см. комментарий у вызова в `App.tsx`: иначе состояние одной сессии
   * всплыло бы в следующей). */
  resetPendingImportState: () => void;
};

export function useImportRollback({
  store,
  vaultPath,
  allItems,
  bumpDataVersion,
}: UseImportRollbackParams): UseImportRollbackResult {
  const [importCountWarning, setImportCountWarning] = useState<CountDecreaseWarning | null>(null);
  const importCountWarningRef = useRef<HTMLDivElement>(null);
  useModalFocus(importCountWarningRef, Boolean(importCountWarning));
  const [importSaveError, setImportSaveError] = useState<string | null>(null);

  /** Снимок коллекции ПЕРЕД последним импортом - для отката. `null`, если
   * сейчас нет незавершённого импорта, ждущего решения. */
  const preImportSnapshotRef = useRef<Item[] | null>(null);

  async function persistAfterImport(opts?: { allowCountDecrease?: boolean }) {
    if (!store || !vaultPath) return;
    try {
      await store.save(vaultPath, opts);
      preImportSnapshotRef.current = null; // сохранено (или подтверждено) - откатывать больше нечего
      setImportCountWarning(null);
      setImportSaveError(null);
      bumpDataVersion(); // на этот раз - чтобы обновить lastBackupAt новым бэкапом
    } catch (err) {
      if (err instanceof ItemCountDecreasedError) {
        setImportCountWarning({ loaded: err.loaded, current: err.current });
      } else {
        console.error("App: не удалось сохранить базу после импорта", err);
        setImportSaveError(IMPORT_SAVE_FAILED_MESSAGE);
      }
    }
  }

  function handleImportSuccess() {
    preImportSnapshotRef.current = allItems;
    bumpDataVersion();
    void persistAfterImport();
  }

  async function handleCsvImportSuccess() {
    bumpDataVersion();
    if (!store || !vaultPath) return;
    try {
      await store.save(vaultPath);
      setImportSaveError(null);
    } catch (err) {
      console.error("App: не удалось сохранить базу после CSV-импорта", err);
      setImportSaveError(CSV_IMPORT_SAVE_FAILED_MESSAGE);
    }
  }

  function rollbackPendingImport() {
    if (store && importCountWarning) {
      store.replaceAllItems(importCancelTarget(preImportSnapshotRef.current));
      bumpDataVersion();
    }
    preImportSnapshotRef.current = null;
    setImportCountWarning(null);
  }

  function resetPendingImportState() {
    setImportCountWarning(null);
    setImportSaveError(null);
    preImportSnapshotRef.current = null;
  }

  return {
    importCountWarning,
    importCountWarningRef,
    importSaveError,
    handleImportSuccess,
    handleCsvImportSuccess,
    persistAfterImport,
    rollbackPendingImport,
    resetPendingImportState,
  };
}
