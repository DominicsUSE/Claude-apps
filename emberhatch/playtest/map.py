"""Draws a top-down map of the world from a playtest run, with the player's route.

    python3 playtest/map.py playtest/out/world-live.json playtest/map.png

Needs matplotlib (pip install matplotlib).
"""
import json
import sys

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Circle, Polygon


def hull(points):
    """Convex hull (monotone chain) of a box's corners seen from above."""
    pts = sorted(set((round(x, 3), round(z, 3)) for x, z in points))
    if len(pts) < 3:
        return pts

    def cross(o, a, b):
        return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])

    lower, upper = [], []
    for p in pts:
        while len(lower) >= 2 and cross(lower[-2], lower[-1], p) <= 0:
            lower.pop()
        lower.append(p)
    for p in reversed(pts):
        while len(upper) >= 2 and cross(upper[-2], upper[-1], p) <= 0:
            upper.pop()
        upper.append(p)
    return lower[:-1] + upper[:-1]


world = json.load(open(sys.argv[1]))
out = sys.argv[2]

LABELS = {
    "Ember Hollow": [
        ((0, 60), "Spawn"),
        ((0, 0), "Forge"),
        ((62, 22), "Nursery"),
        ((66, -18), "Egg Shop"),
        ((-60, -6), "Quest Board"),
        ((-62, 28), "Upgrades"),
        ((0, -100), "Portal Plaza"),
    ],
    "Sunken Grove": [((0, 472), "Arrive"), ((0, 488), "Gate home")],
}
VIEWS = [("Ember Hollow", (-112, 112), (-112, 112)), ("Sunken Grove", (-92, 92), (308, 492))]

fig, axes = plt.subplots(1, 2, figsize=(16, 8.4), facecolor="#16120f")
for ax, (title, xlim, zlim) in zip(axes, VIEWS):
    ax.set_facecolor("#16120f")
    for part in sorted(world["parts"], key=lambda p: p["y"]):
        if not (xlim[0] - 60 <= part["x"] <= xlim[1] + 60 and zlim[0] - 60 <= part["z"] <= zlim[1] + 60):
            continue
        style = dict(facecolor="#" + part["color"], edgecolor="none", alpha=0.95)
        if "radius" in part:
            ax.add_patch(Circle((part["x"], part["z"]), part["radius"], **style))
        else:
            ax.add_patch(Polygon(hull(part["corners"]), closed=True, **style))

    for m in world["markers"]:
        if not (xlim[0] <= m["x"] <= xlim[1] and zlim[0] <= m["z"] <= zlim[1]):
            continue
        if m["tag"] == "EmberShard":
            ax.plot(m["x"], m["z"], marker="D", color="#ff9630", markersize=5, markeredgecolor="#3a1c00", markeredgewidth=0.6)
        elif m["tag"] == "CrystalPod":
            ax.plot(m["x"], m["z"], marker="*", color="#b278ff" if m["rare"] else "#ff7034", markersize=15, markeredgecolor="#1b0e00")
        elif m["tag"] == "Portal" and m.get("label") and m["label"] != "EmberHollow":
            ax.annotate(m["label"], (m["x"], m["z"]), color="#eee4d0", fontsize=8, ha="center", va="top", xytext=(0, -8), textcoords="offset points")

    # Route: break the line where a portal jumped the player.
    segment = []
    for point in world["path"]:
        if point.get("jump") and segment:
            ax.plot([p["x"] for p in segment], [p["z"] for p in segment], color="#eee4d0", linewidth=1, alpha=0.75)
            segment = []
        segment.append(point)
    if segment:
        ax.plot([p["x"] for p in segment], [p["z"] for p in segment], color="#eee4d0", linewidth=1, alpha=0.75)

    for (x, z), label in LABELS[title]:
        ax.annotate(label, (x, z), color="#ecbe6a", fontsize=10, ha="center", weight="bold")

    ax.set_xlim(*xlim)
    ax.set_ylim(zlim[1], zlim[0])  # north (-Z) at the top
    ax.set_aspect("equal")
    ax.set_title(title, color="#ecbe6a", fontsize=15, pad=10)
    ax.tick_params(colors="#7a6e60", labelsize=7)
    for spine in ax.spines.values():
        spine.set_color("#5a4a32")

fig.text(
    0.5,
    0.02,
    "North is up.  ◆ Ember Shard   ★ Crystal Pod (violet = rare)   line = the test player's route",
    color="#bbae98",
    ha="center",
    fontsize=10,
)
plt.tight_layout(rect=(0, 0.04, 1, 1))
plt.savefig(out, dpi=110, facecolor=fig.get_facecolor())
print("wrote", out)
