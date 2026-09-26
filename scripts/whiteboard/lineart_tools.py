#!/usr/bin/env python3
"""
白板引擎·本仓扩展工具（T-2026-0926-0020）

上游 `vendor/srt-whiteboard` 只做「一张线稿 + 一份标注 → 一段 MP4」。线稿怎么来、
区域坐标怎么定、风格合不合规，上游交给 Agent。本文件把这四件事**确定性化**，
供 `apps/server/src/video/whiteboard/**` 调用：

  sketch   照片/实拍图 → 暖米黄纸底线稿（零模型成本路径，规格 §2.4 路径 B）
  analyze  线稿 → 候选元素区域（连通域 + 确定性聚合；规格 §2.5 第 1/3 步的 ground truth）
  check    线稿 → 风格机检三道（纸底颜色 / 深色块占比 / 连通域数；规格 §2.4 机检）
  hand     生成中性白板「执笔手」素材（本仓自有素材，替换上游带作者标识的 drawing-hand.png）

统一约定：
  · 所有输出到 stdout 的都是**一行 JSON**（`{"ok":true,...}` / `{"ok":false,"error":"..."}`），
    供 Node 侧 JSON.parse；人类可读信息走 stderr。
  · 退出码：0 成功；1 业务失败（见 stdout.error）；2 用法错误。
  · 不联网、不读任何凭证；纯本地确定性计算（同输入同输出）。

依赖（由 vendor/srt-whiteboard/.venv 提供）：opencv-python / numpy / Pillow。
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import cv2
import numpy as np

# 白板视觉规范（上游 SKILL.md「统一出图视觉规范」）
PAPER_HEX = "#F5EBD7"
PAPER_RGB = (245, 235, 215)


def _paper_bgr() -> np.ndarray:
    r, g, b = PAPER_RGB
    return np.array([b, g, r], dtype=np.uint8)


def _imread_any(path: str | Path, flags: int = cv2.IMREAD_COLOR) -> np.ndarray | None:
    """兼容非 ASCII 路径的读取（与上游 stream_render._imread_any 同口径）。"""
    raw = np.fromfile(str(path), dtype=np.uint8)
    if raw.size == 0:
        return None
    return cv2.imdecode(raw, flags)


def _imwrite_any(path: str | Path, image: np.ndarray) -> None:
    """兼容非 ASCII 路径的写入。"""
    out = Path(path)
    out.parent.mkdir(parents=True, exist_ok=True)
    ok, buf = cv2.imencode(out.suffix or ".png", image)
    if not ok:
        raise RuntimeError(f"图像编码失败：{out}")
    buf.tofile(str(out))


def _emit(payload: dict) -> None:
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")


def _fail(message: str, code: int = 1) -> int:
    _emit({"ok": False, "error": message})
    print(f"[err] {message}", file=sys.stderr)
    return code


# ──────────────────────────────────────────────────────────────
# ① sketch：实拍图 → 暖米黄纸底线稿
# ──────────────────────────────────────────────────────────────
def cmd_sketch(args: argparse.Namespace) -> int:
    src = _imread_any(args.input)
    if src is None:
        return _fail(f"无法读取图片：{args.input}")

    # 统一长边（线稿越干净，白板笔迹越贴合）
    h0, w0 = src.shape[:2]
    scale = args.long_edge / max(h0, w0)
    if abs(scale - 1.0) > 1e-3:
        interp = cv2.INTER_AREA if scale < 1 else cv2.INTER_CUBIC
        src = cv2.resize(src, (max(1, int(round(w0 * scale))), max(1, int(round(h0 * scale)))),
                         interpolation=interp)
    h, w = src.shape[:2]

    gray = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY)
    # 双边滤波：磨掉纹理但保住边缘（照片转线稿的关键一步）
    smooth = cv2.bilateralFilter(gray, 9, 60, 60)
    # 自适应阈值 → 反色，得到"墨线"
    blocks = max(15, (min(h, w) // 12) | 1)
    ink = cv2.adaptiveThreshold(smooth, 255, cv2.ADAPTIVE_THRESH_MEAN_C,
                                cv2.THRESH_BINARY, blocks, args.offset)
    ink = cv2.bitwise_not(ink)
    # 去除孤立噪点（照片纹理会产生雪花）
    ink = cv2.medianBlur(ink, 3)
    kernel = np.ones((2, 2), np.uint8)
    ink = cv2.dilate(ink, kernel, iterations=1)
    # 归一化到倍率阈值：太浅的线丢掉（白板笔迹必须是可读的深灰线）
    ink = cv2.normalize(ink, None, 0, 255, cv2.NORM_MINMAX)
    if args.ink_ratio > 0:
        keep = np.percentile(ink[ink > 0], 100 * (1 - args.ink_ratio)) if np.any(ink > 0) else 255
        ink = np.where(ink >= keep, ink, 0).astype(np.uint8)

    # 合成到纸底：墨线用深灰（不纯黑，贴合上游"深灰色素描线条"）
    paper = np.zeros((h, w, 3), dtype=np.uint8)
    paper[:, :] = _paper_bgr()
    ink_norm = (ink.astype(np.float32) / 255.0)[:, :, None]
    line_color = np.array([70, 74, 82], dtype=np.float32)   # BGR ≈ #524A46 反向：深灰
    out = paper.astype(np.float32) * (1 - ink_norm) + line_color * ink_norm
    out = out.astype(np.uint8)

    # 留白边距（上游规范：充足留白）——整幅按比例内缩，边缘补纸底
    margin = int(round(min(h, w) * args.margin_ratio))
    if margin > 0:
        canvas = np.zeros((h, w, 3), dtype=np.uint8)
        canvas[:, :] = _paper_bgr()
        inner = cv2.resize(out, (w - 2 * margin, h - 2 * margin), interpolation=cv2.INTER_AREA)
        canvas[margin:h - margin, margin:w - margin] = inner
        out = canvas

    _imwrite_any(args.output, out)
    _emit({"ok": True, "output": str(Path(args.output).resolve()), "width": w, "height": h,
           "inkRatio": round(float(np.count_nonzero(ink) / (h * w)), 5)})
    return 0


# ──────────────────────────────────────────────────────────────
# ② analyze：线稿 → 候选元素区域（确定性）
# ──────────────────────────────────────────────────────────────
def _ink_mask(image: np.ndarray, quantile: float = 0.06) -> np.ndarray:
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    # 纸底是亮色，墨线是暗色；用分位数自适应取阈值，避免绝对阈值在不同图上漂移
    thr = float(np.quantile(gray, quantile))
    mask = (gray <= thr).astype(np.uint8) * 255
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))


def _components(mask: np.ndarray, min_area_ratio: float) -> list[dict]:
    count, labels, stats, _centroids = cv2.connectedComponentsWithStats(mask, connectivity=8)
    h, w = mask.shape[:2]
    min_area = max(24.0, min_area_ratio * h * w)
    boxes: list[dict] = []
    for label in range(1, count):
        x, y, bw, bh, area = stats[label]
        if area < min_area:
            continue
        boxes.append({"x": int(x), "y": int(y), "width": int(bw), "height": int(bh),
                      "area": int(area)})
    return boxes


def _merge_to_k(boxes: list[dict], k: int, canvas_w: int, canvas_h: int) -> list[dict]:
    """
    把候选连通域确定性聚成恰好 k 个区域（规格 §2.5 第 3 步"区域精确化"）。

    算法：层次聚类的简化版——每轮合并"中心距最近"的两个簇，直到簇数 = k。
    距离相同的并列项按 (x, y) 字典序打破，保证同一输入永远得到同一结果。
    """
    clusters = [dict(b) for b in boxes]
    while len(clusters) > k and len(clusters) > 1:
        best: tuple[float, int, int] | None = None
        for i in range(len(clusters)):
            for j in range(i + 1, len(clusters)):
                a, b = clusters[i], clusters[j]
                ax, ay = a["x"] + a["width"] / 2, a["y"] + a["height"] / 2
                bx, by = b["x"] + b["width"] / 2, b["y"] + b["height"] / 2
                dist = math.hypot(ax - bx, ay - by)
                key = (dist, i, j)
                if best is None or key < best:
                    best = key
        assert best is not None
        i, j = best[1], best[2]
        a, b = clusters[i], clusters[j]
        x0, y0 = min(a["x"], b["x"]), min(a["y"], b["y"])
        x1 = max(a["x"] + a["width"], b["x"] + b["width"])
        y1 = max(a["y"] + a["height"], b["y"] + b["height"])
        clusters[i] = {"x": x0, "y": y0, "width": x1 - x0, "height": y1 - y0,
                       "area": a["area"] + b["area"]}
        clusters.pop(j)
    for c in clusters:
        c["x"] = max(0, min(canvas_w - 1, c["x"]))
        c["y"] = max(0, min(canvas_h - 1, c["y"]))
        c["width"] = max(1, min(canvas_w - c["x"], c["width"]))
        c["height"] = max(1, min(canvas_h - c["y"], c["height"]))
    return clusters


def _expand(box: dict, pad: int, canvas_w: int, canvas_h: int) -> dict:
    x0 = max(0, box["x"] - pad)
    y0 = max(0, box["y"] - pad)
    x1 = min(canvas_w, box["x"] + box["width"] + pad)
    y1 = min(canvas_h, box["y"] + box["height"] + pad)
    return {"x": int(x0), "y": int(y0), "width": int(x1 - x0), "height": int(y1 - y0)}


def cmd_analyze(args: argparse.Namespace) -> int:
    image = _imread_any(args.input)
    if image is None:
        return _fail(f"无法读取线稿：{args.input}")
    h, w = image.shape[:2]
    mask = _ink_mask(image)
    boxes = _components(mask, args.min_area_ratio)
    if not boxes:
        return _fail("线稿中没有检测到墨迹连通域（图可能是空纸底）")

    boxes.sort(key=lambda b: (-b["area"], b["y"], b["x"]))
    k = args.k or min(len(boxes), args.max_regions)
    k = max(1, min(k, len(boxes)))
    clusters = _merge_to_k(boxes, k, w, h)

    if args.order == "reading":
        # 阅读顺序：先上后下（行高容差），再左到右 —— 与"场景铺垫→主体→动作→反应"的
        # 叙事拆分天然相容，也是人类看白板时的自然顺序。
        row_tol = max(h / max(k, 1) * 0.6, h * 0.15)
        clusters.sort(key=lambda c: (round((c["y"] + c["height"] / 2) / row_tol), c["x"]))
    elif args.order == "horizontal":
        clusters.sort(key=lambda c: c["x"])
    elif args.order == "area":
        clusters.sort(key=lambda c: -c["area"])

    regions = [_expand(c, args.padding, w, h) for c in clusters]
    _emit({
        "ok": True,
        "canvas": {"width": w, "height": h},
        "candidates": len(boxes),
        "regions": regions,
        # 墨迹总量：标注侧用于判断"线稿是否过空"，也便于排障
        "inkPixels": int(np.count_nonzero(mask)),
        "inkRatio": round(float(np.count_nonzero(mask) / (w * h)), 5),
    })
    return 0


# ──────────────────────────────────────────────────────────────
# ③ check：线稿风格机检三道（规格 §2.4）
# ──────────────────────────────────────────────────────────────
def cmd_check(args: argparse.Namespace) -> int:
    image = _imread_any(args.input)
    if image is None:
        return _fail(f"无法读取线稿：{args.input}")
    h, w = image.shape[:2]
    checks: list[dict] = []

    # ① 背景主色 ∈ #F5EBD7 ± 8%：取四角内缩块的中位数
    m = max(3, min(h, w) // 40)
    corners = np.concatenate([
        image[:m, :m].reshape(-1, 3), image[:m, -m:].reshape(-1, 3),
        image[-m:, :m].reshape(-1, 3), image[-m:, -m:].reshape(-1, 3),
    ])
    bg_bgr = np.median(corners, axis=0)
    bg_rgb = bg_bgr[::-1]
    target = np.array(PAPER_RGB, dtype=np.float64)
    tolerance = target * 0.08
    bg_ok = bool(np.all(np.abs(bg_rgb - target) <= tolerance))
    checks.append({
        "id": "paper_color", "pass": bg_ok,
        "detail": f"四角背景主色 #{int(bg_rgb[0]):02X}{int(bg_rgb[1]):02X}{int(bg_rgb[2]):02X}"
                  f"（目标 #{PAPER_HEX}±8%）",
    })

    # ② 无大面积深色块：灰度 < 100 的像素占比
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    dark_ratio = float(np.count_nonzero(gray < 100) / (h * w))
    checks.append({
        "id": "dark_area", "pass": dark_ratio <= args.max_dark_ratio,
        "detail": f"深色像素占比 {dark_ratio:.2%}（上限 {args.max_dark_ratio:.0%}）",
    })

    # ③ 连通域数量 ∈ [min, max]：过少=画面空洞，过多=画面杂乱
    mask = _ink_mask(image)
    count, _labels, stats, _c = cv2.connectedComponentsWithStats(mask, connectivity=8)
    min_area = max(24.0, 0.0004 * h * w)
    comps = sum(1 for i in range(1, count) if stats[i][4] >= min_area)
    checks.append({
        "id": "component_count", "pass": args.min_components <= comps <= args.max_components,
        "detail": f"连通域 {comps} 个（要求 {args.min_components}–{args.max_components}）",
    })

    ok = all(c["pass"] for c in checks)
    _emit({"ok": ok, "checks": checks,
           "metrics": {"background": "#%02X%02X%02X" % tuple(int(v) for v in bg_rgb),
                       "darkRatio": round(dark_ratio, 5), "components": comps}})
    return 0 if ok else 1


# ──────────────────────────────────────────────────────────────
# ④ hand：生成中性「执笔手」素材（本仓自有，无第三方标识）
# ──────────────────────────────────────────────────────────────
def cmd_hand(args: argparse.Namespace) -> int:
    """
    画一支记号笔 + 握笔手，**笔尖落在画布 (0,0)**（与上游 drawing-hand.png 的裁剪口径一致，
    渲染器 tip_anchor=(0,0) 直接可用）。

    为什么不用上游素材：上游笔杆印着作者渠道标识（"江哥是老登啊"），
    出现在 WorkLoom 对外销售片里不合适；本素材为本仓程序化生成的自有素材。
    """
    from PIL import Image, ImageDraw

    # 设计坐标系（1000×1600），最后统一乘 --scale 输出。
    # 比例口径：渲染器把素材高度缩到 target_hand_height=493px，
    # 因此"画面里露出的笔杆长度 / 手的大小"由下面这组设计常量决定。
    DESIGN_W, DESIGN_H = 1000.0, 1600.0
    scale = max(0.1, float(args.scale))
    W, H = int(round(DESIGN_W * scale)), int(round(DESIGN_H * scale))
    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    angle = math.radians(34)               # 笔轴：从笔尖 (0,0) 指向右下
    dx, dy = math.sin(angle), math.cos(angle)

    def at(along: float, across: float = 0.0) -> tuple[float, float]:
        """笔轴坐标（沿轴距离, 垂直偏移，设计单位）→ 画布像素。"""
        px = along * dx - across * dy
        py = along * dy + across * dx
        return (px * scale, py * scale)

    def w_(width: float) -> int:
        return max(1, int(round(width * scale)))

    skin = (242, 205, 178, 255)
    skin_shadow = (219, 178, 152, 255)
    outline = (120, 96, 80, 255)
    body_light = (236, 238, 241, 255)
    body_dark = (196, 202, 210, 255)
    cap = (86, 96, 110, 255)
    ink = (58, 62, 70, 255)

    # ── 笔：从笔尖到笔尾 ──
    nib_len, body_end, cap_end = 46.0, 980.0, 1042.0
    nib_half = 15.0
    nib = [at(0), at(nib_len, -nib_half), at(nib_len, nib_half)]
    d.polygon(nib, fill=ink)
    d.line([at(0), at(nib_len, -nib_half)], fill=(30, 32, 38, 255), width=w_(2))
    d.line([at(0), at(nib_len, nib_half)], fill=(30, 32, 38, 255), width=w_(2))

    d.polygon([at(nib_len, -17), at(body_end, -17), at(body_end, 17), at(nib_len, 17)],
              fill=body_light)
    # 笔杆侧边阴影 + 高光，做出圆杆感
    d.polygon([at(nib_len, 5), at(body_end, 5), at(body_end, 17), at(nib_len, 17)], fill=body_dark)
    d.line([at(nib_len, -17), at(body_end, -17), at(body_end, 17), at(nib_len, 17)],
           fill=outline, width=w_(2))
    d.polygon([at(body_end, -17), at(cap_end, -17), at(cap_end, 17), at(body_end, 17)], fill=cap)
    d.line([at(body_end, -17), at(cap_end, -17), at(cap_end, 17), at(body_end, 17)],
           fill=(52, 60, 72, 255), width=w_(2))

    # ── 手：在"笔杆竖直"的局部坐标系里画握拳，再整体旋转贴合笔轴 ──
    # 为什么绕这一圈：直接在斜轴坐标系里画指节，折线会歪成乱纹（试过，观感很差）；
    # 局部坐标系里竖向画拳 + 一次仿射旋转，才能得到干净的握笔手。
    LAYER_W, LAYER_H = 1100, 900          # 局部层（留足旋转余量，避免 expand=False 裁角）
    CX, CY = 550.0, 430.0                 # 旋转中心 = 局部层里笔杆所在位置
    hand_layer = Image.new("RGBA", (LAYER_W, LAYER_H), (0, 0, 0, 0))
    hd = ImageDraw.Draw(hand_layer)
    pen_x = CX                            # 局部坐标系里的笔杆（竖直）

    # 手腕（先画，被拳头压住一半）
    hd.rounded_rectangle([pen_x - 235, CY - 30, pen_x + 235, CY + 470], radius=170,
                         fill=skin, outline=outline, width=6)
    # 拳心
    fist = [pen_x - 330, CY - 240, pen_x + 330, CY + 240]
    hd.rounded_rectangle(fist, radius=190, fill=skin, outline=outline, width=7)
    # 四指指节：竖向折线，从拳顶向下收
    for offset in (-235, -120, 0, 120, 235):
        hd.line([(pen_x + offset, CY - 160), (pen_x + offset * 1.06, CY + 40)],
                fill=outline, width=5)
    # 拇指：横跨笔杆的一节，压在食指之上
    hd.rounded_rectangle([pen_x - 300, CY - 205, pen_x + 60, CY - 90], radius=52,
                         fill=skin_shadow, outline=outline, width=6)

    # 旋转到笔轴方向：局部坐标系里笔杆竖直，画布上笔轴顺时针偏 34°
    rotated = hand_layer.rotate(-math.degrees(angle), resample=Image.BICUBIC,
                                center=(CX, CY))
    # 拳心贴在笔杆的这个位置：必须离笔尖足够远，画面里才看得到一段"正在书写"的笔杆
    target = at(800)
    img.alpha_composite(rotated, (int(round(target[0] - CX)), int(round(target[1] - CY))))
    d = ImageDraw.Draw(img)

    out = Path(args.output)
    out.parent.mkdir(parents=True, exist_ok=True)
    img.save(out)
    _emit({"ok": True, "output": str(out.resolve()), "width": W, "height": H,
           "tipAnchor": [0, 0]})
    return 0


# ──────────────────────────────────────────────────────────────
# CLI
# ──────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="白板引擎·本仓扩展工具")
    sub = p.add_subparsers(dest="command", required=True)

    s = sub.add_parser("sketch", help="实拍图 → 暖米黄纸底线稿")
    s.add_argument("--in", dest="input", required=True)
    s.add_argument("--out", dest="output", required=True)
    s.add_argument("--long-edge", type=int, default=1920)
    s.add_argument("--offset", type=int, default=9, help="自适应阈值偏移（越大线越少）")
    s.add_argument("--ink-ratio", type=float, default=0.22, help="保留最强墨线的比例（0=全保留）")
    s.add_argument("--margin-ratio", type=float, default=0.03, help="留白边距占短边比例")
    s.set_defaults(func=cmd_sketch)

    a = sub.add_parser("analyze", help="线稿 → 候选元素区域")
    a.add_argument("--in", dest="input", required=True)
    a.add_argument("-k", type=int, default=0, help="目标区域数（0 = 取前 max-regions 个）")
    a.add_argument("--max-regions", type=int, default=6)
    a.add_argument("--min-area-ratio", type=float, default=0.0006)
    a.add_argument("--padding", type=int, default=18)
    a.add_argument("--order", choices=["reading", "horizontal", "area"], default="reading")
    a.set_defaults(func=cmd_analyze)

    c = sub.add_parser("check", help="线稿风格机检三道")
    c.add_argument("--in", dest="input", required=True)
    c.add_argument("--max-dark-ratio", type=float, default=0.12)
    c.add_argument("--min-components", type=int, default=2)
    c.add_argument("--max-components", type=int, default=60)
    c.set_defaults(func=cmd_check)

    h = sub.add_parser("hand", help="生成中性执笔手素材")
    h.add_argument("--out", dest="output", required=True)
    h.add_argument("--scale", type=float, default=1.0)
    h.set_defaults(func=cmd_hand)

    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    try:
        return int(args.func(args))
    except Exception as err:  # noqa: BLE001 —— CLI 边界统一转成一行 JSON，避免 Node 侧只看到堆栈
        return _fail(f"{type(err).__name__}: {err}")


if __name__ == "__main__":
    sys.exit(main())
