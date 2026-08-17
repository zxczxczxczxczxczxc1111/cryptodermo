import { describe, expect, it, vi } from "vitest";
import { RecentList, type RecentListItem } from "./RecentList";

/**
 * Проект без jsdom/happy-dom (R31 - не ставить новую зависимость ради
 * одного шва, см. тот же принцип в RecordCard.test.ts/LockScreen.tsx) - этот
 * компонент нельзя отрендерить в реальный DOM и симулировать клик мышью.
 *
 * Вместо этого функциональный компонент вызывается НАПРЯМУЮ как обычная
 * функция - `RecentList({...})` возвращает не смонтированный DOM, а обычное
 * дерево React-элементов (простые JS-объекты `{type, props, ...}`, как их
 * строит `React.createElement`/JSX-рантайм) - никакого ReactDOM для этого не
 * нужно. `findByClassName` ниже обходит это дерево и достаёт реальный проп
 * `onClick`, который React повесил бы на `<button>` - вызывая его напрямую,
 * тест проверяет ту же связку "клик -> колбэк с id", что видел бы
 * пользователь, просто без фактического DOM-события.
 */
function findByClassName(node: unknown, className: string): { props: Record<string, unknown> } | null {
  if (node == null || typeof node !== "object") return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findByClassName(child, className);
      if (found) return found;
    }
    return null;
  }
  const el = node as { props?: Record<string, unknown> };
  if (typeof el.props?.className === "string" && el.props.className.split(" ").includes(className)) {
    return el as { props: Record<string, unknown> };
  }
  if (el.props) {
    return findByClassName(el.props.children, className);
  }
  return null;
}

function makeItem(overrides: Partial<RecentListItem> = {}): RecentListItem {
  return {
    id: "item-1",
    title: "Test item",
    typeLabel: "Пароль",
    relativeTime: "только что",
    ...overrides,
  };
}

describe("RecentList: клик по строке -> onSelect(id) (R64/R65 + новый onSelect)", () => {
  it("renders each row as a real <button> when onSelect is provided, and clicking it calls onSelect with the item's id", () => {
    const onSelect = vi.fn();
    const items = [makeItem({ id: "abc-123", title: "Gmail" })];

    const tree = RecentList({ items, onSelect });

    const button = findByClassName(tree, "recent-list__row--btn");
    expect(button).not.toBeNull();
    expect(typeof button!.props.onClick).toBe("function");

    (button!.props.onClick as () => void)();

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith("abc-123");
  });

  it("calls onSelect with the correct id when there are multiple rows", () => {
    const onSelect = vi.fn();
    const items = [makeItem({ id: "first" }), makeItem({ id: "second" }), makeItem({ id: "third" })];

    const tree = RecentList({ items, onSelect });

    // Собрать ВСЕ строки-кнопки, не только первую совпавшую -
    // findByClassName выше нарочно возвращает первое совпадение (нужно для
    // теста выше), здесь нужен полный список, поэтому свой обходчик.
    function collectButtons(node: unknown, acc: { props: Record<string, unknown> }[]): void {
      if (node == null || typeof node !== "object") return;
      if (Array.isArray(node)) {
        node.forEach((child) => collectButtons(child, acc));
        return;
      }
      const el = node as { props?: Record<string, unknown> };
      if (typeof el.props?.className === "string" && el.props.className.split(" ").includes("recent-list__row--btn")) {
        acc.push(el as { props: Record<string, unknown> });
      }
      if (el.props) collectButtons(el.props.children, acc);
    }

    const buttons: { props: Record<string, unknown> }[] = [];
    collectButtons(tree, buttons);
    expect(buttons).toHaveLength(3);

    (buttons[1].props.onClick as () => void)();
    expect(onSelect).toHaveBeenCalledWith("second");
  });

  it("does not render a <button> (row stays non-interactive) when onSelect is not provided", () => {
    const items = [makeItem()];

    const tree = RecentList({ items });

    const button = findByClassName(tree, "recent-list__row--btn");
    expect(button).toBeNull();
    // Строка всё ещё рендерится, просто как обычный <div>, не <button>.
    const row = findByClassName(tree, "recent-list__row");
    expect(row).not.toBeNull();
  });
});
