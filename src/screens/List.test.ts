import { describe, expect, it } from "vitest";
import {
  computeVisibleRange,
  nextSelectionIndex,
  scrollTopToReveal,
  quickCopyField,
  shouldHijackCopy,
  LIST_PAGE_JUMP,
} from "./List";

// Шов виртуализации (R96.1): диапазон DOM-строк, которые реально
// рендерятся при заданной прокрутке, не должен зависеть от общего числа
// записей - иначе 5000+ записей рендерили бы тысячи узлов. Значения ниже
// посчитаны вручную по формуле из спецификации функции (floor/ceil от
// пикселей прокрутки), а не получены вызовом самой `computeVisibleRange` -
// иначе тест был бы согласен с кодом под тестом по построению.
describe("computeVisibleRange", () => {
  it("returns a small window around the scroll position, not the whole list", () => {
    // floor(640/64)=10, старт с запасом 8 => 2;
    // видимых строк ceil(1000/64)=16 + 2*8=16 => 32; конец = 2+32=34.
    const range = computeVisibleRange({
      scrollTop: 640,
      viewportHeight: 1000,
      rowHeight: 64,
      overscan: 8,
      totalCount: 5000,
    });
    expect(range).toEqual({ startIndex: 2, endIndex: 34 });
  });

  it("clamps the start of the range to 0 instead of going negative near the top", () => {
    // floor(0/64)=0, минус запас 2 ушёл бы в -2, но не может быть меньше 0;
    // видимых строк ceil(320/64)=5 + 2*2=4 => 9; конец = 0+9=9.
    const range = computeVisibleRange({
      scrollTop: 0,
      viewportHeight: 320,
      rowHeight: 64,
      overscan: 2,
      totalCount: 100,
    });
    expect(range).toEqual({ startIndex: 0, endIndex: 9 });
  });

  it("clamps the end of the range to totalCount instead of overshooting past the last row", () => {
    // floor(6000/64)=93, минус запас 3 => 90;
    // видимых строк ceil(500/64)=8 + 2*3=6 => 14, 90+14=104, но записей
    // всего 100 - конец не может быть больше totalCount.
    const range = computeVisibleRange({
      scrollTop: 6000,
      viewportHeight: 500,
      rowHeight: 64,
      overscan: 3,
      totalCount: 100,
    });
    expect(range).toEqual({ startIndex: 90, endIndex: 100 });
  });
});

describe("nextSelectionIndex", () => {
  it("двигает выделение вниз и вверх", () => {
    expect(nextSelectionIndex(0, "ArrowDown", 5)).toBe(1);
    expect(nextSelectionIndex(3, "ArrowUp", 5)).toBe(2);
  });

  it("упирается в края, а не зацикливается", () => {
    // В списке на сотню записей перескок с последней на первую читается как
    // сбой, а не как удобство.
    expect(nextSelectionIndex(4, "ArrowDown", 5)).toBe(4);
    expect(nextSelectionIndex(0, "ArrowUp", 5)).toBe(0);
  });

  it("из «ничего не выбрано» вниз ведёт к первой, вверх к последней", () => {
    expect(nextSelectionIndex(-1, "ArrowDown", 5)).toBe(0);
    expect(nextSelectionIndex(-1, "ArrowUp", 5)).toBe(4);
  });

  it("Home и End прыгают на края", () => {
    expect(nextSelectionIndex(2, "Home", 5)).toBe(0);
    expect(nextSelectionIndex(2, "End", 5)).toBe(4);
  });

  it("PageUp и PageDown идут постоянным шагом и не вылетают за границы", () => {
    expect(nextSelectionIndex(0, "PageDown", 50)).toBe(LIST_PAGE_JUMP);
    expect(nextSelectionIndex(0, "PageDown", 5)).toBe(4);
    expect(nextSelectionIndex(3, "PageUp", 50)).toBe(0);
  });

  it("молчит на посторонних клавишах и на пустом списке", () => {
    expect(nextSelectionIndex(0, "a", 5)).toBeNull();
    expect(nextSelectionIndex(0, "ArrowDown", 0)).toBeNull();
  });
});

describe("scrollTopToReveal", () => {
  const ROW = 48;
  const VIEW = 480; // ровно 10 строк

  it("не трогает прокрутку, если строка и так видна", () => {
    // Иначе список дёргался бы на каждое нажатие стрелки.
    expect(scrollTopToReveal(5, ROW, VIEW, 0)).toBe(0);
  });

  it("подтягивает строку снизу ровно настолько, чтобы она поместилась", () => {
    expect(scrollTopToReveal(10, ROW, VIEW, 0)).toBe(11 * ROW - VIEW);
  });

  it("поднимает к строке сверху", () => {
    expect(scrollTopToReveal(2, ROW, VIEW, 5 * ROW)).toBe(2 * ROW);
  });

  it("в окне ниже одной строки показывает её начало, а не конец", () => {
    // Сильно сжатое окно приложения: подтягивание к низу строки вытолкнуло бы
    // за экран её название, то есть ровно то, ради чего к ней переходят.
    expect(scrollTopToReveal(0, ROW, 20, 0)).toBe(0);
    expect(scrollTopToReveal(3, ROW, 20, 0)).toBe(3 * ROW);
  });
});

describe("quickCopyField", () => {
  const item = (fields: { name: string; value: string; secret: boolean }[]) =>
    ({ fields }) as never;

  it("берёт первое секретное поле", () => {
    const f = quickCopyField(
      item([
        { name: "Логин", value: "a", secret: false },
        { name: "Пароль", value: "b", secret: true },
      ]),
    );
    expect(f?.name).toBe("Пароль");
  });

  it("если секретных нет, берёт первое поле", () => {
    // Заметка без паролей: скопировать что-то полезнее, чем не копировать ничего.
    const f = quickCopyField(item([{ name: "Текст", value: "a", secret: false }]));
    expect(f?.name).toBe("Текст");
  });

  it("возвращает null у записи без полей", () => {
    expect(quickCopyField(item([]))).toBeNull();
  });
});

describe("shouldHijackCopy", () => {
  it("перехватывает Ctrl+C, когда ничего не выделено", () => {
    expect(shouldHijackCopy("")).toBe(true);
    expect(shouldHijackCopy(undefined)).toBe(true);
  });

  it("НЕ перехватывает, когда человек выделил текст", () => {
    // Подменить буфер паролем в этот момент значит украсть чужое действие.
    expect(shouldHijackCopy("выделенный текст")).toBe(false);
  });
});
