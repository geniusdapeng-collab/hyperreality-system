"""
区域编号检查图（标注确认关的呈阅产物）。

本地补丁（2026-09-27，T-2026-0926-0020，见 vendor/srt-whiteboard/VENDOR.md）：
上游实现把字体硬编码为 Windows 路径 `C:/Windows/Fonts/msyh.ttc`，在 macOS / Linux 上
直接抛 `OSError: cannot open resource`，标注确认关不可用。本补丁改为**跨平台字体解析**
（macOS / Linux / Windows 依次探测 + `WHITEBOARD_PREVIEW_FONT` 覆盖 + 位图字体兜底），
并把标签框夹到画布内，避免靠右区域的长标签越界。
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 各平台可用中文字体（按优先级；第一个能打开的即用）
FONT_CANDIDATES = (
    os.environ.get("WHITEBOARD_PREVIEW_FONT", ""),   # 部署方显式覆盖优先
    # macOS
    "/System/Library/Fonts/PingFang.ttc",
    "/System/Library/Fonts/STHeiti Medium.ttc",
    "/System/Library/Fonts/Hiragino Sans GB.ttc",
    "/Library/Fonts/Arial Unicode.ttf",
    # Linux
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    # Windows
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simhei.ttf",
)


def resolve_font(size: int):
    """按平台探测可用字体；全部失败时退回 Pillow 内置位图字体（不再中断渲染）。"""
    for candidate in FONT_CANDIDATES:
        if not candidate:
            continue
        try:
            return ImageFont.truetype(candidate, size)
        except OSError:
            continue
    print(
        "[warn] 未找到可用中文字体，退回内置位图字体（标签可能显示为方框）；"
        "可用 WHITEBOARD_PREVIEW_FONT=<ttf/ttc 路径> 指定。",
        file=sys.stderr,
    )
    try:
        return ImageFont.load_default(size=size)
    except TypeError:  # Pillow < 10 不支持 size 参数
        return ImageFont.load_default()


def _draw_centered(draw: ImageDraw.ImageDraw, xy, text: str, font, fill) -> None:
    """anchor 参数对位图字体不一定生效，失败时退化为左上角对齐。"""
    try:
        draw.text(xy, text, anchor="ma", font=font, fill=fill)
    except (ValueError, TypeError):
        draw.text(xy, text, font=font, fill=fill)


def _label_width(label: str, font) -> int:
    """标签像素宽度：优先用真实字形度量，退化为按字符类型估算。"""
    try:
        return int(font.getlength(label))
    except (AttributeError, TypeError):
        return sum(14 if ord(ch) > 0x2E80 else 8 for ch in label)


def main(image_path: str, annotation_path: str, output_path: str) -> None:
    image = Image.open(image_path).convert("RGBA")
    overlay = Image.new("RGBA", image.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    canvas_w, _canvas_h = image.size
    label_font = resolve_font(18)
    colors = [(38, 103, 255, 225), (255, 105, 92, 225), (41, 167, 102, 225), (181, 100, 255, 225)]

    data = json.loads(Path(annotation_path).read_text(encoding="utf-8"))
    for index, element in enumerate(data["elements"], start=1):
        region = element["region"]
        x, y = region["x"], region["y"]
        right, bottom = x + region["width"], y + region["height"]
        color = colors[(index - 1) % len(colors)]
        fill = (*color[:3], 24)
        draw.rounded_rectangle((x, y, right, bottom), radius=12, outline=color, width=4, fill=fill)
        draw.ellipse((x + 8, y + 8, x + 44, y + 44), fill=color)
        _draw_centered(draw, (x + 26, y + 10), str(index), label_font, "white")
        label = f"{index}. {element['label']}  {element['reveal']['direction']}"
        # 标签框夹到画布内（长标签 + 靠右区域会越界）
        label_w = _label_width(label, label_font)
        box_x0 = min(x + 52, max(8, canvas_w - label_w - 16))
        box_x1 = min(canvas_w - 8, box_x0 + label_w + 16)
        box_y1 = min(bottom, y + 46)
        draw.rounded_rectangle((box_x0, y + 8, box_x1, box_y1), radius=6, fill=(255, 255, 255, 225))
        draw.text((box_x0 + 8, min(y + 12, max(0, box_y1 - 22))), label, font=label_font, fill=color)
        start = tuple(element["handPath"]["start"])
        end = tuple(element["handPath"]["end"])
        draw.line((start, end), fill=color, width=4)
        draw.polygon((end, (end[0] - 13, end[1] - 7), (end[0] - 13, end[1] + 7)), fill=color)

    result = Image.alpha_composite(image, overlay).convert("RGB")
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    result.save(output_path, quality=95)


if __name__ == "__main__":
    main(*sys.argv[1:4])
