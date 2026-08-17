import { describe, expect, it } from "vitest";
import { VaultStore } from "../lib/vaultStore";
import {
  ITEM_TYPES,
  ITEM_TYPE_LABELS,
  SAVE_LABEL,
  SAVED_LABEL,
  DISCARD_LABEL,
  UNSAVED_CHANGES_TITLE,
  formatCountDecreaseMessage,
  addFieldRow,
  removeFieldRow,
  addTag,
  removeTag,
  itemToFormState,
  emptyFormState,
  formStateToPatch,
  formatFileSize,
  attachmentFromFileBytes,
  decodeAttachmentBytes,
  addAttachment,
  removeAttachment,
  buildAttachmentSizeWarning,
  inputValueFromEvent,
  resolveGeneratorTarget,
  groupFieldRows,
  nextAccountName,
  addAccountRows,
  renameAccount,
  removeAccount,
  type FieldRow,
  addAccountPressed,
} from "./Editor";

// Швы из spec.md §9/§14 и тикета 08 (R28, R84, R98.1, R19). В проекте нет
// jsdom/@testing-library (см. package.json) - монтировать компонент и
// кликать по нему нечем, поэтому тестируются публичные чистые функции,
// вынесенные из Editor.tsx специально ради этого (см. комментарии в
// Editor.tsx у каждого экспорта). Диалоговое/фокус-вставочное поведение
// самого компонента проверено вручную по коду, не автотестом - см. CONCERNS
// в отчёте по тикету.

describe("R84: имя действия сохраняется на всём пути", () => {
  it("кнопка называется «Сохранить», статус после сохранения - «Сохранено» (не «Применить»/«Готово»)", () => {
    // Ожидаемые значения - дословная цитата из тикета 08 ("Кнопка называется
    // тем, что произойдёт: «Сохранить»... нажал «Сохранить», увидел
    // «Сохранено»"), не импорт константы из кода под тестом.
    expect(SAVE_LABEL).toBe("Сохранить");
    expect(SAVED_LABEL).toBe("Сохранено");
  });
});

describe("R98.1/R115i: диалог несохранённых изменений", () => {
  it("заголовок диалога - точная формулировка из тикета 08", () => {
    expect(UNSAVED_CHANGES_TITLE).toBe("Есть несохранённые изменения");
  });
});

// R28: сравнение чисел "было/стало" и решение "писать на диск или нет"
// теперь целиком внутри VaultStore.save() (ItemCountDecreasedError,
// vaultStore.ts) - централизовано ревью, чтобы база сравнения была "при
// последней успешной загрузке" (дословно из брифа), а не "при открытии
// экрана". Это уже покрыто тестами vaultStore.test.ts (в частности
// "importing fewer items... is caught by ItemCountDecreasedError on the
// next save"). Здесь, в зоне этого тикета, остаётся только форматирование
// текста модалки из чисел, которые несёт сама ошибка.
describe("R28: текст предупреждения об уменьшении числа записей", () => {
  it("формирует сообщение «было N, стало M» точно по формату из спецификации, из полей ошибки VaultStore", () => {
    // Поля loaded/current - те же имена, что у ItemCountDecreasedError.loaded/
    // .current (vaultStore.ts) - модалка показывает их как есть, без
    // переименования.
    expect(formatCountDecreaseMessage({ loaded: 10, current: 7 })).toBe("Было 10, стало 7.");
  });
});

describe("R19/R98: один редактор на все пять типов записи", () => {
  it("тип и пустые теги одинаково собираются для любого из пяти типов", () => {
    for (const type of ITEM_TYPES) {
      const form = emptyFormState(type);
      const patch = formStateToPatch(form);
      expect(patch.type).toBe(type);
      expect(patch.tags).toEqual([]);
    }
    expect(ITEM_TYPES).toEqual(["login", "note", "card", "key", "other"]);
  });

  it("у каждого типа есть понятная пользователю метка (не техническое имя поля)", () => {
    for (const type of ITEM_TYPES) {
      expect(ITEM_TYPE_LABELS[type]).toBeTruthy();
      expect(ITEM_TYPE_LABELS[type]).not.toBe(type);
    }
  });
});

