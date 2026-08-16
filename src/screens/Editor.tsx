import { forwardRef, useId, useImperativeHandle, useRef, useState } from "react";
import {
  ItemCountDecreasedError,
  type Item,
  type ItemField,
  type ItemType,
  type VaultStore,
} from "../lib/vaultStore";
import { PasswordGenerator } from "../components/PasswordGenerator";
import "./Editor.css";

/**
 * Редактор записи (R98, spec.md §9 "Редактор"; тексты - §14, R84).
 *
 * Один экран на все пять типов записи (`login`/`note`/`card`/`key`/
 * `other`) - тип не меняет набор элементов управления, только подпись
 * выбранной кнопки-переключателя типа. Динамический список полей
 * (`name`/`value`/`secret`), теги, заметка - см. "Что должно заработать" в
 * тикете 08.
 *
 * D02 (interfaces.md): `src/App.tsx` не в зоне этого тикета, его сведёт
 * тикет 12 позже, когда все экраны уже существуют. Поэтому у Editor
 * полностью самостоятельный публичный контракт через пропсы/колбэки
 * (`EditorProps` ниже) и императивный хэндл (`EditorHandle`) - тикет 12
 * подключает готовый компонент, ничего в этом файле менять не должно.
 *
 * Про "было N, стало M" (R28): раньше этот экран сам сравнивал число
 * записей на момент открытия со снимком на момент сохранения. Ревью
 * поймало, что база сравнения была неверной - в брифе дословно "при
 * последней успешной загрузке", а не "при открытии редактора" (снимок
 * дрейфовал бы при каждом повторном открытии одного и того же экрана).
 * Защита теперь централизована в `VaultStore.save()` (`vaultStore.ts`):
 * `save(path)` сам бросает `ItemCountDecreasedError` (поля `.loaded`/
 * `.current`) и ничего не пишет на диск, если записей стало меньше, чем
 * было при последней успешной `loadFromBytes`/`createNewVault`/`save`, и
 * не передан `{ allowCountDecrease: true }`. Этот экран только ловит
 * ошибку, показывает те же числа в той же модалке и, если пользователь
 * подтвердил, зовёт `store.save(vaultPath, { allowCountDecrease: true })`
 * повторно - без повторного коммита правки в `store` (см. `attemptSave`/
 * `confirmCountWarningAndSave` ниже).
 */

/** Метка типа записи для переключателя. Ни в interfaces.md, ни в spec.md
 * готовых подписей для `key`/`other` нет - но `login`/`note`/`card`/`other`
 * уже встречаются как моковые подписи в AppShell.tsx (тикет 03, "Прочее") и
 * как реальные в RecordCard.tsx (параллельный тикет 07, `TYPE_LABELS`) -
 * значения здесь подобраны той же строкой, чтобы одна и та же запись не
 * называлась по-разному в редакторе и в карточке/списке. */
export const ITEM_TYPE_LABELS: Record<ItemType, string> = {
  login: "Пароль",
  note: "Заметка",
  card: "Карта",
  key: "Ключ",
  other: "Прочее",
};

/** Порядок кнопок переключателя типа - тот же порядок, что в `ItemType` из
 * vaultStore.ts. */
export const ITEM_TYPES: ItemType[] = ["login", "note", "card", "key", "other"];

/** R84: имя действия одно и то же на всём пути - кнопка и статус после
 * успеха используют один и тот же глагол в двух формах, не разные слова
 * ("Применить"/"Готово" и т.п. запрещены дословно в тикете). */
export const SAVE_LABEL = "Сохранить";
export const SAVED_LABEL = "Сохранено";

/** R98.1/R115i - точная формулировка из тикета 08 ("«Есть несохранённые
 * изменения» с выбором сохранить/отменить"), один и тот же диалог что для
 * закрытия карточки редактора, что (через `EditorHandle.requestClose`) для
 * закрытия всего приложения. */
