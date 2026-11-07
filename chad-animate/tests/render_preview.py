"""Stick-figure previews of the simulated animations (side + front views).

Ground tick marks scroll at the body's speed, so a planted foot that
slides shows up as a foot drifting against the ticks.
"""

import math
from pathlib import Path

from PIL import Image, ImageDraw

SCALE = 56  # pixels per stud
VIEW_W, VIEW_H = 300, 440
FLOOR_Y = -3.0  # HRP-space floor of the test rig
BG = (246, 244, 239)
INK = (40, 40, 46)
LEFT = (52, 110, 200)
RIGHT = (226, 120, 40)
GROUND = (150, 140, 120)

BONES = [
    ("pelvis", "neck", INK, 9),
    ("neck", "head", INK, 5),
    ("LeftHip", "LeftKnee", LEFT, 6), ("LeftKnee", "LeftAnkle", LEFT, 6),
    ("LeftAnkle", "LeftToe", LEFT, 4), ("LeftAnkle", "LeftHeel", LEFT, 4), ("LeftHeel", "LeftToe", LEFT, 3),
    ("RightHip", "RightKnee", RIGHT, 6), ("RightKnee", "RightAnkle", RIGHT, 6),
    ("RightAnkle", "RightToe", RIGHT, 4), ("RightAnkle", "RightHeel", RIGHT, 4), ("RightHeel", "RightToe", RIGHT, 3),
    ("LeftShoulder", "LeftElbow", LEFT, 5), ("LeftElbow", "LeftWrist", LEFT, 5), ("LeftWrist", "LeftHand", LEFT, 4),
    ("RightShoulder", "RightElbow", RIGHT, 5), ("RightElbow", "RightWrist", RIGHT, 5), ("RightWrist", "RightHand", RIGHT, 4),
    ("LeftHip", "RightHip", INK, 5), ("LeftShoulder", "RightShoulder", INK, 5),
]


def step_height(z):
    if z > -4:
        return 0
    return min(math.floor((-z - 4) / 2) + 1, 10)


def draw_view(img, ox, frame, name, side):
    d = ImageDraw.Draw(img)
    pts = frame["pts"]
    # Camera follows jumps: the figure rises at most 1 stud on screen.
    lift = min(frame["worldY"], 1.0) if name != "stairs" else 0
    base_x = ox + VIEW_W / 2
    base_y = 360

    def proj(p):
        x, y, z = p
        sx = -z if side else -x
        return base_x + sx * SCALE, base_y - (y - FLOOR_Y + lift) * SCALE

    # Ground and scrolling ticks.
    gy = base_y + lift * SCALE
    if name == "stairs" and side:
        poly = []
        for i in range(-60, 61):
            z = i * 0.05
            h = step_height(frame["worldZ"] + z) - frame["worldY"]
            poly.append((base_x - z * SCALE, base_y - h * SCALE))
        d.line(poly, fill=GROUND, width=3)
    else:
        d.line([(ox, gy), (ox + VIEW_W, gy)], fill=GROUND, width=3)
        if side:
            offset = (frame["worldZ"] % 1.0) * SCALE
            x = ox - offset
            while x < ox + VIEW_W:
                if x >= ox:
                    d.line([(x, gy), (x - 8, gy + 10)], fill=GROUND, width=2)
                x += SCALE

    # Far limbs first so the near ones draw on top.
    order = BONES if side else BONES
    if side:
        order = sorted(BONES, key=lambda b: 0 if b[2] == LEFT else 1)
    for a, b, color, width in order:
        d.line([proj(pts[a]), proj(pts[b])], fill=color, width=width)
    hx, hy = proj(pts["head"])
    r = 0.5 * SCALE
    d.ellipse([hx - r, hy - r, hx + r, hy + r], outline=INK, width=4, fill=BG)
    fx, fy = proj(pts["face"])
    d.ellipse([fx - 4, fy - 4, fx + 4, fy + 4], fill=INK)


def frame_image(frame, name):
    img = Image.new("RGB", (VIEW_W * 2, VIEW_H + 30), BG)
    draw_view(img, 0, frame, name, side=True)
    draw_view(img, VIEW_W, frame, name, side=False)
    d = ImageDraw.Draw(img)
    d.line([(VIEW_W, 0), (VIEW_W, VIEW_H)], fill=(220, 216, 208), width=1)
    d.text((10, VIEW_H + 8), f"{name}   t={frame['t']:.2f}s   state={frame['state']}", fill=INK)
    d.text((VIEW_W + 10, VIEW_H + 8), "side (forward = right)  |  front", fill=INK)
    return img


