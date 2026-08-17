# -*- coding: utf-8 -*-
"""Матрица контраста WCAG для монохромной палитры cryptodermo.

Порог для обычного текста 4.5:1, для крупного/жирного 3:1 (WCAG 2.1 AA).
Границы и декор порогов не имеют, но их отношение к фону всё равно полезно
видеть числом, а не на глаз.
"""
import sys

SURFACES = {
    "bg":       "#0a0c10",
    "surface":  "#12161d",
    "raised":   "#1a1f28",
    "hover":    "#212734",
    "selected": "#2b3342",
}

TEXTS = {
    "text-strong": "#f2f5fa",
    "text":        "#d8dee8",
    # Поднят с #8e99a9: на "selected" давал 4.40, ниже порога.
    "text-dim":    "#99a4b4",
    # Поднят с #6b7484 - декор, порога не имеет, но 2.19 было слишком мало.
    "text-faint":  "#6b7484",
    "warn":        "#e8b341",
    # Заменён с #e5484d: на raised/hover/selected давал 4.22/3.82/3.24.
    # Тёмно-красный не работает на тёмных поверхностях, нужен светлее.
    "danger":      "#ff7076",
    "focus":       "#e6eaf0",
}

# Текстовые роли, которые обязаны проходить 4.5:1 на всех поверхностях,
# где реально появляются. text-faint сюда не входит намеренно: это
# отключённое состояние и декор, не читаемый текст.
MUST_PASS = ["text-strong", "text", "text-dim", "warn", "danger"]


def srgb_to_lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(hex_color):
    h = hex_color.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) for i in (0, 2, 4))
    return 0.2126 * srgb_to_lin(r) + 0.7152 * srgb_to_lin(g) + 0.0722 * srgb_to_lin(b)


def contrast(fg, bg):
    l1, l2 = luminance(fg), luminance(bg)
    if l1 < l2:
        l1, l2 = l2, l1
    return (l1 + 0.05) / (l2 + 0.05)


def main():
    width = max(len(n) for n in TEXTS) + 2
    header = " " * width + "".join(f"{s:>11}" for s in SURFACES)
    print(header)
    print("-" * len(header))

    failures = []
    for tname, tcolor in TEXTS.items():
        row = f"{tname:<{width}}"
        for sname, scolor in SURFACES.items():
            ratio = contrast(tcolor, scolor)
            mark = " "
            if tname in MUST_PASS:
                if ratio < 4.5:
                    mark = "!"
                    failures.append((tname, sname, ratio))
                elif ratio < 7.0:
                    mark = "."
            row += f"{ratio:>10.2f}{mark}"
        print(row)

    print()
    print("Шаги между соседними поверхностями (различимость самих поверхностей):")
    names = list(SURFACES)
    for a, b in zip(names, names[1:]):
        print(f"  {a:>8} -> {b:<9} {contrast(SURFACES[a], SURFACES[b]):.3f}")

    print()
    if failures:
        print("НЕ ПРОХОДЯТ 4.5:1 (обязательные роли):")
        for tname, sname, ratio in failures:
            print(f"  {tname} на {sname}: {ratio:.2f}")
        sys.exit(1)
    print("Все обязательные роли проходят 4.5:1.")
    print("Легенда: ! ниже 4.5   . от 4.5 до 7.0 (AA, но не AAA)")


if __name__ == "__main__":
    main()
