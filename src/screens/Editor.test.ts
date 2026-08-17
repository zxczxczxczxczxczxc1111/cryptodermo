import { describe, expect, it } from "vitest";
import { VaultStore } from "../lib/vaultStore";
import {
  ITEM_TYPES,
  ITEM_TYPE_LABELS,
  SAVE_LABEL,
  SAVED_LABEL,
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