def lua_list(t):
    return [t[i] for i in range(1, len(t) + 1)]


def to_py(frame):
    pts = {k: [v[1], v[2], v[3]] for k, v in frame.pts.items()}
    return {"t": frame.t, "state": frame.state, "worldZ": frame.worldZ, "worldY": frame.worldY, "pts": pts}


def render_all(results, out_dir: Path):
    out_dir.mkdir(parents=True, exist_ok=True)
    sheets = []
    by_name = {}
    for name in results.frames.keys():
        frames = [to_py(f) for f in lua_list(results.frames[name])]
        images = [frame_image(f, name) for f in frames[::2]]
        slug = name.replace(" ", "-")
        images[0].save(out_dir / f"{slug}.gif", save_all=True, append_images=images[1:], duration=33, loop=0)
        sheets.append((name, frames, True))
        by_name[name] = frames
    print(f"preview: wrote {len(sheets)} GIFs to {out_dir}")
    contact_sheet(sheets, out_dir / "poses.png")
    fronts = [(n + " (front)", by_name[n], False) for n in ("idle", "walk", "run", "strafe") if n in by_name]
    contact_sheet(fronts, out_dir / "poses-front.png")


def contact_sheet(sheets, path):
    cols = 8
    cell_w, cell_h = VIEW_W // 2 + 10, VIEW_H // 2 + 20
    img = Image.new("RGB", (cell_w * cols, cell_h * len(sheets)), BG)
    for row, (name, frames, side) in enumerate(sheets):
        n = len(frames)
        for c in range(cols):
            f = frames[min(n - 1, int(c * n / cols))]
            full = Image.new("RGB", (VIEW_W, VIEW_H), BG)
            draw_view(full, 0, f, name, side=side)
            thumb = full.resize((VIEW_W // 2, VIEW_H // 2))
            img.paste(thumb, (c * cell_w + 5, row * cell_h + 16))
        ImageDraw.Draw(img).text((6, row * cell_h + 2), name, fill=INK)
    img.save(path)
    print(f"preview: wrote {path}")


def render_map(parts, path):
    """Top-down map of the built world (highest parts drawn last)."""
    size_px, half = 1400, 256
    scale = size_px / (2 * half)
    img = Image.new("RGB", (size_px, size_px), (40, 60, 90))  # pool hole shows as water
    d = ImageDraw.Draw(img)

    def to_px(x, z):
        return ((x + half) * scale, (z + half) * scale)

    items = []
    for i in range(1, len(parts) + 1):
        p = parts[i]
        m = [p.m[j] for j in range(1, 10)]
        pos = [p.p[j] for j in range(1, 4)]
        sx, sy, sz = (p.size[j] for j in range(1, 4))
        color = tuple(int(255 * p.color[j]) for j in range(1, 4))
        # World-space vertical extent decides draw order.
        top = pos[1] + 0.5 * (abs(m[3]) * sx + abs(m[4]) * sy + abs(m[5]) * sz)
        items.append((top, p.shape, m, pos, (sx, sy, sz), color))
    items.sort(key=lambda t: t[0])

    for top, shape, m, pos, (sx, sy, sz), color in items:
        if shape == "Ball":
            r = sx / 2 * scale
            cx, cy = to_px(pos[0], pos[2])
            d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
            continue
        if shape == "Cylinder":
            # Axis is the part's X; seen from above a vertical cylinder is a disc.
            if abs(m[3]) > 0.9:  # axis vertical (X axis maps to world Y)
                r = sy / 2 * scale
                cx, cy = to_px(pos[0], pos[2])
                d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
                continue
        corners = []
        for ux, uz in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
            lx, lz = ux * sx / 2, uz * sz / 2
            wx = pos[0] + m[0] * lx + m[2] * lz
            wz = pos[2] + m[6] * lx + m[8] * lz
            corners.append(to_px(wx, wz))
        d.polygon(corners, fill=color)

    labels = [
        ("SPAWN / PLAZA", 0, 0), ("TRACK", 0, 62), ("STAIRS & RAMP", 0, -112),
        ("CLIMB TOWER", 165, -18), ("PARKOUR", 0, 108), ("POOL", -190, -40),
    ]
    for text, x, z in labels:
        px, py = to_px(x, z)
        w = len(text) * 6
        d.rectangle([px - w / 2 - 4, py - 8, px + w / 2 + 4, py + 8], fill=(255, 255, 255))
        d.text((px - w / 2, py - 6), text, fill=(20, 20, 20))
    d.text((10, 10), "ChadWorld, top-down (north = up, 512 x 512 studs)", fill=(255, 255, 255))
    img.save(path)
    print(f"preview: wrote {path}")
