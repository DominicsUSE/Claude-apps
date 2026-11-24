"""Build the animation page for Short 01. render(t) draws one frame; Playwright captures it.

Usage: python build_page.py <timeline.json> <out.html>
"""
import json, re, sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from build import sheet

TL = json.load(open(sys.argv[1]))
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, "..")

desk = open(os.path.join(ROOT, "desk.svg")).read()
DESK_DEFS = desk[desk.index("<defs>") + 6: desk.index("</defs>")].replace("<style>@import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&amp;display=swap');</style>", "")
cast = sheet(os.path.join(ROOT, "..", "character-lineup.svg"))
CAST_DEFS = cast[cast.index("<defs>") + 6: cast.index("</defs>")]
for f in ("wob", "paint", "bleed"):  # make line boil possible: tag turbulences
    pass
CAST_DEFS = CAST_DEFS.replace('<feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7"/>',
                              '<feTurbulence class="boil" type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="7"/>')
CAST_DEFS = CAST_DEFS.replace('<feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="4" result="n"/>',
                              '<feTurbulence class="boil" type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="4" result="n"/>')

def block(name, nxt):
    m = re.search(rf'<!-- {name} -->\s*<g transform="translate\(\d+ 860\)( scale\(1.4\))?">(.*?)</g>\s*<!-- {nxt} -->', cast, re.S)
    inner = m.group(2)
    details = inner[inner.index("<g filter"):].strip()
    return details

DET = {n: block(n.upper(), nx) for n, nx in
       (("deb", "MARCUS"), ("marcus", "PRIYA"), ("priya", "GORD"), ("gord", "WENDY"), ("wendy", "LENNY"))}
DET["lenny"] = re.search(r'<!-- LENNY -->\s*<g transform="translate\(1650 860\) scale\(1.4\)">(.*?)\s*</g>\s*<!-- names -->', cast, re.S).group(1)
DET["lenny"] = DET["lenny"][DET["lenny"].index("<g filter"):]

def cut(name, *snips):
    for s in snips:
        assert s in DET[name], (name, s)
        DET[name] = DET[name].replace(s, "")
cut("deb", '<ellipse cx="0" cy="-282" rx="11" ry="8" fill="#3B2F28"/>',
    '<ellipse cx="0" cy="-278" rx="6" ry="3" fill="#D98A4E" stroke="none"/>')
cut("marcus", '<path d="M-14 -470 Q2 -460 20 -476"/>')
cut("priya", '<line x1="-8" y1="-260" x2="8" y2="-260"/>')
cut("gord", '<path d="M-8 -398 Q0 -394 8 -398"/>')
cut("wendy", '<path d="M-19 -436 Q0 -410 19 -436 Z" fill="#3B2F28"/>', '<path d="M-14 -434 L14 -434" stroke="#FBF6EA" stroke-width="3"/>')
ANGRY = '<line x1="-27" y1="-323" x2="-8" y2="-315"/><line x1="27" y1="-323" x2="8" y2="-315"/>'
assert ANGRY.split("/>")[0] + "/>" in DET["deb"]
DEB_SAD = DET["deb"].replace('<line x1="-27" y1="-323" x2="-8" y2="-315"/>', '<line x1="-27" y1="-315" x2="-8" y2="-322"/>') \
                    .replace('<line x1="27" y1="-323" x2="8" y2="-315"/>', '<line x1="27" y1="-315" x2="8" y2="-322"/>') \
                    .replace("</g>", '<path d="M-20 -296 Q-24 -284 -20 -280 Q-15 -284 -20 -296 Z" fill="#8FAAA4" stroke-width="1.5"/></g>', 1)

INK = "#3B2F28"
def mouths(cx, cy, closed, hw, hh, ww, wh, extra=""):
    o = f'stroke="{INK}" stroke-width="2.5"'
    return [f'<path d="{closed}" fill="none" stroke="{INK}" stroke-width="3" stroke-linecap="round"/>',
            f'<ellipse cx="{cx}" cy="{cy}" rx="{hw}" ry="{hh}" fill="{INK}" {o}/>',
            f'<ellipse cx="{cx}" cy="{cy}" rx="{ww}" ry="{wh}" fill="{INK}" {o}/>{extra}']
