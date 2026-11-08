"""Run ChadAnimate's Lua checks and render animation previews.

Usage:
    pip install lupa pillow
    python3 tests/run_tests.py            # checks only
    python3 tests/run_tests.py --preview  # also writes preview/*.gif and preview/poses.png

Runs the real src/client/Gait.luau and Rig.luau in a Lua 5.1 VM with a small
Vector3/CFrame implementation (tests/roblox_math.lua), and parse-checks every
.luau file in src/ plus the generated installer.
"""

import sys
from pathlib import Path

from lupa import lua51

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"


def new_runtime():
    lua = lua51.LuaRuntime(unpack_returned_tuples=True)
    math_lib = lua.execute((TESTS / "roblox_math.lua").read_text())
    g = lua.globals()
    g.Vector3 = math_lib.Vector3
    g.CFrame = math_lib.CFrame
    return lua, math_lib


def load_chunk(lua, path, *args):
    loader = lua.eval("function(src, name) local f, e = loadstring(src, name) if not f then error(e) end return f end")
    return loader(path.read_text(), "@" + path.name)(*args)


def parse_check(lua, paths):
    """Lua 5.1 syntax is a subset of Luau, so a clean parse means valid Luau."""
    compile_only = lua.eval("function(src, name) local f, e = loadstring(src, name) return e end")
    failures = []
    for p in paths:
        err = compile_only(p.read_text(), "@" + str(p.relative_to(ROOT)))
        if err:
            failures.append(err)
    return failures


API_URL = "https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/Full-API-Dump.json"
API_CACHE = TESTS / ".cache" / "Full-API-Dump.json"


def load_api():
    """Roblox's API dump, reduced to what the mock engine checks."""
    import json
    import urllib.request

    if not API_CACHE.exists():
        API_CACHE.parent.mkdir(parents=True, exist_ok=True)
        print(f"downloading Roblox API dump to {API_CACHE.relative_to(ROOT)}")
        urllib.request.urlretrieve(API_URL, API_CACHE)
    dump = json.loads(API_CACHE.read_text())

    classes = {}
    for c in dump["Classes"]:
        tags = c.get("Tags") or []
        members = {}
        for m in c["Members"]:
            mtags = [t for t in (m.get("Tags") or []) if isinstance(t, str)]
            sec = m.get("Security", "None")
            if isinstance(sec, dict):
                read_sec, write_sec = sec.get("Read", "None"), sec.get("Write", "None")
            else:
                read_sec = write_sec = sec
            if "NotScriptable" in mtags:
                read_sec = write_sec = "NotScriptable"
            vt = m.get("ValueType") or {}
            members[m["Name"]] = {
                "kind": m["MemberType"],
                "type": vt.get("Name", ""),
                "cat": vt.get("Category", ""),
                "readOnly": "ReadOnly" in mtags,
                "deprecated": "Deprecated" in mtags,
                "readSec": read_sec,
                "writeSec": write_sec,
            }
        classes[c["Name"]] = {
            "super": "" if c["Superclass"] == "<<<ROOT>>>" else c["Superclass"],
            "notCreatable": "NotCreatable" in tags,
            "members": members,
        }
    enums = {e["Name"]: {i["Name"]: i["Value"] for i in e["Items"]} for e in dump["Enums"]}
    legacy = {}
    for e in dump["Enums"]:
        for i in e["Items"]:
            for old in i.get("LegacyNames") or []:
                legacy.setdefault(e["Name"], {})[old] = i["Name"]
    first = {e["Name"]: e["Items"][0]["Name"] for e in dump["Enums"] if e["Items"]}
    return {"classes": classes, "enums": enums, "enumFirst": first, "enumLegacy": legacy}


def run_smoke(test_file, installer_name):
    """Run one smoke test in a fresh Lua VM with a fresh mock engine."""
    lua, math_lib = new_runtime()
    installer = ROOT / "dist" / installer_name
    api = lua.table_from(load_api(), recursive=True)
    mock = load_chunk(lua, TESTS / "mock_roblox.lua", math_lib, api)
    return load_chunk(lua, TESTS / test_file, math_lib, mock, installer.read_text())


def report(title, checks):
    """Print a Lua list of checks; return the number that failed."""
    print(title)
    failed = 0
    for i in range(1, len(checks) + 1):
        c = checks[i]
        if not c.ok:
            failed += 1
        detail = f"  ({c.detail})" if c.detail else ""
        print(f"  {'ok  ' if c.ok else 'FAIL'}  {c.name}{detail}")
    return failed


def main():
    lua, math_lib = new_runtime()

    sources = sorted((ROOT / "src").rglob("*.luau")) + sorted((ROOT / "dist").glob("*.lua"))
    syntax_errors = parse_check(lua, sources)

    rig = load_chunk(lua, ROOT / "src" / "client" / "Rig.luau")
    gait = load_chunk(lua, ROOT / "src" / "client" / "Gait.luau")
    build = load_chunk(lua, TESTS / "fixture.lua", math_lib)
    results = load_chunk(lua, TESTS / "gait_test.lua", math_lib, rig, gait, build)

    failed = len(syntax_errors)
    print(f"syntax: {len(sources)} files parsed")
    for err in syntax_errors:
        print(f"  FAIL  {err}")
    failed += report("animation:", results.checks)
    total = len(results.checks) + len(syntax_errors)

    smoke = None
    if "--no-smoke" not in sys.argv:
        warnings = set()
        for test_file, installer, label in (
            ("smoke_test.lua", "ChadWorld_Installer.lua", "full world"),
            ("smoke_baseplate.lua", "ChadBaseplate_Installer.lua", "baseplate + dummy"),
        ):
            res = run_smoke(test_file, installer)
            failed += report(f"smoke, {label} (mock engine checked against the Roblox API dump):", res)
            total += len(res)
            warnings |= {res.warnings[i] for i in range(1, len(res.warnings) + 1)}
            if test_file == "smoke_test.lua":
                smoke = res
        for w in sorted(warnings):
            print(f"  warn  {w}")

    if "--preview" in sys.argv:
        from render_preview import render_all, render_map

        render_all(results, ROOT / "preview")
        if smoke is not None:
            render_map(smoke.parts, ROOT / "preview" / "world-map.png")

    print(f"\n{total - failed}/{total} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.path.insert(0, str(TESTS))
    sys.exit(main())