describe("R43: типы отличаются только набором предзаполненных полей в НОВОЙ записи", () => {
  it("login получает поля «Логин» (не секретное) и «Пароль» (секретное)", () => {
    const fields = emptyFormState("login").fields;
    expect(fields.map((f) => ({ name: f.name, secret: f.secret }))).toEqual([
      { name: "Логин", secret: false },
      { name: "Пароль", secret: true },
    ]);
  });

  it("card получает номер карты и CVC как секретные поля, срок действия - как не секретное", () => {
    const fields = emptyFormState("card").fields;
    expect(fields.map((f) => ({ name: f.name, secret: f.secret }))).toEqual([
      { name: "Номер карты", secret: true },
      { name: "Срок действия", secret: false },
      { name: "CVC", secret: true },
    ]);
  });

  it("key получает одно секретное поле", () => {
    const fields = emptyFormState("key").fields;
    expect(fields.map((f) => ({ name: f.name, secret: f.secret }))).toEqual([{ name: "Ключ", secret: true }]);
  });

  it("note и other не получают предзаполненных полей - пользователь добавляет их вручную (дословно из дозапроса)", () => {
    expect(emptyFormState("note").fields).toEqual([]);
    expect(emptyFormState("other").fields).toEqual([]);
  });

  it("значения предзаполненных полей пустые - предзадано только название и secret, не данные", () => {
    for (const type of ["login", "card", "key"] as const) {
      for (const field of emptyFormState(type).fields) {
        expect(field.value).toBe("");
      }
    }
  });

  it("у существующей записи (не новой) предзаполнение не применяется - поля берутся как есть из item", () => {
    const existing = {
      id: "1",
      type: "login" as const,
      title: "Example",
      tags: [],
      fields: [{ name: "custom field", value: "x", secret: false }],
      note: "",
      attachments: [],
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    expect(itemToFormState(existing).fields.map((f) => ({ name: f.name, value: f.value, secret: f.secret }))).toEqual(
      [{ name: "custom field", value: "x", secret: false }],
    );
  });
});

describe("Добавление/удаление произвольного поля и тега", () => {
  it("addFieldRow добавляет пустую строку поля, removeFieldRow удаляет её по ключу", () => {
    const withOne = addFieldRow([]);
    expect(withOne).toHaveLength(1);
    expect(withOne[0]).toMatchObject({ name: "", value: "", secret: false });

    const withTwo = addFieldRow(withOne);
    expect(withTwo).toHaveLength(2);

    const removed = removeFieldRow(withTwo, withOne[0].key);
    expect(removed).toHaveLength(1);
    expect(removed[0].key).toBe(withTwo[1].key);
  });

  it("addTag добавляет тег, игнорирует пустую строку и точный дубликат; removeTag удаляет по значению", () => {
    let tags = addTag([], "work");
    expect(tags).toEqual(["work"]);

    tags = addTag(tags, "  ");
    expect(tags).toEqual(["work"]);

    tags = addTag(tags, "work");
    expect(tags).toEqual(["work"]);

    tags = addTag(tags, "personal");
    expect(tags).toEqual(["work", "personal"]);

    tags = removeTag(tags, "work");
    expect(tags).toEqual(["personal"]);
  });
});

describe("Добавление/удаление поля и тега реально сохраняется в VaultStore", () => {
  it("правка формы, применённая через updateItem, отражается в записи стора", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({ type: "login", title: "GitHub", tags: [], fields: [] });

    const form = itemToFormState(created);
    const withField = { ...form, fields: addFieldRow(form.fields) };
    const named = {
      ...withField,
      fields: withField.fields.map((f) => ({ ...f, name: "password", value: "s3cr3t", secret: true })),
      tags: addTag(withField.tags, "work"),
    };

    store.updateItem(created.id, formStateToPatch(named));

    const [persisted] = store.search("");
    expect(persisted.tags).toEqual(["work"]);
    expect(persisted.fields).toEqual([{ name: "password", value: "s3cr3t", secret: true }]);

    // Удаление того же поля тоже должно отражаться в сторе.
    const withoutField = { ...named, fields: removeFieldRow(named.fields, named.fields[0].key) };
    store.updateItem(created.id, formStateToPatch(withoutField));
    const [afterRemoval] = store.search("");
    expect(afterRemoval.fields).toEqual([]);
  });
});