MOUTH = {
    "deb": mouths(0, -281, "M-9 -281 Q0 -285 9 -281", 7, 4.5, 11, 9, '<ellipse cx="0" cy="-276" rx="6" ry="3" fill="#D98A4E"/>'),
    "deb_sad": mouths(0, -280, "M-9 -278 Q0 -286 9 -278", 7, 4.5, 11, 9),
    "marcus": mouths(3, -471, "M-14 -470 Q2 -460 20 -476", 7, 4, 10, 7),
    "priya": mouths(0, -260, "M-8 -260 L8 -260", 4.5, 3, 6.5, 5),
    "gord": mouths(0, -398, "M-8 -398 Q0 -394 8 -398", 6, 3.5, 8, 6),
    "wendy": [f'<path d="M-18 -434 Q0 -418 18 -434" fill="none" stroke="{INK}" stroke-width="3" stroke-linecap="round"/>',
              f'<path d="M-15 -435 Q0 -420 15 -435 Z" fill="{INK}" stroke="{INK}" stroke-width="2.5"/>',
              f'<path d="M-19 -436 Q0 -410 19 -436 Z" fill="{INK}" stroke="{INK}" stroke-width="2.5"/><path d="M-14 -434 L14 -434" stroke="#FBF6EA" stroke-width="3"/>'],
}
def body(name):
    return (f'<use href="#{name}" transform="translate(7 5)" opacity="0.45" filter="url(#bleed)" style="mix-blend-mode:multiply"/>'
            f'<use href="#{name}" stroke="{INK}" stroke-width="3" stroke-linejoin="round" filter="url(#paint)"/>')
CHARS = {n: dict(body=body(n), face=DET[n]) for n in ("deb", "marcus", "priya", "gord", "wendy", "lenny")}
CHARS["deb_sad"] = dict(body=body("deb"), face=DEB_SAD)

T = 'font-family="Caveat, cursive" stroke="none"'
A = 'font-family="Arial Black, Arial" stroke="none"'
CANDLES = [(270, 660), (330, 622), (430, 600), (660, 600), (760, 625), (820, 665), (300, 775), (780, 770), (540, 812)]

def street(h=1100):
    return f'''<path d="M0 250 L0 150 L90 150 L90 120 L230 120 L230 160 L360 160 L360 110 L520 110 L520 150 L640 150 L640 175 L700 175 L700 250 Z" fill="#E4D3B4"/>
<g fill="#B9C8D3">{''.join(f'<rect x="{x}" y="{y}" width="34" height="34"/>' for x, y in ((20,175),(130,150),(180,150),(270,190),(400,140),(460,140),(560,180)))}</g>
<rect x="380" y="200" width="120" height="34" fill="#D9A441"/>
<text x="440" y="225" text-anchor="middle" {T} font-weight="700" font-size="22" fill="{INK}">TAXES &amp; TANS</text>
<rect x="0" y="250" width="880" height="42" fill="#DCD2C2"/>
<rect x="0" y="292" width="880" height="{h-292}" fill="#9C9184"/>
<g stroke="#D9A441" stroke-width="7" stroke-dasharray="46 34"><line x1="0" y1="362" x2="880" y2="362"/></g>'''

def pothole(cx=540, cy=700, rx=300, ry=105):
    return f'''<ellipse cx="{cx}" cy="{cy}" rx="{rx}" ry="{ry}" fill="#5A4F48"/>
<ellipse cx="{cx}" cy="{cy+12}" rx="{rx-38}" ry="{ry-29}" fill="#8FAAA4"/>
<path d="M{cx-120} {cy} Q{cx-70} {cy-10} {cx-20} {cy} M{cx+60} {cy+35} Q{cx+110} {cy+25} {cx+160} {cy+35}" fill="none" stroke="#FBF6EA" stroke-opacity="0.6"/>'''

DUCK = lambda x, y: f'''<ellipse cx="{x}" cy="{y}" rx="30" ry="18" fill="#D9A441"/><circle cx="{x+22}" cy="{y-24}" r="14" fill="#D9A441"/>
<path d="M{x+34} {y-26} L{x+50} {y-22} L{x+34} {y-18} Z" fill="#D98A4E"/><circle cx="{x+24}" cy="{y-28}" r="2.5" fill="{INK}" stroke="none"/>'''
CONE = lambda x, y: f'<path d="M{x-23} {y} L{x+23} {y} L{x+11} {y-68} L{x-11} {y-68} Z" fill="#D98A4E"/><rect x="{x-9}" y="{y-44}" width="18" height="11" fill="#FBF6EA"/>'

