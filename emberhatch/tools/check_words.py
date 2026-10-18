"""Fails if any game script or config still uses a word from the removed system.

Run from the emberhatch folder:  python3 tools/check_words.py
"""
import pathlib
import re
import sys

BANNED = re.compile(r"\b(mine|mines|mining|miner|miners|ore|ores|pickaxe|pickaxes)\b", re.IGNORECASE)

root = pathlib.Path(__file__).resolve().parent.parent / "src"
hits = []
for path in sorted(root.rglob("*.luau")):
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        for match in BANNED.finditer(line):
            hits.append(f"{path.relative_to(root.parent)}:{number}: '{match.group(0)}'  {line.strip()}")

if hits:
    print("Banned words found:")
    print("\n".join(hits))
    sys.exit(1)
print(f"OK: no banned words in {root.relative_to(root.parent)}/")