// R44/§18: вложения файлов (тикет 11). Тот же приём, что и выше - нет
// jsdom, поэтому проверяются публичные чистые функции, а не рендер/клики.

describe("R44: форма вложений", () => {
  it("emptyFormState начинает без вложений для любого типа", () => {
    for (const type of ITEM_TYPES) {
      expect(emptyFormState(type).attachments).toEqual([]);
    }
  });

  it("formStateToPatch включает attachments формы как есть (тикет 08 намеренно не выставлял этот ключ - тикет 11 достраивает)", () => {
    const attachment = { id: "a1", name: "x.txt", mimeType: "text/plain", size: 1, data: "YQ==" };
    const form = { ...emptyFormState("other"), attachments: [attachment] };
    expect(formStateToPatch(form).attachments).toEqual([attachment]);
  });

  it("itemToFormState переносит существующие вложения записи в форму", () => {
    const attachment = { id: "a1", name: "x.txt", mimeType: "text/plain", size: 1, data: "YQ==" };
    const item = {
      id: "1",
      type: "other" as const,
      title: "t",
      tags: [],
      fields: [],
      note: "",
      attachments: [attachment],
      createdAt: "2020-01-01T00:00:00.000Z",
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    expect(itemToFormState(item).attachments).toEqual([attachment]);
  });
});

describe("addAttachment / removeAttachment", () => {
  it("addAttachment добавляет вложение в конец списка, removeAttachment удаляет по id", () => {
    const a1 = { id: "a1", name: "one.txt", mimeType: "text/plain", size: 1, data: "YQ==" };
    const a2 = { id: "a2", name: "two.txt", mimeType: "text/plain", size: 1, data: "Yg==" };

    let list = addAttachment([], a1);
    expect(list).toEqual([a1]);
    list = addAttachment(list, a2);
    expect(list).toEqual([a1, a2]);

    list = removeAttachment(list, "a1");
    expect(list).toEqual([a2]);
  });
});

describe("R44.2: скачанный файл побайтово совпадает с прикреплённым", () => {
  it("attachmentFromFileBytes -> decodeAttachmentBytes не теряет и не меняет ни одного байта, включая все значения 0..255", () => {
    const original = new Uint8Array(256);
    for (let i = 0; i < 256; i++) original[i] = i;

    const attachment = attachmentFromFileBytes(original, "C:\\Users\\me\\Downloads\\photo.png");
    const decoded = decodeAttachmentBytes(attachment);

    expect(decoded).toEqual(original);
    expect(attachment.size).toBe(256);
  });

  it("имя вложения - только последний сегмент пути (basename), для обоих разделителей ОС (закрывает часть находки ревью тикета 05 - interfaces.md, 'Из таска 05')", () => {
    expect(attachmentFromFileBytes(new Uint8Array([1]), "C:\\Users\\me\\report.pdf").name).toBe("report.pdf");
    expect(attachmentFromFileBytes(new Uint8Array([1]), "/home/me/report.pdf").name).toBe("report.pdf");
  });

  it("mimeType угадывается по расширению файла, неизвестное расширение получает универсальный тип, не пустую строку", () => {
    expect(attachmentFromFileBytes(new Uint8Array([1]), "a.pdf").mimeType).toBe("application/pdf");
    expect(attachmentFromFileBytes(new Uint8Array([1]), "a.png").mimeType).toBe("image/png");
    expect(attachmentFromFileBytes(new Uint8Array([1]), "a.unknownext").mimeType).toBe("application/octet-stream");
  });
});

describe("formatFileSize", () => {
  it("форматирует байты/КБ/МБ человекочитаемо", () => {
    expect(formatFileSize(500)).toBe("500 Б");
    expect(formatFileSize(2048)).toBe("2.0 КБ");
    expect(formatFileSize(5 * 1024 * 1024)).toBe("5.0 МБ");
  });
});

describe("buildAttachmentSizeWarning: R44.3 - предупреждение, не отказ", () => {
  // Пороги - дословно из spec.md §18 ("~25 МБ на файл, ~300 МБ на базу"),
  // литералами здесь, а не импортом константы из кода под тестом.
  const MB = 1024 * 1024;

  it("не показывает предупреждение, пока ни один порог не превышен", () => {
    expect(buildAttachmentSizeWarning(1 * MB, 10 * MB)).toBeNull();
  });

  it("предупреждает, когда сам файл крупнее ~25 МБ", () => {
    expect(buildAttachmentSizeWarning(26 * MB, 26 * MB)).not.toBeNull();
  });

  it("предупреждает, когда суммарный размер базы после добавления превышает ~300 МБ, даже если сам файл небольшой", () => {
    expect(buildAttachmentSizeWarning(1 * MB, 301 * MB)).not.toBeNull();
  });

  it("не отказывает и не бросает исключение ни при каком размере - только текст или null (приоритет 1 выше приоритета 4)", () => {
    expect(() => buildAttachmentSizeWarning(10 * 1024 * MB, 10 * 1024 * MB)).not.toThrow();
  });
});

// Регрессия живого прогона (2026-08-17): создание записи роняло всё React-
// дерево в белый экран - "Cannot read properties of null (reading 'value')"
// в Editor.tsx:776 (поле "Название"). Причина: апдейтер setForm читал
// e.currentTarget.value ЛЕНИВО, внутри своего замыкания, а не сразу в
// обработчике. React обнуляет e.currentTarget синтетического события сразу
// после завершения обработчика; React.StrictMode (src/main.tsx, dev-режим)
// повторно вызывает апдейтеры useState на следующем рендере компонента ради
// проверки их чистоты - и находил уже обнулённый e.currentTarget. Тест ниже
// доказывает главное свойство фикса: значение захватывается СИНХРОННО в
// момент вызова, а не читается заново из объекта события позже (когда тот
// уже мог измениться/стать недействительным) - без этого свойства тест был
// бы тавтологическим (просто проверял бы passthrough).
describe("Регрессия: краш при повторном вызове апдейтера useState с обнулённым e.currentTarget (живой прогон 2026-08-17)", () => {
  it("inputValueFromEvent захватывает значение сразу - результат не меняется, если currentTarget мутирует позже", () => {
    const target = { value: "New Title" };
    const fakeEvent = { currentTarget: target };

    const captured = inputValueFromEvent(fakeEvent);

    // Симулирует то, что реально происходит между исходным событием и
    // повторным вызовом апдейтера StrictMode: тот же объект currentTarget
    // меняется/устаревает уже ПОСЛЕ того, как обработчик его прочитал.
    target.value = "changed after the handler already returned";

    expect(captured).toBe("New Title");
  });

  it("бросает на попытке прочитать значение из объекта с currentTarget: null - тот же тип объекта, который реально приходил в апдейтер после StrictMode-обнуления (документирует форму краша, не только исправление)", () => {
    // TS не пропустил бы currentTarget: null напрямую (сигнатура требует
    // непустой { value: string }) - здесь воспроизводится именно то, что
    // видел баг в реальности: JS не мешает вызвать функцию с "неправильным"
    // объектом даже при строгой типизации на границе, а именно так апдейтер
    // и получал уже обнулённый e.currentTarget до фикса.
    const staleEvent = { currentTarget: null } as unknown as { currentTarget: { value: string } };
    expect(() => inputValueFromEvent(staleEvent)).toThrow(TypeError);
  });
});

// Регрессия живого прогона (2026-08-17, репорт ПОСЛЕ фикса краша выше):
// открыть генератор на свежей записи без единого поля (note/other сразу
// после создания, либо login/card после удаления всех полей) и без клика в
// какое-либо поле, вставить пароль - раньше он молча попадал в TITLE
// записи (запись сохранялась с паролем вместо названия и пустым полем
// "Пароль" - реальная потеря данных пользователя, не просто визуальный
// баг). Тест ниже доказывает главное свойство фикса: без явного фокуса
// resolveGeneratorTarget НИКОГДА не резолвится в title/note, когда полей
// нет - только "createField".
describe("Регрессия: генератор пароля никогда молча не пишет в title/note без явного фокуса (живой прогон 2026-08-17)", () => {
  const field = (key: string): FieldRow => ({ key, name: "Логин", value: "", secret: false });

  it("явный фокус (включая title/note) уважается как есть - осознанный выбор пользователя (R49)", () => {
    expect(resolveGeneratorTarget({ kind: "title" }, [])).toEqual({
      kind: "existing",
      target: { kind: "title" },
    });
    expect(resolveGeneratorTarget({ kind: "note" }, [field("a")])).toEqual({
      kind: "existing",
      target: { kind: "note" },
    });
    expect(resolveGeneratorTarget({ kind: "field", key: "x" }, [])).toEqual({
      kind: "existing",
      target: { kind: "field", key: "x" },
    });
  });

  it("без фокуса, но с существующим первым полем - целится в него, не в title", () => {
    expect(resolveGeneratorTarget(null, [field("first"), field("second")])).toEqual({
      kind: "existing",
      target: { kind: "field", key: "first" },
    });
  });

  it("без фокуса и без единого поля - 'createField', НИКОГДА не title (регрессия потери данных)", () => {
    const result = resolveGeneratorTarget(null, []);
    expect(result).toEqual({ kind: "createField" });
    // Явно перепроверяем негативное условие форматом самого бага: результат
    // не должен быть "existing" с title/note ни в каком виде.
    expect(result.kind).not.toBe("existing");
  });
});

// Живой прогон (2026-08-17): диалог "Есть несохранённые изменения" умел
// только "Отмена" (остаться в редакторе) и "Сохранить" (сохранить и
// закрыть) - выйти БЕЗ сохранения было физически нечем, пользователь не мог
// отбросить правки и закрыть редактор одним действием. Компонентный рендер
// клика по третьей кнопке здесь не протестировать (нет jsdom - см. шапку
// файла); фиксируется точная подпись новой кнопки (тот же уровень
// регрессии, что и у R84 выше про SAVE_LABEL/SAVED_LABEL) и то, что она не
// совпадает ни с одним из двух вариантов, которых раньше было ровно два -
// это и есть суть бага.
describe('Регрессия: у диалога закрытия не было варианта "выйти без сохранения" (живой прогон 2026-08-17)', () => {
  it("DISCARD_LABEL существует и текстуально отличается от «Отмена» и от SAVE_LABEL", () => {
    expect(DISCARD_LABEL).toBe("Не сохранять");
    expect(DISCARD_LABEL).not.toBe(SAVE_LABEL);
    expect(DISCARD_LABEL).not.toBe("Отмена");
  });
});

describe("Вложения реально сохраняются и удаляются в VaultStore (R44)", () => {
  it("attachments из форм-патча попадают в запись стора и удаляются оттуда", async () => {
    const store = new VaultStore();
    await store.createNewVault("pw", 1000);
    const created = store.addItem({ type: "other", title: "Doc", tags: [], fields: [] });

    const form = itemToFormState(created);
    const attachment = attachmentFromFileBytes(new Uint8Array([1, 2, 3]), "report.pdf");
    const withAttachment = { ...form, attachments: addAttachment(form.attachments, attachment) };
    store.updateItem(created.id, formStateToPatch(withAttachment));

    expect(store.search("")[0].attachments).toEqual([attachment]);

    const withoutAttachment = {
      ...withAttachment,
      attachments: removeAttachment(withAttachment.attachments, attachment.id),
    };
    store.updateItem(created.id, formStateToPatch(withoutAttachment));

    expect(store.search("")[0].attachments).toEqual([]);
  });
});

describe("аккаунты внутри записи", () => {
  const row = (name: string, group?: string): FieldRow => ({
    key: name + (group ?? ""),
    name,
    value: "",
    secret: false,
    ...(group ? { group } : {}),
  });

  it("общие поля идут первым блоком, аккаунты - в порядке появления", () => {
    // Порядок именно появления, а не алфавитный: человек сам решил, что
    // записать сверху, и переставлять его записи мы не вправе.
    const groups = groupFieldRows([
      row("Сайт"),
      row("Логин", "Рабочая"),
      row("Логин", "Личная"),
      row("Заметка"),
    ]);
    expect(groups.map((g) => g.name)).toEqual([null, "Рабочая", "Личная"]);
    expect(groups[0].rows.map((r) => r.name)).toEqual(["Сайт", "Заметка"]);
  });

  it("не показывает пустой блок общих полей", () => {
    const groups = groupFieldRows([row("Логин", "A")]);
    expect(groups.map((g) => g.name)).toEqual(["A"]);
  });

  it("новый аккаунт получает свободное имя", () => {
    const rows = [row("Логин", "Аккаунт 1")];
    expect(nextAccountName(rows)).toBe("Аккаунт 2");
    expect(nextAccountName([])).toBe("Аккаунт 1");
  });

  it("добавление аккаунта заводит пару логин-пароль", () => {
    const rows = addAccountRows([], "Личная");
    expect(rows.map((r) => [r.name, r.secret, r.group])).toEqual([
      ["Логин", false, "Личная"],
      ["Пароль", true, "Личная"],
    ]);
  });

  it("переименование трогает только свой аккаунт", () => {
    const rows = [row("Логин", "A"), row("Логин", "B")];
    const renamed = renameAccount(rows, "A", "Рабочая");
    expect(renamed.map((r) => r.group)).toEqual(["Рабочая", "B"]);
  });

  it("пустое имя выносит поля из аккаунта, а не оставляет пустую строку", () => {
    // Иначе в базе появился бы `group: ""`, который ничего не значит, но
    // отличает запись от такой же без аккаунтов.
    const rows = renameAccount([row("Логин", "A")], "A", "   ");
    expect(rows[0].group).toBeUndefined();
  });

  it("удаление аккаунта убирает его поля", () => {
    const rows = removeAccount([row("Логин", "A"), row("Сайт")], "A");
    expect(rows.map((r) => r.name)).toEqual(["Сайт"]);
  });
});

describe("addAccountPressed", () => {
  const r = (name: string, secret = false, group?: string): FieldRow => ({
    key: name + (group ?? ""),
    name,
    value: "",
    secret,
    ...(group ? { group } : {}),
  });

  it("первое нажатие забирает заполненные поля в «Аккаунт 1» и заводит второй", () => {
    // Иначе получалась бессмыслица: только что заполненные поля аккаунтом не
    // считались, а первым аккаунтом называлась пустая заготовка.
    const rows = addAccountPressed([r("Логин"), r("Пароль", true), r("Сайт")]);
    const byGroup = rows.map((x) => [x.name, x.group]);
    expect(byGroup).toEqual([
      ["Логин", "Аккаунт 1"],
      ["Пароль", "Аккаунт 1"],
      // Адрес сайта общий для всех учёток сервиса, забирать его нельзя.
      ["Сайт", undefined],
      ["Логин", "Аккаунт 2"],
      ["Пароль", "Аккаунт 2"],
    ]);
  });

  it("на пустой записи заводит просто «Аккаунт 1»", () => {
    const rows = addAccountPressed([]);
    expect(rows.map((x) => x.group)).toEqual(["Аккаунт 1", "Аккаунт 1"]);
  });

  it("когда аккаунты уже есть, просто добавляет следующий", () => {
    const rows = addAccountPressed([r("Логин", false, "Личная")]);
    expect(rows.map((x) => x.group)).toEqual(["Личная", "Аккаунт 1", "Аккаунт 1"]);
  });
});
