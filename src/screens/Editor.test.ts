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