BARRY_SCENE = street() + pothole() + DUCK(600, 708) + ''.join(f'<rect x="{x-7}" y="{y-14}" width="14" height="28" fill="#FBF6EA"/>' for x, y in CANDLES) + f'''
<g><line x1="250" y1="760" x2="250" y2="722"/><circle cx="250" cy="714" r="12" fill="#D98A4E"/><circle cx="238" cy="726" r="7" fill="#7E9C7A"/>
<line x1="835" y1="768" x2="835" y2="730"/><circle cx="835" cy="722" r="12" fill="#D9A441"/></g>
<line x1="450" y1="598" x2="436" y2="640"/><line x1="490" y1="598" x2="504" y2="640"/>
<rect x="435" y="545" width="70" height="56" fill="#FBF6EA"/><ellipse cx="470" cy="575" rx="22" ry="9" fill="#5A4F48"/>
<line x1="728" y1="610" x2="728" y2="540" stroke-width="4"/><rect x="668" y="500" width="120" height="52" fill="#C8B08A"/>
<text x="728" y="530" text-anchor="middle" {T} font-weight="700" font-size="30" fill="{INK}">BARRY</text>
<text x="728" y="547" text-anchor="middle" {T} font-size="16" fill="{INK}">est. 2015</text>''' + CONE(843, 880)
FLAMES = ''.join(f'<circle cx="{x}" cy="{y-22}" r="16" fill="#FFC86B" filter="url(#glow)" opacity="0.55"/><ellipse cx="{x}" cy="{y-22}" rx="5" ry="9" fill="#F0A33C"/><ellipse cx="{x}" cy="{y-20}" rx="2.5" ry="5" fill="#FBE7A8"/>' for x, y in CANDLES)
TOWERS = '''<g stroke="#5E7A99" stroke-width="1.5">
<rect x="700" y="70" width="60" height="180" fill="#A9BACB"/><rect x="765" y="30" width="62" height="220" fill="#8FA6BD"/><rect x="832" y="95" width="48" height="155" fill="#A9BACB"/>
<g stroke="#E6ECF2" stroke-width="1">''' + ''.join(f'<line x1="{a}" y1="{y}" x2="{b}" y2="{y}"/>' for a, b, t in ((700,760,70),(765,827,30),(832,880,95)) for y in range(t + 12, 246, 15)) + '</g></g>'

PHONE = f'''<rect x="170" y="80" width="540" height="960" rx="60" fill="#3A322D"/>
<rect x="196" y="140" width="488" height="840" rx="16" fill="#FBF6EA"/>
<rect x="196" y="140" width="488" height="90" fill="#D98A4E"/>
<text x="230" y="200" {T} font-weight="700" font-size="44" fill="#FBF6EA">Porchlight</text>
<circle cx="640" cy="185" r="18" fill="#FBF6EA"/>
<text x="440" y="270" text-anchor="middle" {T} font-size="26" fill="#8C8178">Lesser Pemberton Concerned Residents</text>
<line x1="220" y1="290" x2="660" y2="290" stroke="#C8B08A"/>
<circle cx="256" cy="345" r="30" fill="#D9A441"/>
<text x="300" y="342" {T} font-weight="700" font-size="34" fill="{INK}">Deb K.</text>
<text x="300" y="370" {T} font-size="24" fill="#8C8178">Moderator · just now</text>
<rect x="400" y="80" width="80" height="14" rx="7" fill="#5A4F48"/>'''

TABLE = f'''<rect x="430" y="770" width="400" height="26" fill="#C8B08A"/>
<line x1="460" y1="796" x2="440" y2="1000" stroke-width="5"/><line x1="800" y1="796" x2="820" y2="1000" stroke-width="5"/>
<path d="M500 770 L520 680 L560 660 L620 660 L660 680 L680 770 Z" fill="#D98A4E"/>
<path d="M520 680 L490 740 L505 748 L530 700 M660 680 L690 740 L675 748 L650 700" fill="#D98A4E"/>
<text x="590" y="715" text-anchor="middle" {T} font-weight="700" font-size="22" fill="#FBF6EA">I SURVIVED</text>
<text x="590" y="742" text-anchor="middle" {T} font-weight="700" font-size="28" fill="#FBF6EA">BARRY</text>
<line x1="760" y1="770" x2="760" y2="700" stroke-width="4"/><rect x="738" y="660" width="44" height="44" rx="6" fill="#5A4F48"/>
<rect x="746" y="668" width="28" height="12" fill="#7E9C7A"/>
<rect x="700" y="610" width="130" height="40" fill="#FBF6EA" transform="rotate(4 765 630)"/>
<text x="765" y="638" text-anchor="middle" {T} font-weight="700" font-size="24" fill="#A8402A" transform="rotate(4 765 630)">$65 / hoodie</text>'''

