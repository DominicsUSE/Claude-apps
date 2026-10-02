"""Draw the Build Atlas app icon (1024px PNG + macOS .icns). Needs Pillow."""
import math
from PIL import Image, ImageDraw, ImageFilter

S = 1024
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))

# macOS icon grid: 824px rounded square centred on the canvas, with a soft shadow
pad, size, radius = 100, 824, 185
shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ImageDraw.Draw(shadow).rounded_rectangle((pad, pad + 14, pad + size, pad + size + 14), radius, fill=(0, 0, 0, 120))
img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(18)))

# night-sky background with a vertical gradient
bg = Image.new("RGBA", (S, S))
for y in range(S):
    t = y / S
    bg.paste((int(14 + 6 * (1 - t)), int(26 + 18 * (1 - t)), int(48 + 30 * (1 - t)), 255), (0, y, S, y + 1))
mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(mask).rounded_rectangle((pad, pad, pad + size, pad + size), radius, fill=255)
img.paste(bg, (0, 0), mask)

# globe: lit ocean disc
cx, cy, r = S // 2, S // 2 + 10, 300
globe = Image.new("RGBA", (S, S), (0, 0, 0, 0))
g = ImageDraw.Draw(globe)
for i in range(r, 0, -2):
    t = i / r
    g.ellipse((cx - i - (1 - t) * 60, cy - i - (1 - t) * 70, cx + i - (1 - t) * 60, cy + i - (1 - t) * 70),
              fill=(int(18 + 40 * (1 - t)), int(52 + 70 * (1 - t)), int(96 + 90 * (1 - t)), 255))
gm = Image.new("L", (S, S), 0)
ImageDraw.Draw(gm).ellipse((cx - r, cy - r, cx + r, cy + r), fill=255)
img.paste(globe, (0, 0), gm)

# graticule
lines = Image.new("RGBA", (S, S), (0, 0, 0, 0))
ld = ImageDraw.Draw(lines)
for k in (-2, -1, 0, 1, 2):
    w = abs(math.cos(k * math.pi / 6)) * r
    ld.ellipse((cx - w, cy - r, cx + w, cy + r), outline=(190, 220, 255, 60), width=5)
    yy = cy + k * r / 3
    hw = math.sqrt(max(0, r * r - (yy - cy) ** 2))
    ld.line((cx - hw, yy, cx + hw, yy), fill=(190, 220, 255, 60), width=5)
img.paste(lines, (0, 0), Image.composite(lines, Image.new("RGBA", (S, S)), gm))

# score ring: green -> amber -> red
ring = Image.new("RGBA", (S, S), (0, 0, 0, 0))
rd = ImageDraw.Draw(ring)
stops = [(56, 208, 138), (244, 196, 48), (242, 95, 87)]
R2, width = r + 52, 46
for a in range(0, 360, 1):
    t = a / 360
    c0, c1, f = (stops[0], stops[1], t * 2) if t < .5 else (stops[1], stops[2], (t - .5) * 2)
    col = tuple(int(c0[i] + (c1[i] - c0[i]) * f) for i in range(3)) + (255,)
    rd.arc((cx - R2, cy - R2, cx + R2, cy + R2), a - 90, a - 88, fill=col, width=width)
img.alpha_composite(ring)

# house
hd = ImageDraw.Draw(img)
w, h = 300, 250
x0, y0 = cx - w // 2, cy - 40
hd.polygon([(cx, cy - 210), (x0 - 40, y0 + 10), (x0 + w + 40, y0 + 10)], fill=(240, 246, 252, 255))
hd.rectangle((x0, y0, x0 + w, y0 + h), fill=(240, 246, 252, 255))
hd.rounded_rectangle((cx - 50, y0 + h - 140, cx + 50, y0 + h), 14, fill=(20, 44, 78, 255))

img.save("icon.png")
img.save("icon.icns", sizes=[(16, 16), (32, 32), (64, 64), (128, 128), (256, 256), (512, 512), (1024, 1024)])
print("icon.png, icon.icns")
