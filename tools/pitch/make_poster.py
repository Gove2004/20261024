# -*- coding: utf-8 -*-
"""4:3 宣传图：AI 出图做底，标题用真字体压上去。

为什么不用模型直接写标题：中文出图几乎一定写错字，路演大屏上错一个字就废了。
所以画面交给模型，字交给字体文件 —— 成品只有一行游戏标题，没有别的文字。
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

W, H = 1600, 1200
OUT = Path("art/pitch/poster-4x3.png")
BG_CANDIDATES = [
    Path("art/raw/pitch/agnes-4x3.png"),
    Path("art/raw/pitch/keyart.png"),
    Path("public/art/throne.png"),
]
FONT_BOLD = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"]
FONT_REG = [r"C:\Windows\Fonts\msyh.ttc", r"C:\Windows\Fonts\simhei.ttf"]


def font(paths, size):
    for p in paths:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()


def cover(img, w, h):
    """等比铺满，居中裁切。"""
    ratio = max(w / img.width, h / img.height)
    img = img.resize((int(img.width * ratio) + 1, int(img.height * ratio) + 1), Image.LANCZOS)
    left = (img.width - w) // 2
    top = (img.height - h) // 2
    return img.crop((left, top, left + w, top + h))


def vignette(img):
    mask = Image.new("L", (W, H), 0)
    d = ImageDraw.Draw(mask)
    d.ellipse((-W * 0.25, -H * 0.35, W * 1.25, H * 1.35), fill=110)
    mask = mask.filter(ImageFilter.GaussianBlur(160))
    dark = Image.new("RGB", (W, H), (6, 4, 12))
    return Image.composite(img, dark, mask)


def main():
    src = next((p for p in BG_CANDIDATES if p.exists()), None)
    if src is None:
        raise SystemExit("找不到底图")
    print("bg:", src)
    img = vignette(cover(Image.open(src).convert("RGB"), W, H))

    # 底部压暗，让标题有安静的落点
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(shade)
    for i in range(int(H * 0.62)):
        y = H // 2 + i
        d.line([(0, y), (W, y)], fill=(8, 5, 14, int(225 * (i / (H * 0.62)) ** 1.1)))
    img = Image.alpha_composite(img.convert("RGBA"), shade).convert("RGB")

    title_font = font(FONT_BOLD, 178)
    size_font = font(FONT_REG, 42)

    text = "锅巴必须死"
    d = ImageDraw.Draw(img)
    bbox = d.textbbox((0, 0), text, font=title_font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    tx = (W - tw) // 2 - bbox[0]
    ty = int(H * 0.755) - bbox[1]

    # 红色外发光（先画在模糊层上再叠回来）
    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(glow)
    gd.text((tx, ty), text, font=title_font, fill=(224, 43, 69, 235))
    glow = glow.filter(ImageFilter.GaussianBlur(26))
    img = Image.alpha_composite(img.convert("RGBA"), glow).convert("RGB")
    d = ImageDraw.Draw(img)
    d.text((tx + 4, ty + 8), text, font=title_font, fill=(0, 0, 0))
    d.text((tx, ty), text, font=title_font, fill=(245, 240, 255))

    # 标题下一条血线
    line_w = int(tw * 0.42)
    d.rectangle([(W - line_w) // 2, ty + th + 54, (W + line_w) // 2, ty + th + 62], fill=(224, 43, 69))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    img.save(OUT, quality=95)
    print("saved", OUT, img.size)


if __name__ == "__main__":
    sys.exit(main())
