# -*- coding: utf-8 -*-
"""Матрица контраста WCAG для палитры cryptodermo.

Порог для обычного текста 4.5:1, для крупного/жирного 3:1 (WCAG 2.1 AA).

Текст задан белым с прозрачностью, а не сплошным цветом (тот же приём, что в
панели seattlehome). Поэтому цвет сначала СМЕШИВАЕТСЯ с поверхностью, под
которой лежит, и только потом считается контраст: без смешивания цифры были бы
неверные, причём в опасную сторону - завышенные.

Запускать после любой правки цвета:
    python designrevork/tools/contrast.py
"""
import sys

# Поверхности всегда непрозрачные.
SURFACES = {
    "bg":       "#000000",
    "rail":     "#080809",
    "surface":  "#0a0a0b",
    "elevated": "#0f0f10",
    "hover":    "#111113",
    "selected": "#1a1a1e",
}

# Текст и знаковые цвета. Число - альфа белого, строка - сплошной цвет.
TEXTS = {
    "text-strong":  0.92,
    "text":         0.72,
    "text-dim":     0.60,
    "text-muted":   0.46,
    "text-faint":   0.35,
    "focus":        0.90,
    "btn-primary":  0.89,
    "warn":         "#FBBF24",
    "danger":       "#F87171",
}

# Роли, обязанные проходить 4.5:1 на всех поверхностях, где появляются.
# text-faint и text-muted сюда не входят намеренно: это выключенные элементы,
# плейсхолдеры и декор, а не читаемый текст.
MUST_PASS = ["text-strong", "text", "text-dim", "warn", "danger"]

# Роли, которые оцениваются как крупный/нетекстовый элемент - порог 3:1.
NON_TEXT = ["focus", "btn-primary"]


def parse(color):
    """Вернуть (r, g, b, alpha). Число трактуется как белый с этой альфой."""
    if isinstance(color, (int, float)):
        return (255, 255, 255, float(color))
    h = color.lstrip("#")
    return (int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16), 1.0)


def composite(fg, bg):
    """Смешать полупрозрачный цвет с непрозрачной подложкой."""
    fr, fg_, fb, a = parse(fg)
    br, bg_, bb, _ = parse(bg)
    return (fr * a + br * (1 - a), fg_ * a + bg_ * (1 - a), fb * a + bb * (1 - a))


def srgb_to_lin(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def luminance(rgb):
    r, g, b = rgb
    return 0.2126 * srgb_to_lin(r) + 0.7152 * srgb_to_lin(g) + 0.0722 * srgb_to_lin(b)


def contrast(fg, bg):
    l1 = luminance(composite(fg, bg))
    l2 = luminance(composite(bg, bg))
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
        threshold = 3.0 if tname in NON_TEXT else 4.5
        checked = tname in MUST_PASS or tname in NON_TEXT
        row = f"{tname:<{width}}"
        for sname, scolor in SURFACES.items():
            ratio = contrast(tcolor, scolor)
            mark = " "
            if checked:
                if ratio < threshold:
                    mark = "!"
                    failures.append((tname, sname, ratio, threshold))
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
    print("Чёрный текст на светлой кнопке (инвертированная главная кнопка):")
    for state, alpha in (("обычная", 0.89), ("наведение", 0.78)):
        filled = composite(alpha, "#000000")
        l_btn = luminance(filled)
        ratio = (l_btn + 0.05) / (luminance((0, 0, 0)) + 0.05)
        print(f"  {state:<10} {ratio:.2f}")

    print()
    if failures:
        print("НЕ ПРОХОДЯТ порог:")
        for tname, sname, ratio, threshold in failures:
            print(f"  {tname} на {sname}: {ratio:.2f} при пороге {threshold}")
        sys.exit(1)
    print("Все проверяемые роли проходят свой порог.")
    print("Легенда: ! ниже порога   . от порога до 7.0")


if __name__ == "__main__":
    main()