export const UNSAVED_CHANGES_TITLE = "Есть несохранённые изменения";

/** Одна строка динамического списка полей в форме редактора. `key` -
 * стабильный идентификатор только для React/фокуса внутри этого экрана,
 * наружу (в `ItemField`) не уходит - у полей записи в модели `vaultStore.ts`
 * своего id нет. */
type FieldRow = { key: string; name: string; value: string; secret: boolean };

/** Локальное состояние формы редактора - живёт, пока запись не сохранена;
 * после успешного сохранения (`finalizeSaveSuccess`) становится новой
 * точкой отсчёта для проверки "есть несохранённые правки". */
type EditorFormState = {
  type: ItemType;
  title: string;
  tags: string[];
  fields: FieldRow[];
  note: string;
};

/** Что положить в поле, которое было в фокусе на момент открытия генератора
 * паролей (R49) - заметка и название тоже валидные цели, не только поля
 * записи (например, пароль как заметка целиком). */
type FocusTarget = { kind: "title" } | { kind: "note" } | { kind: "field"; key: string };

function makeFieldKey(): string {
  return crypto.randomUUID();
}

/** Item -> локальная форма редактора (существующая запись). Экспортирована
 * для теста шва "поля/теги редактируются корректно" (см. Editor.test.ts) -
 * в проекте нет jsdom/@testing-library для монтирования компонента, поэтому
 * тестируемый публичный шов - чистые функции трансформации формы, не рендер. */
export function itemToFormState(item: Item): EditorFormState {
  return {
    type: item.type,
    title: item.title,
    tags: [...item.tags],
    fields: item.fields.map((f) => ({ key: makeFieldKey(), name: f.name, value: f.value, secret: f.secret })),
    note: item.note,
  };
}

/**
 * R43 (В1, дословно из брифа): "login, note, card, key, other. Отличаются
 * только набором предзаполненных полей в редакторе". Применяется ТОЛЬКО при
 * создании новой записи - `itemToFormState()` для уже сохранённой записи
 * всегда берёт настоящие поля из `item.fields`, эти дефолты в этом случае
 * не участвуют вообще. Значения полей пустые - предзадано только название и
 * `secret`, не сами данные.
 *
 * Переключение типа уже открытого черновика новой записи НЕ пересобирает
 * список полей заново (см. обработчик клика по `editor__type-btn` ниже) -
 * если бы это происходило, смена типа посреди заполнения молча стирала бы
 * то, что пользователь уже успел ввести, а это как раз то, от чего
 * предостерегает R98.1 ("не тихая потеря введённого"), просто в другом
 * месте экрана. Дефолты - это стартовый набор для НОВОЙ, ещё пустой формы,
 * не правило, которое непрерывно синхронизирует поля с типом.
 */
function defaultFieldsFor(type: ItemType): FieldRow[] {
  switch (type) {
    case "login":
      return [
        { key: makeFieldKey(), name: "Логин", value: "", secret: false },
        { key: makeFieldKey(), name: "Пароль", value: "", secret: true },
      ];
    case "card":
      return [
        { key: makeFieldKey(), name: "Номер карты", value: "", secret: true },
        { key: makeFieldKey(), name: "Срок действия", value: "", secret: false },
        { key: makeFieldKey(), name: "CVC", value: "", secret: true },
      ];
    case "key":
      return [{ key: makeFieldKey(), name: "Ключ", value: "", secret: true }];
    case "note":
    case "other":
      // Дословно из дозапроса: "note, other: без предзаполненных полей
      // (пользователь добавляет вручную) - эти два и так отличаются только
      // этим [от остальных типов]".
      return [];
  }
}

/** Пустая форма для новой записи заданного типа - поля предзаполнены по
 * типу (R43), остальное пусто. */
export function emptyFormState(defaultType: ItemType = "login"): EditorFormState {
  return { type: defaultType, title: "", tags: [], fields: defaultFieldsFor(defaultType), note: "" };
}

