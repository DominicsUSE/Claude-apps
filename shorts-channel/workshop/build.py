"""Compose Lesser Pemberton character sheets into a warm 'artist's desk' scene.

Takes the flat riso SVG sheets, recolours them to the workshop palette, swaps the
riso misprint for watercolour bleed + pencil lines, and lays the sheet on a lit desk.
Usage: python3 build.py <source.svg> <out.svg> <scene-key>
"""
import re, sys

PALETTE = {  # riso ink -> workshop palette
    "#FF48B0": "#D98A4E", "#00838A": "#7E9C7A", "#FFE800": "#D9A441",
    "#F4EFE4": "#FBF6EA", "#1E1B1A": "#3B2F28", "#CDB98A": "#C8B08A",
    "#474241": "#5A4F48", "#3B3B3B": "#4A403A", "#2B2B2B": "#3A322D",
    "#8E8A86": "#8C8178", "#D9D4CC": "#DCD2C2", "#FBFAF6": "#FBF6EA",
    "#3D5588": "#5E7A99", "#9FB0D6": "#A9BACB", "#C9D3EA": "#D5DEE6",
    "#FFFFFF": "#F4F6F8",
}

NOTES = {  # scene -> (title, one note per column, shown under the names)
    "cast": ("Main cast", ["posts in CAPS", "two phones. always.", "screen time: 11h 42m",
                           "stuck in 1987", "ribbon not included", "only competent resident"]),
    "support": ("Supporting cast", ["Ward 3. bins??", "from Greater Pemberton",
                                    "face never seen", "taxes up top, beach below",
                                    "Marcus's landlord", "on break since March"]),
}
COLS = [150, 450, 750, 1050, 1350, 1650]

FILTERS = """
<filter id="paint" filterUnits="userSpaceOnUse" x="-300" y="-700" width="600" height="760">
  <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="4" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.5" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.018" numOctaves="4" seed="9" result="m"/>
  <feColorMatrix in="m" type="matrix" values="0.35 0 0 0 0.72  0.35 0 0 0 0.72  0.35 0 0 0 0.72  0 0 0 0 1" result="mg"/>
  <feBlend in="d" in2="mg" mode="multiply" result="b"/>
  <feComposite in="b" in2="d" operator="in"/>
</filter>
<filter id="bleed" filterUnits="userSpaceOnUse" x="-300" y="-700" width="600" height="760">
  <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="13" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="12" result="d"/>
  <feGaussianBlur in="d" stdDeviation="1.6"/>
</filter>
"""

def sheet(src):
    s = open(src).read()
    for a, b in PALETTE.items():
        s = re.sub(a, b, s, flags=re.I)
    s = re.sub(r'<rect (y="230" )?width="1800" height="(770|1000)" fill="#[0-9A-Fa-f]+"/>', "", s)
    s = re.sub(r'<rect y="860"[^>]*/>', "", s)
    s = re.sub(r'<rect (y="230" )?width="1800" height="(770|1000)" filter="url\(#grain\)"[^>]*/>', "", s)
    s = re.sub(r'<g transform="translate\(40 255\) rotate\(-3\)">.*?</g>', "", s, flags=re.S)
    s = re.sub(r'<g fill="#3B2F28" opacity="0.12">', '<g fill="#3B2F28" opacity="0.07">', s)
    s = re.sub(r'transform="translate\((\d) (\d)\)" opacity="0.9" style="mix-blend-mode:multiply"',
               r'transform="translate(\1 \2)" opacity="0.45" filter="url(#bleed)" style="mix-blend-mode:multiply"', s)
    s = re.sub(r'stroke="#3B2F28" stroke-width="(4.5|3.5)" stroke-linejoin="round" filter="url\(#wob\)"',
               'stroke="#3B2F28" stroke-width="3" stroke-linejoin="round" filter="url(#paint)"', s)
    s = s.replace('stroke-width="4" stroke-linecap="round"', 'stroke-width="3" stroke-linecap="round"')
    s = s.replace('font-family="Arial Black, Arial, sans-serif" font-weight="900" font-size="30"',
                  'font-family="Caveat, cursive" font-weight="700" font-size="46"')
    s = s.replace("</defs>", FILTERS + "</defs>", 1)
    s = re.sub(r"<svg [^>]*>", '<svg x="0" y="0" width="1800" height="770" viewBox="0 230 1800 770" overflow="visible">', s, count=1)
    return s

def notes(key):
    title, items = NOTES[key]
    out = [f'<text x="40" y="300" font-family="Caveat, cursive" font-weight="700" font-size="62" fill="#3B2F28">{title}</text>',
           '<path d="M40 314 Q190 306 340 316" fill="none" stroke="#3B2F28" stroke-width="2.5" opacity="0.7"/>']
    for i, (x, t) in enumerate(zip(COLS, items)):
        y, r = 982, (-3, 2, -2, 3, -2, 2)[i]
        out.append(f'<text x="{x}" y="{y}" text-anchor="middle" transform="rotate({r} {x} {y})" '
                   f'font-family="Caveat, cursive" font-size="34" fill="#9A4E2C">{t}</text>')
    return '<g transform="translate(0 -230)">' + "".join(out) + "</g>"

DESK = open(__file__.replace("build.py", "desk.svg")).read()

if __name__ == "__main__":
    src, out, key = sys.argv[1:4]
    body = sheet(src) + notes(key)
    open(out, "w").write(DESK.replace("<!--SHEET-->", body))