TRUCK = f'''<rect x="0" y="-90" width="120" height="90" rx="10" fill="#D9A441"/><rect x="18" y="-75" width="60" height="38" fill="#B9C8D3"/>
<rect x="110" y="-60" width="170" height="60" fill="#C8B08A"/><rect x="40" y="-112" width="28" height="22" fill="#D98A4E"/>
<circle cx="45" cy="6" r="22" fill="#3A322D"/><circle cx="230" cy="6" r="22" fill="#3A322D"/>'''

NIGHT = f'''<rect x="0" y="0" width="880" height="1100" fill="#3B4656"/>
<circle cx="140" cy="140" r="46" fill="#F1E2B8"/>
<g stroke="#2E3A4A" stroke-width="1.5">
<rect x="380" y="200" width="90" height="300" fill="#5E7A99"/><rect x="480" y="120" width="110" height="380" fill="#6D88A6"/>
<rect x="600" y="230" width="80" height="270" fill="#5E7A99"/><rect x="690" y="160" width="110" height="340" fill="#6D88A6"/></g>
<g fill="#F2D27E">{''.join(f'<rect x="{x}" y="{y}" width="12" height="16"/>' for x in (395,430,500,540,570,615,650,710,750,780) for y in (230,290,350,410) if (x+y)%3)}</g>
<rect x="0" y="500" width="880" height="160" fill="#5A5550"/>
<g stroke="#F3E9D2" stroke-width="5" stroke-dasharray="40 30"><line x1="0" y1="580" x2="880" y2="580"/></g>
<rect x="0" y="660" width="880" height="440" fill="#4A4540"/>
<line x1="0" y1="660" x2="880" y2="660" stroke-width="5"/>
<g>{''.join(f'<line x1="{x}" y1="620" x2="{x}" y2="660"/>' for x in range(20, 880, 40))}</g><line x1="0" y1="620" x2="880" y2="620" stroke-width="4"/>'''
BLUE_TRUCK = '''<g stroke="#2E3A4A" stroke-width="2"><rect x="0" y="-70" width="100" height="70" rx="8" fill="#8FA6BD"/>
<rect x="95" y="-50" width="160" height="50" fill="#A9BACB"/><circle cx="40" cy="4" r="16" fill="#2E3A4A"/><circle cx="210" cy="4" r="16" fill="#2E3A4A"/>
<rect x="-8" y="-90" width="40" height="70" rx="20" fill="#5E7A99"/></g>'''

MORNING = street() + f'''<rect x="240" y="600" width="600" height="210" rx="100" fill="#ADA395"/>
<path d="M500 690 L600 700 L700 690 L690 720 L600 712 L510 720 Z" fill="#D98A4E"/>
<path d="M600 704 C560 650 520 650 540 690 C560 720 590 712 600 704 C610 712 640 720 660 690 C680 650 640 650 600 704 Z" fill="#D98A4E"/>
<rect x="640" y="730" width="120" height="70" fill="#FBF6EA" transform="rotate(-6 700 765)"/>
<text x="700" y="760" text-anchor="middle" {T} font-size="22" fill="#5E7A99" transform="rotate(-6 700 765)">with love,</text>
<text x="700" y="786" text-anchor="middle" {T} font-weight="700" font-size="22" fill="#5E7A99" transform="rotate(-6 700 765)">Greater Pemberton</text>''' + DUCK(420, 760) + \
    '<g transform="translate(820 960) rotate(78)"><ellipse cx="-11" cy="20" rx="10" ry="16" fill="#D9A441"/><ellipse cx="11" cy="20" rx="10" ry="16" fill="#D9A441"/><path d="M-7 -28 L-30 -178 L-14 -182 L7 -30 Z" fill="#FBF6EA"/><path d="M7 -28 L30 -178 L14 -182 L-7 -30 Z" fill="#FBF6EA"/></g>'

