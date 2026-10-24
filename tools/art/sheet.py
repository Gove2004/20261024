"""
生成贴图总览图（contact sheet）：把所有 256×256 贴图摆成网格，方便一眼看完整批次。

为什么要它：单张图逐个发给多模态模型既慢又贵，而且**风格一致性只有并排看才能判断**。
一张总览图 + 一次调用就能筛出"崩坏的那几张"。

用法：
    python tools/art/sheet.py                    # 默认读 public/art/*.png
    python tools/art/sheet.py --cols 5 --size 192 --out shots/art-sheet.png
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[2]
ART_DIR = ROOT / "public" / "art"


def main() -> int:
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    parser = argparse.ArgumentParser()
    parser.add_argument("--cols", type=int, default=5)
    parser.add_argument("--size", type=int, default=192)
    parser.add_argument("--out", default="shots/art-sheet.png")
    args = parser.parse_args()

    files = sorted(ART_DIR.glob("*.png"))
    if not files:
        print(f"{ART_DIR} 里没有贴图")
        return 1

    cols = max(1, args.cols)
    rows = (len(files) + cols - 1) // cols
    cell = args.size
    label_h = 22
    pad = 8
    sheet = Image.new("RGB", (cols * (cell + pad) + pad, rows * (cell + label_h + pad) + pad), (26, 24, 34))
    draw = ImageDraw.Draw(sheet)

    for index, path in enumerate(files):
        col = index % cols
        row = index // cols
        x = pad + col * (cell + pad)
        y = pad + row * (cell + label_h + pad)

        # 棋盘格底：透明区域一眼可见（黑底会把透明和黑色贴图混在一起）
        for cy in range(0, cell, 24):
            for cx in range(0, cell, 24):
                shade = (58, 56, 68) if ((cx // 24) + (cy // 24)) % 2 == 0 else (44, 42, 54)
                draw.rectangle([x + cx, y + cy, x + min(cx + 23, cell), y + min(cy + 23, cell)], fill=shade)

        icon = Image.open(path).convert("RGBA").resize((cell, cell), Image.LANCZOS)
        sheet.paste(icon, (x, y), icon)
        draw.text((x + 4, y + cell + 5), path.stem, fill=(220, 214, 240))

    out = ROOT / args.out
    out.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out, "PNG", optimize=True)
    print(f"✅ {out.relative_to(ROOT)}  {sheet.width}×{sheet.height}  {len(files)} 张")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
