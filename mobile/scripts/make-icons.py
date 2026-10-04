#!/usr/bin/env python3
"""Сборка иконок Android из /assets репозитория (запускать из каталога mobile/).

Как устроен исходный значок assets/icon-1024.png:
  • градиентный квадрат со скруглёнными углами (синий -> фиолетовый);
  • «пузырь» сообщения — это ПРОЗРАЧНОЕ окно в квадрате (на белом фоне выглядит белым);
  • три точки внутри пузыря — непрозрачные (фирменный синий).

Что получается на выходе:
  • adaptive icon (Android 8+): фон — тот же градиент (vector drawable),
    передний план — белый пузырь с тремя фирменными точками (ic_launcher_foreground.png);
  • ic_launcher.png / ic_launcher_round.png для Android 7 и ниже — исходный значок,
    подложенный под белый фон (иначе прозрачный пузырь станет чёрным);
  • mobile/www/icon.png — тот же значок для экрана запуска.

Требуется Pillow + numpy/scipy. Иконки закоммичены, в CI скрипт не нужен.
"""
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw
from scipy import ndimage

ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / "assets"
MOBILE = ROOT / "mobile"
RES = MOBILE / "android" / "app" / "src" / "main" / "res"
WWW = MOBILE / "www"

DENSITIES = {"mdpi": 1, "hdpi": 1.5, "xhdpi": 2, "xxhdpi": 3, "xxxhdpi": 4}
DOT_COLOR_FALLBACK = (104, 104, 245)


def load_source() -> Image.Image:
    return Image.open(ASSETS / "icon-1024.png").convert("RGBA")


def bubble_masks(src: Image.Image):
    """Возвращает (маска пузыря целиком, маска точек) в размере исходника."""
    alpha = np.asarray(src.getchannel("A"))
    transparent = alpha == 0
    # прозрачный фон по краям соединяется с границей картинки, а «окно» пузыря — нет:
    # заливка пустоты «от края» отделяет окно от внешнего фона
    outside = np.zeros_like(transparent)
    outside[0, :] = outside[-1, :] = outside[:, 0] = outside[:, -1] = True
    outside &= transparent
    # растушёвка: сначала помечаем всё, что связано с краем
    labelled, _ = ndimage.label(transparent | ~transparent)  # единый фон, только для формы ниже
    del labelled
    outside = ndimage.binary_propagation(outside, mask=transparent)
    bubble = transparent & ~outside          # «окно» пузыря
    silhouette = ndimage.binary_fill_holes(bubble)  # пузырь целиком, вместе с точками
    dots = silhouette & ~bubble & (alpha > 128)
    return silhouette, dots


