import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { exeDir } from "./lib/tauriApi";
import { readSettings, DEFAULT_AUTO_LOCK_TIMEOUT_MS } from "./lib/settingsConfig";
import { VaultStore, ItemCountDecreasedError, type Item } from "./lib/vaultStore";
import { useAutoLock } from "./hooks/useAutoLock";
import { AppShell, type SidebarSection } from "./components/AppShell";
import { TYPE_LABELS } from "./components/RecordCard";
import type { RecentListItem } from "./components/RecentList";
import { ImportExportPanel } from "./components/ImportExportPanel";
import { LockScreen } from "./screens/LockScreen";
import { List } from "./screens/List";
import { Editor, type EditorHandle, formatCountDecreaseMessage, type CountDecreaseWarning } from "./screens/Editor";
import { Settings } from "./screens/Settings";
import "./tokens.css";
import "./App.css";

/**
 * Сведение экранов (тикет 12, D02/manifest.md/Д4 в spec.md §"Границы и швы").
 * Это первая точка плана, где все экраны тасков 06-11 уже существуют вместе
 * - до этого файл был временным отладочным экраном тикета 01 (каркас +
 * файловый слой), полностью заменён.
 *
 * Порядок сборки: пока заблокировано - только `LockScreen` (гейт), ничего
 * другого не видно. После `onUnlock(store, vaultPath)` - `AppShell` с
 * реальными детьми (`List`/`Editor`/`Settings`/`ImportExportPanel`),
 * переключение между ними через `activeSidebarItemId`/`onSidebarItemSelect`
 * (уже выставлены `AppShell`, тикет 03). `useAutoLock` (тикет 06) оборачивает
 * всё разблокированное дерево целиком - см. `AutoLockController` ниже.
 *
 * Каждый экран уже определяет свой контракт в своём разделе interfaces.md -
 * этот файл только подключает готовые пропсы/колбэки, не меняет чужую
 * внутреннюю логику (кроме `List.tsx`, который явно в зоне тикета 12 -
 * туда доставлены `vaultPath`/`onCreateNew`/`onStoreChanged`).
 */

/**
 * Экран, показанный внутри `AppShell` после разблокировки.
 * `editor.itemId === null` - редактирование НОВОЙ записи (Editor сам строит
 * пустую форму без пропа `item`); иначе - id существующей записи, которую
 * нужно найти в живом сторе (см. `editorItem` в `App` ниже - у `VaultStore`
 * нет метода "получить запись по id", тот же приём, что уже использует
 * `List.tsx` для своей карточки).
 */
export type Screen =
  | { kind: "list" }
  | { kind: "editor"; itemId: string | null }
  | { kind: "settings" }
  | { kind: "importExport" };

const SIDEBAR_LIST_ID = "list";
const SIDEBAR_SETTINGS_ID = "settings";
const SIDEBAR_IMPORT_EXPORT_ID = "importExport";

/**
 * id пункта сайдбара -> экран (`AppShell.onSidebarItemSelect`). Неизвестный
 * id (защитный случай - сайдбар в этом файле сам генерирует id только из
 * `sidebarSections` в `App` ниже, но контракт `AppShell` этого не
 * гарантирует) безопасно возвращает список, а не бросает исключение.
 */
export function screenForSidebarId(id: string): Screen {
  if (id === SIDEBAR_SETTINGS_ID) return { kind: "settings" };
  if (id === SIDEBAR_IMPORT_EXPORT_ID) return { kind: "importExport" };
  return { kind: "list" };
}

/**
 * Экран -> id пункта сайдбара, который должен подсветиться активным
 * (`AppShell.activeSidebarItemId`). Редактор открывается только из списка
 * (кнопка "Редактировать" в карточке или "Добавить запись" - обе внутри
 * `List`), отдельного пункта сайдбара под него нет - пока он открыт,
 * подсвечен пункт "Записи".
 */
export function sidebarIdForScreen(screen: Screen): string {
  if (screen.kind === "editor") return SIDEBAR_LIST_ID;
  return screen.kind;
}

/**
 * vaultPath для самого первого рендера `LockScreen` (D03, interfaces.md,
 * тикет 12, раздел "Сведение экранов"): если в `vault.settings.json` уже
 * есть `lastVaultPath` - используется он; если нет (самый первый запуск в
 * жизни приложения) - каталог исполняемого файла. Чистая функция без
 * async-обвязки, вынесена ради теста (см. App.test.ts) - вся логика решения
 * "какой путь использовать" здесь, чтение файлов и `exeDir()` - в
 * `determineInitialVaultPath` ниже, которая ею пользуется.
 */
