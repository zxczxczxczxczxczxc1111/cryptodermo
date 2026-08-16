import { describe, expect, it } from "vitest";
import { computeVisibleRange } from "./List";

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
