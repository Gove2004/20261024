"""主角卡：给比赛提交用的一张竖版卡（1080x1440）。

刻意做成"一张卡"而不是又一张截图：评委看的是"主角有没有记忆点"，
卡面把名字、形象、脾气、一句话台词压缩在同一个画面上。

用法：python tools/art/card.py
输出：shots/guoba-card.png
"""

from __future__ import annotations

import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageFont

sys.stdout.reconfigure(encoding="utf-8")

ROOT = Path(__file__).resolve().parents[2]
ART = ROOT / "public" / "art"
OUT = ROOT / "shots" / "guoba-card.png"

W, H = 1080, 1440
BG_TOP = (26, 21, 40)
BG_BOTTOM = (10, 8, 18)
ACCENT = (245, 194, 75)
TEXT = (232, 226, 246)
DIM = (154, 146, 183)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\msyhbd.ttc",
    r"C:\Windows\Fonts\msyh.ttc",
    r"C:\Windows\Fonts\simhei.ttf",
]


def load_font(size: int, bold: bool = False) -> ImageFont.FreeTypeFont:
    order = FONT_CANDIDATES if bold else FONT_CANDIDATES[1:] + FONT_CANDIDATES[:1]
    for path in order:
        if Path(path).exists():
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    raise SystemExit("找不到中文字体，请修改 FONT_CANDIDATES")


def vertical_gradient(size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]) -> Image.Image:
    w, h = size
    grad = Image.new("RGB", (1, h))
    px = grad.load()
    for y in range(h):
        t = y / max(1, h - 1)
        px[0, y] = (
            round(top[0] + (bottom[0] - top[0]) * t),
            round(top[1] + (bottom[1] - top[1]) * t),
            round(top[2] + (bottom[2] - top[2]) * t),
        )
    return grad.resize((w, h), Image.BILINEAR)


def main() -> None:
    card = vertical_gradient((W, H), BG_TOP, BG_BOTTOM).convert("RGBA")
    draw = ImageDraw.Draw(card, "RGBA")

    # 背景：地板贴图压暗铺满整张卡（铺满而不是贴一块：第一版贴到 y=1260 就断掉，
    # 评审看到"立绘下面有个方形暗块"，其实就是这条硬边）
    floor_path = ART / "env-floor.png"
    if floor_path.exists():
        floor = Image.open(floor_path).convert("RGBA").resize((W, H), Image.LANCZOS)
        floor = floor.filter(ImageFilter.GaussianBlur(1.4))
        floor.putalpha(38)
        card.alpha_composite(floor, (0, 0))

    # 两盏暖光：右上角火光 + 左上冷光
    for (cx, cy, r, color, alpha) in (
        (W - 120, 120, 460, (255, 150, 70), 54),
        (110, 980, 420, (125, 105, 210), 40),
    ):
        glow = Image.new("RGBA", (r * 2, r * 2), (0, 0, 0, 0))
        gd = ImageDraw.Draw(glow)
        for i in range(24, 0, -1):
            t = i / 24
            gd.ellipse(
                (r - r * t, r - r * t, r + r * t, r + r * t),
                fill=(*color, round(alpha * (1 - t) ** 1.6)),
            )
        glow = glow.filter(ImageFilter.GaussianBlur(18))
        card.alpha_composite(glow, (cx - r, cy - r))

    # 外框
    draw.rounded_rectangle((40, 40, W - 40, H - 40), radius=36, outline=(*ACCENT, 150), width=3)
    draw.rounded_rectangle((58, 58, W - 58, H - 58), radius=26, outline=(255, 255, 255, 26), width=2)

    # 顶部标签
    tag_font = load_font(30, bold=True)
    draw.text((92, 104), "反 向 肉 鸽 · 魔 王 殿", font=tag_font, fill=(*DIM,))

    # 名字
    name_font = load_font(120, bold=True)
    draw.text((88, 150), "锅巴", font=name_font, fill=(*ACCENT,))
    draw.text((330, 208), "GUOBA", font=load_font(44, bold=True), fill=(*DIM,))

    # 副标题
    draw.text((92, 300), "来讨伐你的小勇者", font=load_font(52), fill=(*TEXT,))

    # 主角立绘（圆底 + 贴图）
    art_path = ART / "guoba.png"
    if not art_path.exists():
        raise SystemExit("缺少 public/art/guoba.png")
    guoba = Image.open(art_path).convert("RGBA")
    size = 560
    guoba = guoba.resize((size, size), Image.LANCZOS)

    # 圆盘：直径 640，盘心 700 —— 上方给副标题留 90px，下方给属性留 30px。
    # （盘心 640 时圆盘顶 290 会直接压住副标题，评审已经指出过一次）
    disc_cy = 700
    disc = Image.new("RGBA", (640, 640), (0, 0, 0, 0))
    dd = ImageDraw.Draw(disc)
    dd.ellipse((6, 6, 633, 633), fill=(22, 17, 34, 210), outline=(*ACCENT, 90), width=3)
    dd.ellipse((54, 54, 585, 585), outline=(255, 255, 255, 20), width=2)
    card.alpha_composite(disc, (W // 2 - 320, disc_cy - 320))

    # 脚下投影：必须是椭圆 + 高斯模糊，不能用整块 alpha 方块
    # （第一版用了 620x620 的整块半透明黑，评审直接判"立绘带黑框"）
    oval = Image.new("RGBA", (480, 120), (0, 0, 0, 0))
    od = ImageDraw.Draw(oval)
    od.ellipse((0, 0, 479, 119), fill=(0, 0, 0, 130))
    oval = oval.filter(ImageFilter.GaussianBlur(24))
    card.alpha_composite(oval, (W // 2 - 240, disc_cy + 180))
    card.alpha_composite(guoba, (W // 2 - size // 2, disc_cy - size // 2))

    # 三条属性
    stats = [("战斗风格", "纯远程 · 站定蓄力"), ("脾气", "被打急了会炸毛"), ("弱点", "怕被围死")]
    y = 1040
    for label, value in stats:
        draw.text((100, y), label, font=load_font(32, bold=True), fill=(*DIM,))
        draw.text((300, y - 4), value, font=load_font(38), fill=(*TEXT,))
        y += 66

    # 台词
    quote = "「……我只是想回家吃饭。」"
    draw.text((100, y + 18), quote, font=load_font(44), fill=(*ACCENT,))
    draw.text((100, y + 74), "5 分钟后，要么他躺下，要么你输。", font=load_font(32), fill=(*DIM,))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    card.convert("RGB").save(OUT, quality=94)
    print(f"已生成 {OUT.relative_to(ROOT)}  {card.width}x{card.height}")


if __name__ == "__main__":
    main()
