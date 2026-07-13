#!/usr/bin/env python3
import json
import sys
import textwrap
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


def font(size, bold=False):
    candidates = [
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Arial.ttf",
        "/System/Library/Fonts/Supplemental/Helvetica Bold.ttf" if bold else "/System/Library/Fonts/Supplemental/Helvetica.ttf",
        "/Library/Fonts/Arial.ttf",
    ]
    for candidate in candidates:
        if candidate and Path(candidate).exists():
            return ImageFont.truetype(candidate, size=size)
    return ImageFont.load_default(size=size)


def rounded_rect(draw, xy, radius, fill):
    draw.rounded_rectangle(xy, radius=radius, fill=fill)


def draw_wrapped(draw, text, xy, max_chars, line_gap, font_obj, fill):
    x, y = xy
    for line in textwrap.wrap(text, width=max_chars)[:4]:
        draw.text((x, y), line, font=font_obj, fill=fill)
        y += font_obj.size + line_gap


def make_card(spec):
    width = int(spec["width"])
    height = int(spec["height"])
    image = Image.new("RGB", (width, height), "#06110c")
    draw = ImageDraw.Draw(image)

    for y in range(height):
        ratio = y / max(height - 1, 1)
        green = int(17 + ratio * 30)
        blue = int(12 + ratio * 10)
        draw.line([(0, y), (width, y)], fill=(6, green, blue))

    glow_radius = 220 if width > height else 160
    glow = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    glow_draw = ImageDraw.Draw(glow)
    glow_draw.ellipse((width - glow_radius, 20, width + glow_radius // 2, 20 + glow_radius), fill=(185, 255, 90, 24))
    image = Image.alpha_composite(image.convert("RGBA"), glow).convert("RGB")
    draw = ImageDraw.Draw(image)

    brand_font = font(30 if width > height else 26, bold=True)
    title_font = font(58 if width > height else 48, bold=True)
    caption_font = font(30 if width > height else 28)
    qa_font = font(28 if width > height else 24, bold=True)

    margin = 60
    draw.text((margin, 52), "Foreman Launch Contractor", font=brand_font, fill="#b9ff5a")
    draw_wrapped(
        draw,
        spec["title"],
        (margin, int(height * 0.36)),
        34 if width < height else 48,
        8,
        title_font,
        "#f6efd8",
    )
    draw_wrapped(
        draw,
        spec["caption"],
        (margin, int(height * 0.54)),
        36 if width < height else 64,
        8,
        caption_font,
        "#d6e3d0",
    )

    footer_y = height - 126
    rounded_rect(draw, (margin, footer_y, width - margin, footer_y + 68), 22, "#203428")
    draw.text((margin + 28, footer_y + 18), spec["footer"], font=qa_font, fill="#cfff5d")

    return image


def main():
    spec_path = Path(sys.argv[1])
    output_path = Path(sys.argv[2])
    spec = json.loads(spec_path.read_text())
    output_path.parent.mkdir(parents=True, exist_ok=True)
    make_card(spec).save(output_path)


if __name__ == "__main__":
    main()
