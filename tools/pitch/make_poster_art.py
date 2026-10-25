# -*- coding: utf-8 -*-
"""4:3 宣传图（保底方案）：仓库已有 AI 贴图重排成一张竖构图键视觉 + 真字体标题。

画面元素（王座/勇者/五只魔物）本来就都是图像模型出的图，
这里只做「选、缩放、打光、压标题」，不再二次生成 —— 截止前最稳的一条路。
"""

from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageEnhance

W, H = 1600, 1200
ART = Path("public/art")
OUT = Path("art/pitch/poster-4x3.png")
BOLD = [r"C:\Windows\Fonts\msyhbd.ttc", r"C:\Windows\Fonts\simhei.ttf"]


def load(name):
    p = ART / name
    return Image.open(p).convert("RGBA") if p.exists() else None


def fit(img, h):
    r = h / img.height
    return img.resize((max(1, int(img.width * r)), h), Image.LANCZOS)


def cover(img, w, h):
    r = max(w / img.width, h / img.height)
    img = img.resize((int(img.width * r) + 1, int(img.height * r) + 1), Image.LANCZOS)
    l, t = (img.width - w) // 2, (img.height - h) // 2
    return img.crop((l, t, l + w, t + h))


def glow_layer(canvas, hero, pos, color=(224, 43, 69), radius=90, strength=210):
    g = Image.new("RGBA", canvas.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(g)
    cx, cy = pos[0] + hero.width // 2, pos[1] + hero.height // 2
    d.ellipse((cx - hero.width // 2, cy - hero.height // 2, cx + hero.width // 2, cy + hero.height // 2),
              fill=color + (strength,))
    g = g.filter(ImageFilter.GaussianBlur(radius))
    return Image.alpha_composite(canvas, g)


def main():
    bg = cover(load("throne.png").convert("RGB"), W, H).convert("RGBA")
    bg = ImageEnhance.Brightness(bg).enhance(0.72)

    # 中央红色天光：把所有元素拉进同一个光源
    haze = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(haze)
    d.ellipse((W * 0.18, H * 0.02, W * 0.82, H * 0.95), fill=(190, 40, 60, 60))
    haze = haze.filter(ImageFilter.GaussianBlur(150))
    bg = Image.alpha_composite(bg, haze)

    hero = fit(load("guoba.png"), 560)
    hero_x = (W - hero.width) // 2
    hero_y = H - hero.height + 40
    bg = glow_layer(bg, hero, (hero_x, hero_y))

    # 魔物：两侧由近到远，越远越暗越小
    crowd = [
        ("slime.png", 0.10, 0.62, 300, 210),
        ("spider-giant.png", 0.72, 0.56, 420, 185),
        ("goblin.png", 0.02, 0.30, 300, 175),
        ("gargoyle.png", 0.80, 0.28, 360, 205),
        ("bat.png", 0.28, 0.16, 190, 150),
    ]
    for name, fx, fy, hh, alpha in crowd:
        spr = load(name)
        if spr is None:
            continue
        spr = fit(spr, hh)
        spr.putalpha(spr.getchannel("A").point(lambda v: int(v * alpha / 255)))
        spr = ImageEnhance.Brightness(spr).enhance(0.85)
        bg.alpha_composite(spr, (int(W * fx), int(H * fy)))

    bg.alpha_composite(hero, (hero_x, hero_y))

    # 底部压暗 + 顶部压暗，让标题有落点
    shade = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(shade)
    for i in range(340):
        d.line([(0, i), (W, i)], fill=(6, 4, 12, int(190 * (1 - i / 340) ** 1.4)))
    for i in range(300):
        y = H - 1 - i
        d.line([(0, y), (W, y)], fill=(6, 4, 12, int(170 * (1 - i / 300) ** 1.3)))
    bg = Image.alpha_composite(bg, shade)

    from PIL import ImageFont

    def font(size):
        for p in BOLD:
            if Path(p).exists():
                return ImageFont.truetype(p, size)
        return ImageFont.load_default()

    title = "锅巴必须死"
    f = font(196)
    d = ImageDraw.Draw(bg)
    bb = d.textbbox((0, 0), title, font=f)
    tw, th = bb[2] - bb[0], bb[3] - bb[1]
    tx = (W - tw) // 2 - bb[0]
    ty = int(H * 0.085) - bb[1]

    glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    ImageDraw.Draw(glow).text((tx, ty), title, font=f, fill=(224, 43, 69, 240))
    bg = Image.alpha_composite(bg, glow.filter(ImageFilter.GaussianBlur(24)))

    d = ImageDraw.Draw(bg)
    d.text((tx + 3, ty + 7), title, font=f, fill=(0, 0, 0, 220))
    d.text((tx, ty), title, font=f, fill=(246, 241, 255))
    lw = int(tw * 0.4)
    d.rectangle([(W - lw) // 2, ty + th + 44, (W + lw) // 2, ty + th + 51], fill=(224, 43, 69))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    bg.convert("RGB").save(OUT, quality=95)
    print("saved", OUT, bg.size)


if __name__ == "__main__":
    main()