def white_mark(src: Image.Image, silhouette: np.ndarray, dots: np.ndarray) -> Image.Image:
    """Белый пузырь с фирменными точками, на прозрачном фоне."""
    alpha = np.asarray(src.getchannel("A"))
    soft = np.where(silhouette, 255 - alpha, 0).astype(np.uint8)

    mark = Image.new("RGBA", src.size, (255, 255, 255, 0))
    mark.putalpha(Image.fromarray(soft, "L"))
    dot_rgb = src.getpixel((src.width // 2, src.height // 2))[:3]
    if sum(dot_rgb) > 600:  # на всякий случай: середина пузыря должна быть точкой, а не фоном
        dot_rgb = DOT_COLOR_FALLBACK
    dot_layer = Image.new("RGBA", src.size, dot_rgb + (255,))
    dot_alpha = Image.new("L", src.size, 0)
    dot_alpha.paste(Image.fromarray((dots * 255).astype(np.uint8)), (0, 0))
    dot_layer.putalpha(dot_alpha)
    return Image.alpha_composite(mark, dot_layer)


def square_on_white(src: Image.Image, size: int) -> Image.Image:
    """Исходный значок на белом фоне (для старых Android и экрана запуска)."""
    plate = Image.new("RGBA", src.size, (255, 255, 255, 255))
    flat = Image.alpha_composite(plate, src)
    return flat.resize((size, size), Image.LANCZOS)


def round_on_white(src: Image.Image, size: int) -> Image.Image:
    big = square_on_white(src, size * 4)
    mask = Image.new("L", (size * 4, size * 4), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size * 4 - 1, size * 4 - 1), fill=255)
    out = Image.new("RGBA", (size * 4, size * 4), (0, 0, 0, 0))
    out.paste(big, (0, 0), mask)
    return out.resize((size, size), Image.LANCZOS)


def place_mark(mark: Image.Image, size: int) -> Image.Image:
    """Вписывает пузырь в холст адаптивной иконки (безопасная зона ~60%)."""
    box = mark.getbbox() or (0, 0, mark.width, mark.height)
    mark = mark.crop(box)
    core = max(1, round(size * 0.60))
    scale = min(core / mark.width, core / mark.height)
    scaled = mark.resize(
        (max(1, round(mark.width * scale)), max(1, round(mark.height * scale))),
        Image.LANCZOS,
    )
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(scaled, ((size - scaled.width) // 2, (size - scaled.height) // 2), scaled)
    return canvas


def write_adaptive_xml() -> None:
    src = load_source()
    rgba = np.asarray(src)
    left = tuple(int(v) for v in rgba[150, 150, :3])
    right = tuple(int(v) for v in rgba[810, 810, :3])

    def hex_(rgb):
        return "#%02X%02X%02X" % rgb

    (RES / "drawable").mkdir(parents=True, exist_ok=True)
    (RES / "drawable" / "ic_launcher_background.xml").write_text(
        f"""<?xml version="1.0" encoding="utf-8"?>
<!-- Фон адаптивной иконки «Контура»: фирменный градиент {hex_(left)} -> {hex_(right)}
     (сгенерировано mobile/scripts/make-icons.py, менять руками не нужно). -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="108"
    android:viewportHeight="108">
    <path android:pathData="M0,0h108v108h-108z">
        <aapt:attr name="android:fillColor">
            <gradient
                android:type="linear"
                android:startX="0" android:startY="0"
                android:endX="108" android:endY="108">
                <item android:offset="0" android:color="{hex_(left)}" />
                <item android:offset="1" android:color="{hex_(right)}" />
            </gradient>
        </aapt:attr>
    </path>
</vector>
""",
        encoding="utf-8",
    )
    print(f"  drawable/ic_launcher_background.xml: градиент {hex_(left)} -> {hex_(right)}")

    for name in ("ic_launcher.xml", "ic_launcher_round.xml"):
        (RES / "mipmap-anydpi-v26" / name).write_text(
            """<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@drawable/ic_launcher_background"/>
    <foreground android:drawable="@mipmap/ic_launcher_foreground"/>
</adaptive-icon>
""",
            encoding="utf-8",
        )
        print(f"  mipmap-anydpi-v26/{name}: обновлён")


def main() -> None:
    src = load_source()
    silhouette, dots = bubble_masks(src)
    mark = white_mark(src, silhouette, dots)

    print("Значки приложения «Контур»:")
    for density, scale in DENSITIES.items():
        folder = RES / f"mipmap-{density}"
        folder.mkdir(parents=True, exist_ok=True)
        legacy = round(48 * scale)
        adaptive = round(108 * scale)

        square_on_white(src, legacy).save(folder / "ic_launcher.png")
        round_on_white(src, legacy).save(folder / "ic_launcher_round.png")
        place_mark(mark, adaptive).save(folder / "ic_launcher_foreground.png")
        print(f"  mipmap-{density}: ic_launcher {legacy}px, передний план {adaptive}px")

    write_adaptive_xml()

    WWW.mkdir(parents=True, exist_ok=True)
    square_on_white(src, 256).save(WWW / "icon.png")
    print("  www/icon.png: 256px")


if __name__ == "__main__":
    main()
