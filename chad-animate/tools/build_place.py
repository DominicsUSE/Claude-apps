"""Build dist/ChadBaseplate.rbxlx: a ready-to-open Roblox place.

It runs dist/ChadBaseplate_Installer.lua inside the API-checked mock engine
(tests/mock_roblox.lua) on an empty place, then writes what the installer
built as Roblox XML. Property names and value types come from Rojo's
reflection database, so the file matches what Studio itself saves.

Usage: python3 tools/build_place.py   (after tools/build_installer.py)
"""

import json
import sys
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from xml.sax.saxutils import escape

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
sys.path.insert(0, str(TESTS))

from run_tests import load_api, load_chunk, new_runtime  # noqa: E402

DB_URL = "https://raw.githubusercontent.com/rojo-rbx/rbx-dom/master/rbx_dom_lua/src/database.json"
DB_CACHE = TESTS / ".cache" / "rbx-database.json"
INSTALLER = ROOT / "dist" / "ChadBaseplate_Installer.lua"
OUT = ROOT / "dist" / "ChadBaseplate.rbxlx"

# Services written to the file, in order. Studio creates any others.
SERVICES = ["Workspace", "Lighting", "ReplicatedStorage", "ServerScriptService", "StarterPlayer"]
SKIP_CLASSES = {"Terrain", "Camera"}  # Studio makes its own

XML_TAG = {"Bool": "bool", "Float32": "float", "Float64": "double", "Int32": "int", "Int64": "int64", "String": "string"}


def load_db():
    if not DB_CACHE.exists():
        DB_CACHE.parent.mkdir(parents=True, exist_ok=True)
        urllib.request.urlretrieve(DB_URL, DB_CACHE)
    return json.loads(DB_CACHE.read_text())["Classes"]


def property_info(db, class_name, prop):
    """(serialized name, data type) for a property, following the class chain."""
    c = class_name
    while c:
        entry = db[c]["Properties"].get(prop)
        if entry:
            kind = entry["Kind"]
            if "Canonical" not in kind:
                raise ValueError(f"{class_name}.{prop} is an alias")
            ser = kind["Canonical"]["Serialization"]
            if ser == "DoesNotSerialize":
                raise ValueError(f"{class_name}.{prop} is not saved in place files")
            if isinstance(ser, dict) and "SerializesAs" in ser:
                name = ser["SerializesAs"]
            else:
                name = prop  # "Serializes", or a migrating legacy name Studio still reads
            return name, entry["DataType"]
        c = db[c].get("Superclass")
    raise ValueError(f"{class_name} has no property {prop}")


def fmt(x):
    return repr(float(x)) if isinstance(x, float) else str(x)


def write_value(name, data_type, v, class_name):
    if "Enum" in data_type:
        return f'<token name="{name}">{int(v["Value"])}</token>'
    t = data_type["Value"]
    if t == "Ref":
        return f'<Ref name="{name}">{v["__ref"] if v is not None else "null"}</Ref>'
    if t == "String" and name == "Source":
        safe = v.replace("]]>", "]]]]><![CDATA[>")  # "]]>" would end the CDATA block
        return f'<ProtectedString name="Source"><![CDATA[{safe}]]></ProtectedString>'
    if t in XML_TAG:
        text = ("true" if v else "false") if t == "Bool" else escape(str(v)) if t == "String" else fmt(v)
        return f'<{XML_TAG[t]} name="{name}">{text}</{XML_TAG[t]}>'
    if t == "Vector3":
        return f'<Vector3 name="{name}"><X>{fmt(v[1])}</X><Y>{fmt(v[2])}</Y><Z>{fmt(v[3])}</Z></Vector3>'
    if t == "CFrame":
        p, m = v["p"], v["m"]
        rot = "".join(f"<R{i // 3}{i % 3}>{fmt(m[i + 1])}</R{i // 3}{i % 3}>" for i in range(9))
        return f'<CoordinateFrame name="{name}"><X>{fmt(p[1])}</X><Y>{fmt(p[2])}</Y><Z>{fmt(p[3])}</Z>{rot}</CoordinateFrame>'
    if t == "Color3":
        r, g, b = (round(v[k] * 255) for k in ("R", "G", "B"))
        if name == "Color3uint8":
            return f'<Color3uint8 name="Color3uint8">{0xFF000000 | r << 16 | g << 8 | b}</Color3uint8>'
        return f'<Color3 name="{name}"><R>{fmt(v["R"])}</R><G>{fmt(v["G"])}</G><B>{fmt(v["B"])}</B></Color3>'
    if t == "ContentId":
        return f'<Content name="{name}"><url>{escape(v)}</url></Content>'
    raise ValueError(f"{class_name}.{name}: no XML writer for {t}")