export function resolveInitialVaultPath(lastVaultPath: string | null, defaultVaultPath: string): string {
  return lastVaultPath && lastVaultPath.trim() !== "" ? lastVaultPath : defaultVaultPath;
}

/** Склеить каталог и имя файла тем же разделителем, что уже используется в
 * каталоге - та же маленькая копия, что уже есть в `vaultStore.ts`/
 * `settingsConfig.ts`/`useAutoLock.ts` (между модулями дублируется
 * умышленно - "у каждого модуля своя маленькая копия", решено в тикете 02). */
function joinPath(dir: string, filename: string): string {
  if (dir === "" || dir === ".") return filename;
  const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${filename}` : `${dir}${sep}${filename}`;
}

/**
 * Асинхронная обвязка вокруг `resolveInitialVaultPath`: узнать каталог exe
 * (нужен только на случай самого первого запуска - `exeDir()`, новая пятая
 * Rust-команда, D03) и прочитать `vault.settings.json` ИЗ ЭТОГО каталога -
 * единственное разумное место искать его до того, как настоящий `vaultPath`
 * вообще известен (если пользователь раньше открывал базу в другом месте,
 * `lastVaultPath` внутри этого файла укажет туда). `readSettings` никогда не
 * бросает исключение (settingsConfig.ts, тикет 09) - отсутствие файла или
 * битый JSON молча дают дефолты, что и есть корректное поведение для "самого
 * первого запуска".
 */
async function determineInitialVaultPath(): Promise<string> {
  const dir = await exeDir();
  const defaultVaultPath = joinPath(dir, "vault.dat");
  const settings = await readSettings(defaultVaultPath);
  return resolveInitialVaultPath(settings.lastVaultPath, defaultVaultPath);
}

const BOOTSTRAP_LOADING_LABEL = "Загрузка...";
const BOOTSTRAP_ERROR_MESSAGE = "Не удалось определить расположение базы. Перезапустите приложение.";

/**
 * `ImportExportPanel.confirmImport()` (тикет 10) вызывает
 * `store.replaceAllItems(items)`, который только меняет память
 * (`isDirty()` становится true) - запись на диск дословно "остаётся
 * заботой вызывающего кода вне этой панели" (комментарий `replaceAllItems`
 * в vaultStore.ts). Этот код и есть тот вызывающий код: без явного
 * `store.save(vaultPath)` здесь импортированные записи повисли бы только в
 * памяти до случайного следующего сохранения где-то ещё (например, до
 * следующей автоблокировки) - недопустимо для приоритета 1 ("данные не
 * теряются"). Импорт файла с МЕНЬШИМ числом записей, чем было, - ровно тот
 * случай, для которого существует R28 (`ItemCountDecreasedError`) - тот же
 * текст и тот же выбор "Отмена"/"Всё равно сохранить", что и в Editor.tsx
 * (`formatCountDecreaseMessage` импортирована оттуда, а не переписана
 * заново, чтобы формулировка не могла разойтись).
 */
const IMPORT_SAVE_FAILED_MESSAGE =
  "Записи заменены, но сохранить базу на диск не удалось. Проверьте, что каталог доступен для записи, и попробуйте снова";

/**
 * Что вернуть в `store` при "Отмена" на модалке R28-после-импорта - снимок
 * коллекции ДО импорта, если он есть (см. `handleImportSuccess`/
 * `preImportSnapshotRef` в `App`). Найдено ревью: `ImportExportPanel.
 * confirmImport()` уже вызвал `store.replaceAllItems()` СИНХРОННО, до того
 * как R28 вообще стало известно - без явного отката "Отмена" только прятала
 * модалку, а store оставался с урезанной коллекцией в памяти (`isDirty()`
 * true, `loadedCount` не откачен): следующая автоблокировка молча
 * досохранила бы ровно то, от чего пользователь отказался
 * (`performAutoLock` перехватывает ту же `ItemCountDecreasedError` и сам
 * повторяет `save()` с `allowCountDecrease: true`), а следующее обычное
 * сохранение где угодно ещё (например, в Editor) упёрлось бы в ту же R28-
 * проверку с чужими, непонятными пользователю цифрами.
 *
 * Пустой массив - защитный фолбэк на случай отсутствующего снимка (не
 * должен случаться на практике: снимок выставляется раньше, чем вообще
 * появляется возможность показать эту модалку, см. `handleImportSuccess`) -
 * лучше пустая база, чем `store.replaceAllItems(null as any)`.
 */
export function importCancelTarget(preImportSnapshot: Item[] | null): Item[] {
  return preImportSnapshot ?? [];
}

/**
 * Версия формата контейнера для нижней полосы (R66, StatusBar.formatVersion).
 * `vaultFormat.ts` проверяет версию при разборе (`parseContainer` бросает
 * `FormatError` на любой версии, кроме текущей) и не выставляет наружу
 * публичный геттер актуальной версии загруженного стора - у любой базы,
 * которая реально загружена в этом билде, версия гарантированно "v1" (иначе
 * `loadFromBytes` отказала бы раньше, чем store вообще появился бы здесь).
 * Захардкожено с этим обоснованием, а не угадано - см. CONCERNS в отчёте по
 * тикету: по-хорошему это должен отдавать сам `VaultStore` через публичный
 * геттер, такого геттера сейчас нет, а `vaultStore.ts`/`vaultFormat.ts` вне
 * зоны этого тикета (`src/lib/*`).
 */
const FORMAT_VERSION_LABEL = "v1";

/** Сколько последних изменённых записей показывать в колонке "Недавние".
 * `RecentList.tsx` не виртуализирован (в отличие от `List.tsx`) - без
 * ограничения база на 5000+ записей отрендерила бы туда тысячи скрытых
 * градиентной маской, но всё равно смонтированных DOM-узлов (R96.1
 * заботится об этом для основного списка, здесь тот же принцип craft-решением
 * этого тикета). */
const RECENT_ITEMS_LIMIT = 20;

/** Относительное время изменения записи для колонки "Недавние" - тот же
 * формат вывода, что и в `List.tsx` (не экспортирован оттуда, своя маленькая
 * копия по тому же принципу, что и `joinPath` выше). Экспортирована и
 * протестирована (App.test.ts, по кейсу на ветку) - тот же приём, что уже
 * применён в этом файле к `resolveInitialVaultPath`/`screenForSidebarId`/
 * `sidebarIdForScreen`. */
export function formatRelativeTime(iso: string, now: number): string {
  const diffMs = now - new Date(iso).getTime();
  if (diffMs < 60_000) return "только что";
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} дн назад`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months} мес назад`;
  const years = Math.floor(months / 12);
  return `${years} г назад`;
}

