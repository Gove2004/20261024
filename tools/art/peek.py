"""
单张放大预览：把某个 id 的贴图放到棋盘底上放大输出，方便单独评审。

总览图一格只有 192px，脸部/材质细节全糊在一起，判断"风格对不对"会失真。
要评一张图就用这个工具单独放大到 384–512px 再交给模型看。

用法：
    python tools/art/peek.py guoba
    python tools/art/peek.py guoba assassin --size 384 --bg dark
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
    parser.add_argument("ids", nargs="+")
    parser.add_argument("--size", type=int, default=384)
    parser.add_argument("--bg", default="checker", choices=["checker", "dark", "light"])
    parser.add_argument("--out-dir", default="shots")
    args = parser.parse_args()

    for asset_id in args.ids:
        path = ART_DIR / f"{asset_id}.png"
        if not path.exists():
            print(f"没有 {path.relative_to(ROOT)}")
            continue

        size = args.size
        canvas = Image.new("RGB", (size, size), (26, 24, 34))
        draw = ImageDraw.Draw(canvas)

        if args.bg == "checker":
            for cy in range(0, size, 32):
                for cx in range(0, size, 32):
                    shade = (58, 56, 68) if ((cx // 32) + (cy // 32)) % 2 == 0 else (44, 42, 54)
                    draw.rectangle([cx, cy, cx + 31, cy + 31], fill=shade)
        elif args.bg == "dark":
            draw.rectangle([0, 0, size, size], fill=(12, 10, 18))
        else:
            draw.rectangle([0, 0, size, size], fill=(210, 206, 220))

        icon = Image.open(path).convert("RGBA").resize((size, size), Image.LANCZOS)
        canvas.paste(icon, (0, 0), icon)

        out = ROOT / args.out_dir / f"peek-{asset_id}.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        canvas.save(out, "PNG")
        print(f"✅ {out.relative_to(ROOT)}  {size}×{size}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