def build_place():
    lua, math_lib = new_runtime()
    api = lua.table_from(load_api(), recursive=True)
    mock = load_chunk(lua, TESTS / "mock_roblox.lua", math_lib, api)
    run = lua.eval("""function(mock, source)
        local game = mock.newGame()
        mock.context = "plugin"
        mock.runSource(source, "ChadBaseplate_Installer")
        return game
    end""")
    game = run(mock, INSTALLER.read_text())
    db = load_db()

    def children(inst):
        kids = inst["__children"]
        return [kids[i] for i in range(1, len(kids) + 1) if kids[i]["__class"] not in SKIP_CLASSES]

    services = {s["__class"]: s for s in children(game)}
    roots = [services[name] for name in SERVICES if name in services]

    tag = lua.eval("function(t, v) rawset(t, '__ref', v) end")
    raw_get = lua.eval("function(t, k) if type(t) == 'table' then return rawget(t, k) end end")
    count = 0

    def number(inst):
        nonlocal count
        tag(inst, f"RBX{count:032X}")
        count += 1
        for c in children(inst):
            number(c)

    for r in roots:
        number(r)

    def item(inst, depth):
        cls = inst["__class"]
        pad = "\t" * depth
        props = inst["__props"]
        lines = [f'{pad}<Item class="{cls}" referent="{inst["__ref"]}">', f"{pad}\t<Properties>"]
        name = props["Name"] if props["Name"] is not None else cls
        lines.append(f'{pad}\t\t<string name="Name">{escape(name)}</string>')
        for key in sorted(k for k in props.keys() if not str(k).startswith("__") and k != "Name"):
            value = props[key]
            if raw_get(value, "__instance") and raw_get(value, "__ref") is None:
                continue  # points at something Studio creates itself (CurrentCamera)
            ser_name, data_type = property_info(db, cls, key)
            lines.append(f"{pad}\t\t" + write_value(ser_name, data_type, value, cls))
        lines.append(f"{pad}\t</Properties>")
        for c in children(inst):
            lines.extend(item(c, depth + 1))
        lines.append(f"{pad}</Item>")
        return lines

    out = [
        '<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">',
        '\t<Meta name="ExplicitAutoJoints">true</Meta>',
        "\t<External>null</External>",
        "\t<External>nil</External>",
    ]
    for r in roots:
        out.extend(item(r, 1))
    out.append("</roblox>")
    OUT.write_text("\n".join(out) + "\n")
    print(f"wrote {OUT.relative_to(ROOT)} ({OUT.stat().st_size // 1024} KB, {count} instances)")


def validate(path=OUT):
    """Re-read the place: well-formed XML, refs resolve, scripts match src/."""
    tree = ET.parse(path)  # our own generated file, not untrusted input
    items = list(tree.iter("Item"))
    referents = {i.get("referent") for i in items}
    problems = []

    for ref in tree.iter("Ref"):
        if ref.text != "null" and ref.text not in referents:
            problems.append(f"dangling Ref {ref.get('name')} -> {ref.text}")

    def find(cls, name):
        for i in items:
            if i.get("class") == cls and i.find("Properties/string[@name='Name']").text == name:
                return i
        return None

    sources = {
        ("ModuleScript", "ChadConfig"): "shared/ChadConfig.luau",
        ("LocalScript", "ChadAnimate"): "client/init.client.luau",
        ("ModuleScript", "Rig"): "client/Rig.luau",
        ("ModuleScript", "Gait"): "client/Gait.luau",
        ("LocalScript", "Animate"): "character/Animate.client.luau",
    }
    for (cls, name), rel in sources.items():
        node = find(cls, name)
        text = node.find("Properties/ProtectedString[@name='Source']").text if node is not None else None
        if text != (ROOT / "src" / rel).read_text():
            problems.append(f"{cls} {name} source differs from src/{rel}")

    dummy = find("Model", "StarterCharacter")
    if dummy is None:
        problems.append("no StarterCharacter")
    else:
        motors = [i for i in dummy.iter("Item") if i.get("class") == "Motor6D"]
        if len(motors) != 15:
            problems.append(f"dummy has {len(motors)} Motor6Ds")
    for need in (("Part", "Baseplate"), ("SpawnLocation", "SpawnLocation")):
        if find(*need) is None:
            problems.append(f"missing {need[0]} {need[1]}")
    return problems, len(items)


if __name__ == "__main__":
    build_place()
    problems, count = validate()
    for p in problems:
        print("  FAIL", p)
    print(f"validated {count} items, {len(problems)} problems")
    sys.exit(1 if problems else 0)