function itemToRecentListItem(item: Item, now: number): RecentListItem {
  return {
    id: item.id,
    title: item.title || "(без названия)",
    typeLabel: TYPE_LABELS[item.type],
    relativeTime: formatRelativeTime(item.updatedAt, now),
    // hasUnsavedChanges сознательно не выставляется: у VaultStore есть только
    // общий isDirty() (весь стор), не флаг на конкретную запись - показать
    // точку было бы гадать, а не знать (CLAUDE.md §1 "не изобретай").
  };
}

/**
 * Невидимый контроллер автоблокировки - обособлен от видимого дерева, чтобы
 * его `key` (см. `App` ниже) мог форсировать полный ремонт ТОЛЬКО этого
 * контроллера, не затрагивая `AppShell`/`List`/`Editor` и их внутреннее
 * состояние (открытый поиск, черновик формы и т.п.).
 *
 * Почему ремонт через `key`, а не проп: `useAutoLock` (тикет 06,
 * `src/hooks/useAutoLock.ts`) читает `autoLockTimeoutMs` из
 * `vault.settings.json` ОДИН РАЗ при монтировании (эффект на
 * `[store, vaultPath]`) и не принимает параметр для живого обновления - его
 * контракт (`UseAutoLockParams`) не содержит `timeoutMs`, и `useAutoLock.ts`
 * вне зоны этого тикета (`src/hooks/*`), расширять чужой файл в обход зоны
 * нельзя (см. тикет, раздел "Сведение экранов"). Критерий приёмки тикета 09
 * "таймаут меняется без перезапуска" тем не менее должен выполняться по-
 * настоящему: `App` держит `timeoutMs` в состоянии (обновляется через
 * `Settings.onAutoLockTimeoutChange`, который вызывается СРАЗУ ПОСЛЕ того,
 * как новое значение уже записано на диск) и передаёт его сюда как `key` -
 * смена `key` размонтирует и заново монтирует этот контроллер, `useAutoLock`
 * внутри стартует с нуля и его собственный эффект читает уже свежее значение
 * с диска. Отсчёт до автоблокировки при этом просто начинается заново от
 * момента смены таймаута - это корректно (не баг): пользователь только что
 * был активен в настройках, значит и отсчёт бездействия разумно вести от
 * этого момента, а не от произвольной более ранней точки.
 */