export function addFieldRow(fields: FieldRow[]): FieldRow[] {
  return [...fields, { key: makeFieldKey(), name: "", value: "", secret: false }];
}

export function removeFieldRow(fields: FieldRow[], key: string): FieldRow[] {
  return fields.filter((f) => f.key !== key);
}

/** Добавить тег: пустая строка после `trim()` и точный дубликат игнорируются
 * молча (не ошибка - обычное поведение чипов-тегов). */
export function addTag(tags: string[], raw: string): string[] {
  const trimmed = raw.trim();
  if (trimmed === "" || tags.includes(trimmed)) return tags;
  return [...tags, trimmed];
}

export function removeTag(tags: string[], tag: string): string[] {
  return tags.filter((t) => t !== tag);
}

/** Форма -> патч для `VaultStore.addItem`/`updateItem`. Ключ `attachments`
 * намеренно не включается: этот экран не управляет вложениями (тикет 11,
 * ещё не построен) - `updateItem` сохраняет существующие `attachments` без
 * изменений, если патч этого поля не содержит (см. vaultStore.ts:
 * `{...existing, ...patch}`), а `addItem` даёт новой записи пустой массив
 * по умолчанию. Именно так следующий тикет (11) должен расширять этот же
 * экран - добавить работу с `attachments` в форму и в этот патч, не трогая
 * остальную логику. */
export function formStateToPatch(
  form: EditorFormState,
): { type: ItemType; title: string; tags: string[]; fields: ItemField[]; note: string } {
  return {
    type: form.type,
    title: form.title,
    tags: form.tags,
    fields: form.fields.map(({ name, value, secret }) => ({ name, value, secret })),
    note: form.note,
  };
}

function formsEqual(a: EditorFormState, b: EditorFormState): boolean {
  return JSON.stringify(formStateToPatch(a)) === JSON.stringify(formStateToPatch(b));
}

/** R28: числа "было/стало" для модалки - те же поля, что несёт сама
 * `ItemCountDecreasedError` (`.loaded`/`.current`), без лишнего слоя
 * переименования между ошибкой стора и текстом на экране. */
export type CountDecreaseWarning = {
  loaded: number;
  current: number;
};

/** Текст предупреждения - дословно формат "было N, стало M" из тикета 08 и
 * spec.md §9. */
export function formatCountDecreaseMessage(warning: CountDecreaseWarning): string {
  return `Было ${warning.loaded}, стало ${warning.current}.`;
}

/** Единая формулировка при неудаче `store.save()`, отличной от R28
 * (диск занят, каталог недоступен и т.п.) - та же фраза, что уже принята в
 * LockScreen.tsx для того же случая (R85: что случилось и что делать, без
 * "Произошла ошибка"). */
export const SAVE_FAILED_MESSAGE =
  "Не удалось сохранить базу по этому пути. Проверьте, что каталог доступен для записи, и попробуйте снова";

/** Императивный контракт для внешнего кода (в первую очередь тикет 12,
 * который смонтирует Editor в App.tsx). `hasUnsavedChanges`/`requestClose`
 * дают тикету 12 перехватить закрытие ВСЕГО приложения (R115i - "тот же
 * диалог") тем же путём, которым сам Editor обрабатывает свою кнопку
 * закрытия - без дублирования диалога в другом файле. */
export type EditorHandle = {
  /** Есть ли несохранённые правки в форме прямо сейчас. */
  hasUnsavedChanges: () => boolean;
  /**
   * Тот же поток, что при клике на кнопку закрытия в самом редакторе: если
   * есть несохранённые правки - показывает диалог "Есть несохранённые
   * изменения" и ждёт выбора пользователя (сохранить -> сохраняет и
   * закрывает; отмена -> остаётся в редакторе, правки на месте); если
   * правок нет - закрывает сразу. Резолвится `true`, если можно закрывать/
   * размонтировать редактор (или уже закрыто через `onClose`), `false` -
   * если пользователь отменил закрытие.
   */
  requestClose: () => Promise<boolean>;
};