PRIYA_BG = f'''<rect x="0" y="0" width="880" height="1100" fill="#E4D3B4"/>
<rect x="0" y="0" width="880" height="560" fill="#EADBC0"/>
<rect x="60" y="120" width="320" height="300" fill="#B9C8D3"/><line x1="220" y1="120" x2="220" y2="420"/>
<rect x="520" y="140" width="260" height="70" fill="#D98A4E"/>
<text x="650" y="188" text-anchor="middle" {T} font-weight="700" font-size="40" fill="{INK}">PHONE FIX</text>
<rect x="0" y="820" width="880" height="280" fill="#C8B08A"/><line x1="0" y1="820" x2="880" y2="820" stroke-width="4"/>'''

LENNY_NIGHT = f'''<rect x="0" y="0" width="880" height="1100" fill="#3B4656"/>
<rect x="0" y="250" width="880" height="42" fill="#55616E"/><rect x="0" y="292" width="880" height="808" fill="#4E4A46"/>
<g stroke="#9C8A4E" stroke-width="7" stroke-dasharray="46 34"><line x1="0" y1="362" x2="880" y2="362"/></g>
<rect x="240" y="600" width="600" height="210" rx="100" fill="#5C5751"/>'''
HOLE = '<ellipse cx="420" cy="780" rx="120" ry="40" fill="#2A2522"/>'
JACKHAMMER = '''<rect x="-14" y="-260" width="28" height="200" fill="#8C8178"/><rect x="-70" y="-280" width="140" height="22" rx="10" fill="#D9A441"/>
<rect x="-6" y="-60" width="12" height="60" fill="#5A4F48"/>'''

def painted(svg, key):
    # props drawn above y=0 are shifted down 300 so they sit inside the paint filter region
    if key in ("truck", "btruck", "jack"):
        svg = f'<g transform="translate(0 300)">{svg}</g>'
    return (f'<defs><g id="bg_{key}">{svg}</g></defs>'
            f'<use href="#bg_{key}" transform="translate(5 4)" opacity="0.42" filter="url(#bleedS)" style="mix-blend-mode:multiply"/>'
            f'<use href="#bg_{key}" stroke="{INK}" stroke-width="2.6" stroke-linejoin="round" filter="url(#paintS)"/>')

BG = {k: painted(v, k) for k, v in dict(barry=BARRY_SCENE, phone=PHONE, street=street() + pothole(540, 1040, 360, 110),
                                        table=TABLE, wendy=street() + pothole(560, 900, 330, 110),
                                        gord=street(), truck=TRUCK, night=NIGHT, btruck=BLUE_TRUCK, morning=MORNING,
                                        priya=PRIYA_BG, lnight=LENNY_NIGHT, hole=HOLE, jack=JACKHAMMER).items()}
BG["towers"] = TOWERS
BG["flames"] = FLAMES

FILTERS = '''
<filter id="paintS" filterUnits="userSpaceOnUse" x="-40" y="-40" width="960" height="1180">
  <feTurbulence class="boil" type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="4" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.5" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="4" seed="9" result="m"/>
  <feColorMatrix in="m" type="matrix" values="0.35 0 0 0 0.72  0.35 0 0 0 0.72  0.35 0 0 0 0.72  0 0 0 0 1" result="mg"/>
  <feBlend in="d" in2="mg" mode="multiply" result="b"/><feComposite in="b" in2="d" operator="in"/>
</filter>
<filter id="bleedS" filterUnits="userSpaceOnUse" x="-40" y="-40" width="960" height="1180">
  <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="13" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="12" result="d"/><feGaussianBlur in="d" stdDeviation="1.6"/>
</filter>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
<filter id="stampF" x="-10%" y="-10%" width="120%" height="120%">
  <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="5" result="t"/>
  <feColorMatrix in="t" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -5 4.1" result="m"/>
  <feComposite in="SourceGraphic" in2="m" operator="in"/>
</filter>
<clipPath id="sceneclip"><rect width="880" height="1100"/></clipPath>
'''

html = open(os.path.join(HERE, "page_template.html")).read()
html = html.replace("/*DATA*/", "const TL = " + json.dumps(TL) + ";\nconst CH = " + json.dumps(CHARS) + ";\nconst MOUTH = " + json.dumps(MOUTH) + ";\nconst BG = " + json.dumps(BG) + ";")
html = html.replace("<!--DEFS-->", DESK_DEFS + CAST_DEFS + FILTERS)
open(sys.argv[2], "w").write(html)
print("ok", len(html))