function AutoLockController({
  store,
  vaultPath,
  onLock,
  onRemainingMsChange,
}: {
  store: VaultStore | null;
  vaultPath: string | null;
  onLock: () => void;
  onRemainingMsChange: (remainingMs: number) => void;
}) {
  const { remainingMs } = useAutoLock({ store, vaultPath, onLock });

  useEffect(() => {
    onRemainingMsChange(remainingMs);
  }, [remainingMs, onRemainingMsChange]);

  return null;
}

function App() {
  const [vaultPath, setVaultPath] = useState<string | null>(null);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const [store, setStore] = useState<VaultStore | null>(null);
  const [screen, setScreen] = useState<Screen>({ kind: "list" });
  const [dataVersion, setDataVersion] = useState(0);
  const [timeoutMs, setTimeoutMs] = useState(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  const [remainingMs, setRemainingMs] = useState(DEFAULT_AUTO_LOCK_TIMEOUT_MS);
  const [lastBackupAt, setLastBackupAt] = useState<Date | null>(null);
  const [importCountWarning, setImportCountWarning] = useState<CountDecreaseWarning | null>(null);
  const [importSaveError, setImportSaveError] = useState<string | null>(null);

  const editorRef = useRef<EditorHandle>(null);
  /** Куда перейти ПОСЛЕ того, как открытый редактор согласится закрыться
   * (см. `navigateTo`/`handleEditorClose` ниже) - `null`, если закрытие
   * запросил сам редактор (кнопка "×"/Esc), тогда по умолчанию возвращаемся
   * к списку. */
  const pendingNavigationRef = useRef<Screen | null>(null);
  /** Снимок коллекции ПЕРЕД последним импортом - для отката, если
   * пользователь откажется от модалки R28-после-импорта (см.
   * `handleImportSuccess`/`rollbackPendingImport`/`importCancelTarget`
   * выше). `null`, если сейчас нет незавершённого импорта, ждущего решения. */
  const preImportSnapshotRef = useRef<Item[] | null>(null);
  /** Последнее значение `screen` в ref - тот же приём, что уже применяет
   * `useAutoLock.ts` (`latestRef`) для той же задачи: подписка на закрытие
   * окна (см. эффект ниже) регистрируется один раз при монтировании, но её
   * обработчик обязан видеть АКТУАЛЬНЫЙ экран на момент реального закрытия,
   * а не тот, что был на момент подписки - обновляется на каждом рендере
   * прямо в теле компонента, не в эффекте. */
  const screenRef = useRef(screen);
  screenRef.current = screen;

  // D03: определить vaultPath для самого первого рендера LockScreen - один
  // раз при монтировании всего приложения (до этого момента показывается
  // BOOTSTRAP_LOADING_LABEL, см. ранний return ниже).
  useEffect(() => {
    let cancelled = false;
    determineInitialVaultPath()
      .then((path) => {
        if (!cancelled) setVaultPath(path);
      })
      .catch((err) => {
        console.error("App: не удалось определить начальный путь к базе", err);
        if (!cancelled) setBootstrapError(BOOTSTRAP_ERROR_MESSAGE);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Время последнего бэкапа для нижней полосы (R66) - пересчитывается на
  // каждую новую сессию (store - новый объект после каждого onUnlock) и на
  // каждое известное этому файлу изменение стора (dataVersion, см.
  // bumpDataVersion ниже). VaultStore.listBackupsForRecovery - тот же
  // публичный метод, которым уже пользуется LockScreen.tsx для восстановления.
  useEffect(() => {
    if (!store || !vaultPath) {
      setLastBackupAt(null);
      return;
    }
    let cancelled = false;
    VaultStore.listBackupsForRecovery(vaultPath)
      .then((backups) => {
        if (cancelled) return;
        setLastBackupAt(backups.length > 0 ? new Date(backups[0].modifiedAtMs) : null);
      })
      .catch((err) => {
        console.error("App: не удалось получить список бэкапов для нижней полосы", err);
        if (!cancelled) setLastBackupAt(null);
      });
    return () => {
      cancelled = true;
    };
  }, [store, vaultPath, dataVersion]);

  /**
   * R115i (история 9, spec.md §9) - предупреждение о несохранённых
   * изменениях не только при закрытии карточки/редактора (это уже закрыл
   * тикет 08 через `EditorHandle.requestClose`), но и при закрытии ВСЕГО
   * ОКНА приложения (крестик, Alt+F4) - манифест отмечает эту часть R115i
   * как владение этого тикета. Подписка на уровне всего приложения (не
   * внутри самого экрана редактора) - окно может закрыться с любого
   * состояния, не только пока открыт редактор.
   *
   * `getCurrentWindow().onCloseRequested()` - тот же `@tauri-apps/api/window`,
   * что уже использует `useAutoLock.ts` для `onResized`/`isMinimized`
   * (interfaces.md, "Из таска 06"), не новая зависимость. Сигнатура и
   * поведение проверены по документации Tauri v2 через Context7
   * (`/websites/v2_tauri_app`, тот же источник, что уже использовала
   * спецификация) - официальный пример делает ровно то же самое: дождаться
   * решения пользователя внутри async-обработчика и вызвать
   * `event.preventDefault()` ТОЛЬКО если закрытие нужно отменить. Если
   * `preventDefault()` не вызван - Tauri закрывает окно сам после того, как
   * обработчик отработал; вызывать `close()` вручную не нужно (это ПРОЩЕ,
   * чем "всегда preventDefault + закрыть вручную потом").
   *
   * Разрешения: `src-tauri/capabilities/default.json` уже содержит
   * `core:default`, который по документации Tauri v2 включает
   * `core:window:default`/`core:event:default` - тот же набор, под которым
   * уже работает `onResized` в useAutoLock.ts без отдельных правок
   * capabilities. `onCloseRequested` - тоже подписка на событие, не команда
   * (в отличие от `core:window:allow-close`, который нужен только чтобы
   * самому ВЫЗВАТЬ закрытие из JS - а этот код специально устроен так,
   * чтобы не звать `close()` самому, см. выше) - менять `src-tauri/` не
   * потребовалось (вне зоны этого тикета).
   *
   * `screenRef` (не `screen` напрямую) - обработчик регистрируется один раз
   * (пустой массив зависимостей), поэтому обязан читать актуальное значение
   * через ref (см. её комментарий выше), а не захватывать `screen` из
   * замыкания на момент подписки.
   */
  useEffect(() => {
    let disposed = false;
    let unlistenClose: (() => void) | undefined;
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        const currentScreen = screenRef.current;
        if (currentScreen.kind === "editor" && editorRef.current) {
          const ok = await editorRef.current.requestClose();
          if (!ok) {
            event.preventDefault(); // пользователь отменил закрытие - окно остаётся открытым
          }
        }
        // ok === true, или редактор не открыт: preventDefault не вызван -
        // Tauri закрывает окно сам после этого обработчика.
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else unlistenClose = unlisten;
      })
      .catch((err) => {
        // Вне реального Tauri-рантайма (например, обычный `npm run dev` без
        // `tauri dev`) window-API недоступен - тот же приём, что уже
        // применяет useAutoLock.ts для onResized: тихо игнорируем, не
        // ронять остальное приложение.
        console.error("App: не удалось подписаться на закрытие окна", err);
      });
    return () => {
      disposed = true;
      unlistenClose?.();
    };
  }, []);

  // Единственное место, где считается store.search("") для этого файла -
  // источник и для счётчика записей StatusBar, и для колонки "Недавние", и
  // для поиска записи по id при открытии редактора (см. editorItem ниже).
  // Пересчитывается только когда store сменился (новая сессия) или dataVersion
  // выросла (известное этому файлу изменение) - НЕ на каждый тик
  // remainingMs, иначе полное сканирование+structuredClone гонялось бы раз в
  // секунду даже на большой базе (R96.1 заботится об этом для List.tsx,
  // здесь тот же принцип).
  const allItems = useMemo(() => (store ? store.search("") : []), [store, dataVersion]);

  const recentItems = useMemo(() => {
    const now = Date.now();
    return allItems.slice(0, RECENT_ITEMS_LIMIT).map((item) => itemToRecentListItem(item, now));
  }, [allItems]);

  /** Что-то изменило store в обход обычного пути "открыть экран - увидеть
   * актуальные данные" (сейчас единственный источник - List.onStoreChanged,
   * см. её комментарий: удаление вложения из карточки не уводит пользователя
   * с экрана списка, поэтому store.search("") этого файла сам по себе не
   * перечитался бы). */
  function bumpDataVersion() {
    setDataVersion((v) => v + 1);
  }

  /**
   * Записать на диск после `ImportExportPanel.onImportSuccess` (см.
   * `IMPORT_SAVE_FAILED_MESSAGE` выше) - `store.replaceAllItems()` уже
   * применил замену в памяти, здесь только `save()`. `allowCountDecrease`
   * передаётся, только когда пользователь явно подтвердил модалку R28 ниже.
   */
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

  /**
   * `ImportExportPanel.onImportSuccess` - `store.replaceAllItems()` уже
   * заменил коллекцию В ПАМЯТИ синхронно, до этого колбэка. `allItems` в
   * замыкании ЭТОГО рендера - ещё старый (React не перерисовал компонент
   * между синхронным `replaceAllItems()` внутри `ImportExportPanel` и этим
   * вызовом) массив, ДО импорта - ровно то, к чему нужно вернуться, если
   * пользователь откажется от модалки R28 ниже (см. `rollbackPendingImport`).
   *
   * `dataVersion` поднимается СРАЗУ (не только после успешного
   * `persistAfterImport`), иначе, пока модалка R28 не решена, счётчик
   * записей в сайдбаре/StatusBar и колонка "Недавние" молча остались бы
   * показывать данные ДО импорта - обновление отображения не должно
   * зависеть от того, удастся ли сохранение на диск.
   */
  function handleImportSuccess() {
    preImportSnapshotRef.current = allItems;
    bumpDataVersion();
    void persistAfterImport();
  }

  /**
   * "Отмена" на модалке R28-после-импорта (кнопка, Esc или уход с экрана
   * без явного решения - см. `handleImportExportPanelKeyDown`/`navigateTo`
   * ниже) - откатывает `store` к снимку ДО импорта, а не просто прячет
   * диалог (найдено ревью, см. `importCancelTarget` выше). Безопасно звать
   * при любом состоянии `importCountWarning` (в т.ч. `null`, например при
   * уходе с экрана без открытой модалки) - тогда просто ничего не делает,
   * не пытается "откатить" то, чего не было.
   */
  function rollbackPendingImport() {
    if (store && importCountWarning) {
      store.replaceAllItems(importCancelTarget(preImportSnapshotRef.current));
      bumpDataVersion();
    }
    preImportSnapshotRef.current = null;
    setImportCountWarning(null);
  }

  /**
   * Сброс переходного состояния экрана "Импорт и экспорт" - обязателен и на
   * блокировке, и на разблокировке (см. `handleLock`/`handleUnlock` ниже).
   * Найдено ревью: если модалка R28-после-импорта осталась нерешённой на
   * момент автоблокировки, `performAutoLock` (useAutoLock.ts) сама ловит ту
   * же `ItemCountDecreasedError` и молча пересохраняет с
   * `allowCountDecrease: true` - её собственная, отдельная от этой модалки
   * защита (решение тикета 06: "диалог показать некому"). Импорт при этом
   * реально фиксируется на диске мимо этой модалки, но без сброса здесь
   * `importCountWarning`/`preImportSnapshotRef` пережили бы блокировку и
   * всплыли в СЛЕДУЮЩЕЙ сессии (новый `store` после `onUnlock`) с цифрами и
   * снимком от ПРЕДЫДУЩЕЙ сессии - клик "Отмена" откатил бы только что
   * открытый, никак не связанный с ними стор к чужим данным.
   */
  function resetPendingImportState() {
    setImportCountWarning(null);
    setImportSaveError(null);
    preImportSnapshotRef.current = null;
  }

  function handleUnlock(newStore: VaultStore, unlockedVaultPath: string) {
    resetPendingImportState();
    setStore(newStore);
    setVaultPath(unlockedVaultPath);
    setScreen({ kind: "list" });
  }

  /** useAutoLock.onLock (R47/R47.1) - автосохранение и очистка буфера уже
   * сделаны внутри хука к этому моменту, здесь только "уронить" store
   * (ключ уходит вместе со сборкой мусора после последней ссылки на него,
   * см. комментарий useAutoLock.ts) и вернуться к экрану списка, чтобы
   * следующая разблокировка не показала прошлый открытый экран/редактор. */
  function handleLock() {
    resetPendingImportState();
    setStore(null);
    setScreen({ kind: "list" });
  }

  /**
   * R95.1 ("выбрать другое место" при конфликте создания базы) - нативный
   * диалог `@tauri-apps/plugin-dialog` (уже установлен тикетом 10, не новая
   * зависимость). `LockScreen.tsx` предусмотрел эту точку расширения именно
   * для этого случая (interfaces.md, "Из таска 06") и ничего в самом файле
   * менять не пришлось - `save()`, а не `open()`, потому что путь, скорее
   * всего, ещё не существует (пользователь выбирает, ГДЕ создать новую базу,
   * не открывает существующий файл).
   */
  async function handlePickAlternatePath(): Promise<string | null> {
    try {
      return await save({
        title: "Выбрать расположение базы",
        defaultPath: "vault.dat",
        filters: [{ name: "Vault", extensions: ["dat"] }],
      });
    } catch (err) {
      console.error("App: не удалось открыть системный диалог выбора пути", err);
      return null;
    }
  }

  /** Editor.onClose - вызывается самим редактором (кнопка "×", Esc, либо
   * после подтверждения диалога "Есть несохранённые изменения"). Если
   * закрытие было частью навигации в другой раздел (см. navigateTo), уходим
   * туда; иначе (пользователь просто закрыл редактор) - возвращаемся к
   * списку. */
  function handleEditorClose() {
    const next = pendingNavigationRef.current ?? { kind: "list" as const };
    pendingNavigationRef.current = null;
    setScreen(next);
  }

  /**
   * Единая точка переключения экрана (сайдбар, "Добавить запись", открыть
   * запись, закрыть настройки/импорт-экспорт). Если сейчас открыт редактор -
   * не переключаемся напрямую, а сперва спрашиваем его через `EditorHandle.
   * requestClose()` (тот же диалог "Есть несохранённые изменения", что и у
   * кнопки "×" внутри самого редактора, interfaces.md "Из таска 08") - и
   * только если он согласился закрыться (нет правок, либо пользователь
   * сохранил или подтвердил отмену), переходим дальше. Отказ (пользователь
   * нажал "Отмена" в диалоге) оставляет экран как есть - правки не теряются.
   */
  async function navigateTo(next: Screen): Promise<void> {
    if (screen.kind === "editor" && editorRef.current) {
      pendingNavigationRef.current = next;
      const ok = await editorRef.current.requestClose();
      if (!ok) {
        pendingNavigationRef.current = null; // пользователь остался в редакторе
      }
      // ok === true: requestClose() сам вызвал onClose -> handleEditorClose
      // уже применил pendingNavigationRef как новый экран.
      return;
    }
    if (screen.kind === "importExport" && next.kind !== "importExport") {
      // Уходя с экрана с открытой модалкой R28 - трактуем как отмену (тот
      // же откат, что и явная кнопка "Отмена", см. rollbackPendingImport):
      // импорт не должен остаться подвешенным в памяти без решения только
      // потому, что пользователь ушёл через сайдбар, а не через диалог.
      // Плюс забыть ошибку сохранения конкретной попытки - при следующем
      // визите не показывать устаревший текст от прошлого раза.
      rollbackPendingImport();
      setImportSaveError(null);
    }
    setScreen(next);
  }

  /** R89: Esc на экране "Импорт и экспорт" закрывает открытое - от самого
   * локального наружу. Если открыта модалка R28 этого файла (см.
   * `importCountWarning` выше) - Esc отменяет её тем же путём, что и кнопка
   * "Отмена" (`rollbackPendingImport` - реальный откат, не просто скрытие
   * диалога), не уходя со всего экрана. Если внутри самой панели открыта ЕЁ
   * модалка подтверждения замены записей - `ImportExportPanel.tsx`
   * обрабатывает Esc сама и останавливает всплытие, сюда оно не доходит.
   * Если ничего не открыто - Esc закрывает раздел и возвращает к списку,
   * тот же смысл, что и × в заголовке ниже. */
  function handleImportExportPanelKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key !== "Escape") return;
    if (importCountWarning) {
      rollbackPendingImport();
      return;
    }
    void navigateTo({ kind: "list" });
  }

  if (bootstrapError) {
    return (
      <div className="app-bootstrap app-bootstrap--error">
        <p role="alert">{bootstrapError}</p>
      </div>
    );
  }

  if (vaultPath === null) {
    return (
      <div className="app-bootstrap">
        <p role="status">{BOOTSTRAP_LOADING_LABEL}</p>
      </div>
    );
  }

  if (store === null) {
    return (
      <LockScreen vaultPath={vaultPath} onUnlock={handleUnlock} onPickAlternatePath={handlePickAlternatePath} />
    );
  }

  const sidebarSections: SidebarSection[] = [
    {
      heading: "Хранилище",
      items: [
        { id: SIDEBAR_LIST_ID, label: "Записи", count: allItems.length },
        { id: SIDEBAR_IMPORT_EXPORT_ID, label: "Импорт и экспорт" },
        { id: SIDEBAR_SETTINGS_ID, label: "Настройки" },
      ],
    },
  ];

  let editorItem: Item | undefined;
  if (screen.kind === "editor" && screen.itemId !== null) {
    editorItem = allItems.find((i) => i.id === screen.itemId);
  }

  return (
    <>
      <AutoLockController
        key={timeoutMs}
        store={store}
        vaultPath={vaultPath}
        onLock={handleLock}
        onRemainingMsChange={setRemainingMs}
      />
      <AppShell
        sidebarSections={sidebarSections}
        activeSidebarItemId={sidebarIdForScreen(screen)}
        onSidebarItemSelect={(id) => void navigateTo(screenForSidebarId(id))}
        recentListProps={{ items: recentItems }}
        statusBarProps={{
          itemsCount: allItems.length,
          lastBackupAt,
          autoLockRemainingMs: remainingMs,
          formatVersion: FORMAT_VERSION_LABEL,
        }}
      >
        {screen.kind === "list" && (
          <List
            store={store}
            vaultPath={vaultPath}
            onOpenItem={(id) => void navigateTo({ kind: "editor", itemId: id })}
            onCreateNew={() => void navigateTo({ kind: "editor", itemId: null })}
            onStoreChanged={bumpDataVersion}
          />
        )}

        {screen.kind === "editor" && (
          <Editor
            key={screen.itemId ?? "new"}
            ref={editorRef}
            store={store}
            vaultPath={vaultPath}
            item={editorItem}
            onSaved={bumpDataVersion}
            onClose={handleEditorClose}
          />
        )}

        {screen.kind === "settings" && (
          <Settings
            store={store}
            vaultPath={vaultPath}
            onPasswordChanged={(newStore, newVaultPath) => {
              setStore(newStore);
              setVaultPath(newVaultPath);
              bumpDataVersion();
            }}
            onAutoLockTimeoutChange={setTimeoutMs}
            onClose={() => void navigateTo({ kind: "list" })}
          />
        )}

        {screen.kind === "importExport" && (
          <div className="app-screen-panel" onKeyDown={handleImportExportPanelKeyDown}>
            <header className="app-screen-panel__header">
              <h1 className="app-screen-panel__title">Резервная копия и обмен данными</h1>
              <button
                type="button"
                className="app-screen-panel__close-btn"
                aria-label="Закрыть"
                onClick={() => void navigateTo({ kind: "list" })}
              >
                ×
              </button>
            </header>
            <div className="app-screen-panel__body">
              <ImportExportPanel
                store={store}
                onImportSuccess={handleImportSuccess}
                onError={(message) => console.error("ImportExportPanel:", message)}
              />
              {importSaveError && (
                <p className="app-screen-panel__error" role="alert">
                  {importSaveError}
                </p>
              )}
            </div>

            {importCountWarning && (
              <div className="app-modal-overlay" role="presentation">
                <div
                  className="app-modal"
                  role="dialog"
                  aria-modal="true"
                  aria-labelledby="app-import-count-warning-title"
                >
                  <h2 id="app-import-count-warning-title">Число записей уменьшилось</h2>
                  <p>{formatCountDecreaseMessage(importCountWarning)}</p>
                  <div className="app-modal__actions">
                    <button type="button" onClick={rollbackPendingImport}>
                      Отмена
                    </button>
                    <button type="button" onClick={() => void persistAfterImport({ allowCountDecrease: true })}>
                      Всё равно сохранить
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </AppShell>
    </>
  );
}

export default App;