export type EditorProps = {
  /** Уже загруженный `VaultStore` (createNewVault/loadFromBytes выше по
   * дереву уже отработали - см. interfaces.md). */
  store: VaultStore;
  /**
   * Запись для редактирования - копия данных, не `id`: у `VaultStore` нет
   * метода "получить запись по id" (только addItem/updateItem/deleteItem/
   * search), а экран списка (тикет 07) и так держит нужную запись после
   * поиска/выбора - дешевле передать то, что уже на руках, чем заводить в
   * этом тикете новый метод поиска по id в чужом модуле. Отсутствие -
   * создание новой записи.
   *
   * Если `item` меняется между рендерами БЕЗ размонтирования компонента,
   * форма не пересинхронизируется - предполагается, что вызывающий код
   * использует `key` (например `key={item?.id ?? "new"}`) при переключении
   * записи, обычный React-приём сброса внутреннего состояния формы.
   */
  item?: Item;
  /** Тип новой записи по умолчанию, если `item` не передан (переключатель
   * типа в редакторе всё равно даёт сменить). По умолчанию `"login"`. */
  defaultType?: ItemType;
  /** Путь к файлу базы - нужен для `store.save(vaultPath)` на кнопку
   * "Сохранить" (тот же проп-паттерн, что уже использует `LockScreen.tsx`/
   * `useAutoLock.ts`, тикеты 06). "Сохранить" в этом экране означает и
   * коммит правки в `store` (addItem/updateItem), и запись на диск в одном
   * действии - как обычно в этом проекте (см. `performAutoLock` в
   * `useAutoLock.ts`, тот же паттерн `store.save()` + перехват
   * `ItemCountDecreasedError`). */
  vaultPath: string;
  /** Запись успешно сохранена: закоммичена в `store` (addItem/updateItem) И
   * записана на диск (`store.save()` завершился без ошибки, включая случай
   * повторного вызова после подтверждения R28). */
  onSaved?: (item: Item) => void;
  /** Пользователь закрыл редактор (после подтверждения, если были
   * несохранённые правки, либо сразу, если их не было). Экран списка
   * (тикет 07/12) решает, куда вернуться. */
  onClose: () => void;
};

