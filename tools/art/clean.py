"""
贴图后处理：抠背景 → 去空白边 → 缩放 → 输出到 public/art/。

为什么要脚本而不是手工：模型出图一定带背景，而且主体占比每张都不一样。
游戏里贴图必须**透明 + 主体撑满画布 + 统一尺寸**，否则同一批怪有的巨大有的微小。

算法（不依赖任何模型，纯 Pillow）：
1. 取四角像素中位色作为背景色；
2. 从四条边做 flood fill，把"与背景色接近且连通到边缘"的像素设成全透明
   —— 用连通性而不是全图色差，避免把怪物身上的深色部分一起抠掉；
3. 按 alpha 通道求包围盒裁掉空白；
4. 等比缩放到目标边长，贴到正方形画布的中央（留 6% 边距）；
5. 保存 PNG。

用法：
    python tools/art/clean.py                      # 处理 plan 里所有 raw
    python tools/art/clean.py --only slime,ghost
    python tools/art/clean.py --size 256 --tolerance 26
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import deque
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
RAW_DIR = ROOT / "art" / "raw"
OUT_DIR = ROOT / "public" / "art"
PLAN = ROOT / "tools" / "media" / "plans" / "monsters.json"


def background_color(img: Image.Image) -> tuple[int, int, int]:
    """四角 12x12 区域的中位色 —— 比单点取样稳，能躲过角落的水印。"""
    w, h = img.size
    samples: list[tuple[int, int, int]] = []
    for ox, oy in ((0, 0), (w - 12, 0), (0, h - 12), (w - 12, h - 12)):
        for x in range(ox, ox + 12):
            for y in range(oy, oy + 12):
                pixel = img.getpixel((x, y))
                samples.append((pixel[0], pixel[1], pixel[2]))
    samples.sort(key=lambda c: c[0] + c[1] + c[2])
    return samples[len(samples) // 2]


def key_out_background(img: Image.Image, tolerance: int) -> Image.Image:
    """边缘连通 flood fill 抠图，返回 RGBA。"""
    img = img.convert("RGBA")
    w, h = img.size
    br, bg, bb = background_color(img)
    pixels = img.load()
    visited = bytearray(w * h)
    queue: deque[tuple[int, int]] = deque()

    def close_enough(x: int, y: int) -> bool:
        r, g, b, _a = pixels[x, y]
        return abs(r - br) + abs(g - bg) + abs(b - bb) <= tolerance

    for x in range(w):
        for y in (0, h - 1):
            if not visited[y * w + x] and close_enough(x, y):
                visited[y * w + x] = 1
                queue.append((x, y))
    for y in range(h):
        for x in (0, w - 1):
            if not visited[y * w + x] and close_enough(x, y):
                visited[y * w + x] = 1
                queue.append((x, y))

    while queue:
        x, y = queue.popleft()
        r, g, b, _a = pixels[x, y]
        pixels[x, y] = (r, g, b, 0)
        for nx, ny in ((x + 1, y), (x - 1, y), (x, y + 1), (x, y - 1)):
            if 0 <= nx < w and 0 <= ny < h and not visited[ny * w + nx]:
                visited[ny * w + nx] = 1
                if close_enough(nx, ny):
                    queue.append((nx, ny))

    return img


def fit_square(img: Image.Image, size: int, margin: float = 0.06) -> Image.Image:
    """裁掉透明边 → 等比缩放 → 居中放进正方形画布。"""
    bbox = img.split()[3].getbbox()
    if bbox:
        img = img.crop(bbox)

    inner = int(size * (1 - margin * 2))
    scale = min(inner / img.width, inner / img.height)
    new_size = (max(1, int(img.width * scale)), max(1, int(img.height * scale)))
    img = img.resize(new_size, Image.LANCZOS)

    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.paste(img, ((size - new_size[0]) // 2, (size - new_size[1]) // 2), img)
    return canvas


def transparency_ratio(img: Image.Image) -> float:
    """全透明像素占比。用直方图而不是逐像素：快一个数量级，也没有弃用 API。"""
    alpha = img.split()[3]
    fully_transparent = alpha.histogram()[0]
    return fully_transparent / (img.width * img.height)


def main() -> int:
    # Windows 控制台默认 GBK，打印 ✅ 会直接抛 UnicodeEncodeError 把整批处理打断
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--only", default=None, help="逗号分隔的 id")
    parser.add_argument("--size", type=int, default=256)
    parser.add_argument("--tolerance", type=int, default=26, help="背景色容差（RGB 曼哈顿距离）")
    args = parser.parse_args()

    only = set(args.only.split(",")) if args.only else None
    plan = json.loads(PLAN.read_text(encoding="utf-8"))
    ids = [entry["id"] for entry in plan if only is None or entry["id"] in only]

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    done = 0
    for asset_id in ids:
        raw = RAW_DIR / f"{asset_id}.png"
        if not raw.exists():
            print(f"跳过 {asset_id}（没有 {raw.relative_to(ROOT)}）")
            continue

        source = Image.open(raw)
        keyed = key_out_background(source, args.tolerance)
        ratio = transparency_ratio(keyed)
        if ratio < 0.02:
            # 抠图没抠下来（背景不是纯色）——宁可留着背景也别输出一张黑底图，
            # 但必须喊出来，否则游戏里会突然出现一块方块。
            print(f"⚠️  {asset_id}: 只抠掉 {ratio:.1%}，背景可能不是纯色，需要重出图或手修")

        fitted = fit_square(keyed, args.size)
        out = OUT_DIR / f"{asset_id}.png"
        fitted.save(out, "PNG", optimize=True)
        done += 1
        print(f"✅ {asset_id}  {fitted.width}×{fitted.height}  {out.stat().st_size // 1024}KB  透明 {transparency_ratio(fitted):.0%}")

    print(f"\n完成 {done}/{len(ids)}，输出目录 {OUT_DIR.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