export const Editor = forwardRef<EditorHandle, EditorProps>(function Editor(
  { store, item, defaultType = "login", vaultPath, onSaved, onClose },
  ref,
) {
  const titleId = useId();
  const tagInputId = useId();
  const noteId = useId();

  const [form, setForm] = useState<EditorFormState>(() =>
    item ? itemToFormState(item) : emptyFormState(defaultType),
  );
  const [initialSnapshot, setInitialSnapshot] = useState<EditorFormState>(form);
  const [committedId, setCommittedId] = useState<string | undefined>(item?.id);
  const [justSaved, setJustSaved] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const [tagDraft, setTagDraft] = useState("");
  const [generatorOpen, setGeneratorOpen] = useState(false);

  const [closeConfirmVisible, setCloseConfirmVisible] = useState(false);
  const [countWarning, setCountWarning] = useState<CountDecreaseWarning | null>(null);

  const lastFocusTargetRef = useRef<FocusTarget | null>(null);
  const generatorTargetRef = useRef<FocusTarget | null>(null);
  const pendingCloseResolveRef = useRef<((ok: boolean) => void) | null>(null);
  const closeAfterSaveRef = useRef(false);
  // Запись, уже закоммиченная в store.addItem/updateItem в текущей попытке
  // сохранения - нужна для повтора после R28-подтверждения
  // (confirmCountWarningAndSave), чтобы НЕ коммитить правку в store второй
  // раз (второй addItem() создал бы дубликат записи, а не отредактировал
  // существующую).
  const pendingSavedItemRef = useRef<Item | null>(null);

  const isDirty = !formsEqual(form, initialSnapshot);
  const showSaved = justSaved && !isDirty;

  function updateField(key: string, patch: Partial<Omit<FieldRow, "key">>) {
    setForm((f) => ({
      ...f,
      fields: f.fields.map((row) => (row.key === key ? { ...row, ...patch } : row)),
    }));
  }

  function commitTagDraft() {
    if (tagDraft.trim() === "") return;
    setForm((f) => ({ ...f, tags: addTag(f.tags, tagDraft) }));
    setTagDraft("");
  }

  /** Закоммитить текущую форму в `store` (addItem/updateItem, в памяти,
   * синхронно). Отдельно от записи на диск - `attemptSave`/
   * `confirmCountWarningAndSave` вызывают её РОВНО один раз за попытку
   * сохранения, дальнейшие повторы (после подтверждения R28) трогают
   * только `store.save()`, не эту функцию снова. */
  function commitFormToStore(): Item {
    const patch = formStateToPatch(form);
    const saved = committedId ? store.updateItem(committedId, patch) : store.addItem(patch);
    setCommittedId(saved.id);
    return saved;
  }

  function finalizeSaveSuccess(saved: Item, thenClose: boolean) {
    setInitialSnapshot(form);
    setJustSaved(true);
    setSaveError(null);
    pendingSavedItemRef.current = null;
    onSaved?.(saved);
    if (thenClose) finishClose();
  }

  function resolvePendingClose(ok: boolean) {
    const resolve = pendingCloseResolveRef.current;
    pendingCloseResolveRef.current = null;
    setCloseConfirmVisible(false);
    resolve?.(ok);
  }

  function finishClose() {
    onClose();
    resolvePendingClose(true);
  }

  /**
   * Общий путь для кнопки "Сохранить" в футере и для "Сохранить" внутри
   * диалога "Есть несохранённые изменения" - один обработчик с флагом
   * `thenClose`. Коммитит правку в `store` (в памяти), затем зовёт
   * `store.save(vaultPath)` как обычно (тот же паттерн, что в
   * `useAutoLock.ts`/`LockScreen.tsx`) - R28 теперь целиком проверяет сам
   * `save()` и бросает `ItemCountDecreasedError`, а не локальный снимок
   * этого экрана.
   */
  async function attemptSave(thenClose: boolean) {
    closeAfterSaveRef.current = thenClose;
    const saved = commitFormToStore();
    pendingSavedItemRef.current = saved;
    try {
      await store.save(vaultPath);
      finalizeSaveSuccess(saved, thenClose);
    } catch (err) {
      if (err instanceof ItemCountDecreasedError) {
        setCountWarning({ loaded: err.loaded, current: err.current });
      } else {
        setSaveError(SAVE_FAILED_MESSAGE);
        closeAfterSaveRef.current = false;
      }
    }
  }

  /** "Всё равно сохранить" в модалке R28 - НЕ коммитит правку в `store`
   * повторно (уже сделано в `attemptSave` до того, как `save()` бросил
   * `ItemCountDecreasedError`), только повторяет `store.save()` с явным
   * подтверждением. */
  async function confirmCountWarningAndSave() {
    setCountWarning(null);
    const saved = pendingSavedItemRef.current;
    if (!saved) return; // defensive: эта модалка не должна открываться без предшествующего commitFormToStore()
    try {
      await store.save(vaultPath, { allowCountDecrease: true });
      finalizeSaveSuccess(saved, closeAfterSaveRef.current);
    } catch (err) {
      setSaveError(SAVE_FAILED_MESSAGE);
      console.error("Editor: повторное сохранение с allowCountDecrease тоже не удалось", err);
    }
    closeAfterSaveRef.current = false;
  }

  function cancelCountWarning() {
    setCountWarning(null);
    pendingSavedItemRef.current = null;
    if (closeAfterSaveRef.current) {
      // Отмена сохранения посреди попытки закрытия отменяет и само
      // закрытие - правки остаются на месте, та же гарантия, что и у
      // обычной "Отмена" в диалоге "Есть несохранённые изменения"
      // ("не тихая потеря введённого"). Правка при этом уже закоммичена в
      // store (in-memory) через commitFormToStore() в attemptSave() -
      // store.isDirty() остаётся true до следующего успешного save(),
      // ничего не потеряно, просто ещё не записано на диск.
      resolvePendingClose(false);
    }
    closeAfterSaveRef.current = false;
  }

  function requestCloseInternal(): Promise<boolean> {
    if (!isDirty) {
      onClose();
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      pendingCloseResolveRef.current = resolve;
      setCloseConfirmVisible(true);
    });
  }

  useImperativeHandle(ref, () => ({
    hasUnsavedChanges: () => isDirty,
    requestClose: () => requestCloseInternal(),
  }));

  function openGenerator() {
    generatorTargetRef.current =
      lastFocusTargetRef.current ?? (form.fields[0] ? { kind: "field", key: form.fields[0].key } : { kind: "title" });
    setGeneratorOpen(true);
  }

  function handleInsertGenerated(password: string) {
    const target = generatorTargetRef.current;
    if (target) {
      if (target.kind === "title") {
        setForm((f) => ({ ...f, title: password }));
      } else if (target.kind === "note") {
        setForm((f) => ({ ...f, note: password }));
      } else {
        setForm((f) => ({
          ...f,
          fields: f.fields.map((row) => (row.key === target.key ? { ...row, value: password } : row)),
        }));
      }
    }
    setGeneratorOpen(false);
  }

  return (
    <section className="editor">
      <header className="editor__header">
        <div className="editor__type-selector" role="radiogroup" aria-label="Тип записи">
          {ITEM_TYPES.map((t) => (
            <button
              key={t}
              type="button"
              role="radio"
              aria-checked={form.type === t}
              className={`editor__type-btn${form.type === t ? " editor__type-btn--active" : ""}`}
              onClick={() => setForm((f) => ({ ...f, type: t }))}
            >
              {ITEM_TYPE_LABELS[t]}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="editor__close-btn"
          aria-label="Закрыть"
          onClick={() => {
            void requestCloseInternal();
          }}
        >
          ×
        </button>
      </header>

      <div className="editor__body">
        <div className="editor__section">
          <label className="editor__label" htmlFor={titleId}>
            Название
          </label>
          <input
            id={titleId}
            className="editor__title-input"
            type="text"
            value={form.title}
            onFocus={() => {
              lastFocusTargetRef.current = { kind: "title" };
            }}
            onChange={(e) => setForm((f) => ({ ...f, title: e.currentTarget.value }))}
          />
        </div>

        <div className="editor__section">
          <label className="editor__label" htmlFor={tagInputId}>
            Теги
          </label>
          <div className="editor__tags">
            {form.tags.map((tag) => (
              <span className="editor__tag-chip" key={tag}>
                {tag}
                <button
                  type="button"
                  className="editor__tag-remove"
                  aria-label={`Удалить тег ${tag}`}
                  onClick={() => setForm((f) => ({ ...f, tags: removeTag(f.tags, tag) }))}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
          <div className="editor__tag-input-row">
            <input
              id={tagInputId}
              type="text"
              placeholder="Новый тег"
              value={tagDraft}
              onChange={(e) => setTagDraft(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitTagDraft();
                }
              }}
            />
            <button type="button" onClick={commitTagDraft}>
              Добавить
            </button>
          </div>
        </div>

        <div className="editor__section">
          <div className="editor__section-header">
            <span className="editor__label">Поля</span>
            <div className="editor__generator-anchor">
              <button type="button" onClick={openGenerator}>
                Сгенерировать пароль
              </button>
              {generatorOpen && (
                <div className="editor__generator-popover">
                  <PasswordGenerator onInsert={handleInsertGenerated} onClose={() => setGeneratorOpen(false)} />
                </div>
              )}
            </div>
          </div>

          <div className="editor__fields">
            {form.fields.map((row) => (
              <div className="editor__field-row" key={row.key}>
                <input
                  className="editor__field-name"
                  type="text"
                  aria-label="Название поля"
                  placeholder="Название поля"
                  value={row.name}
                  onChange={(e) => updateField(row.key, { name: e.currentTarget.value })}
                />
                <input
                  className="editor__field-value"
                  type="text"
                  aria-label="Значение поля"
                  placeholder="Значение"
                  value={row.value}
                  onFocus={() => {
                    lastFocusTargetRef.current = { kind: "field", key: row.key };
                  }}
                  onChange={(e) => updateField(row.key, { value: e.currentTarget.value })}
                />
                <label className="editor__field-secret">
                  <input
                    type="checkbox"
                    checked={row.secret}
                    onChange={(e) => updateField(row.key, { secret: e.currentTarget.checked })}
                  />
                  секретное
                </label>
                <button
                  type="button"
                  className="editor__field-remove"
                  aria-label={row.name ? `Удалить поле ${row.name}` : "Удалить поле"}
                  onClick={() => setForm((f) => ({ ...f, fields: removeFieldRow(f.fields, row.key) }))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>

          <button
            type="button"
            className="editor__add-field-btn"
            onClick={() => setForm((f) => ({ ...f, fields: addFieldRow(f.fields) }))}
          >
            Добавить поле
          </button>
        </div>

        <div className="editor__section">
          <label className="editor__label" htmlFor={noteId}>
            Заметка
          </label>
          <textarea
            id={noteId}
            className="editor__note-textarea"
            rows={4}
            value={form.note}
            onFocus={() => {
              lastFocusTargetRef.current = { kind: "note" };
            }}
            onChange={(e) => setForm((f) => ({ ...f, note: e.currentTarget.value }))}
          />
        </div>
      </div>

      <footer className="editor__footer">
        <button
          type="button"
          className="editor__save-btn"
          onClick={() => {
            void attemptSave(false);
          }}
        >
          {SAVE_LABEL}
        </button>
        <span className="editor__status" aria-live="polite">
          {showSaved ? SAVED_LABEL : ""}
        </span>
        {saveError && <span className="editor__save-error">{saveError}</span>}
      </footer>

      {closeConfirmVisible && (
        <div className="editor__modal-overlay" role="presentation">
          <div className="editor__modal" role="dialog" aria-modal="true" aria-labelledby="editor-unsaved-title">
            <h2 id="editor-unsaved-title">{UNSAVED_CHANGES_TITLE}</h2>
            <p>Правки ещё не сохранены. Сохранить их перед закрытием?</p>
            <div className="editor__modal-actions">
              <button type="button" onClick={() => resolvePendingClose(false)}>
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  // Спрятать этот диалог ДО attemptSave: если сравнение R28
                  // покажет уменьшение числа записей, откроется модалка
                  // предупреждения - оба диалога одновременно на экране не
                  // нужны (pendingCloseResolveRef остаётся - его освобождает
                  // только finishClose()/resolvePendingClose(), не эта строка).
                  setCloseConfirmVisible(false);
                  void attemptSave(true);
                }}
              >
                {SAVE_LABEL}
              </button>
            </div>
          </div>
        </div>
      )}

      {countWarning && (
        <div className="editor__modal-overlay" role="presentation">
          <div className="editor__modal" role="dialog" aria-modal="true" aria-labelledby="editor-count-warning-title">
            <h2 id="editor-count-warning-title">Число записей уменьшилось</h2>
            <p>{formatCountDecreaseMessage(countWarning)}</p>
            <div className="editor__modal-actions">
              <button type="button" onClick={cancelCountWarning}>
                Отмена
              </button>
              <button
                type="button"
                onClick={() => {
                  void confirmCountWarningAndSave();
                }}
              >
                Всё равно сохранить
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
});
