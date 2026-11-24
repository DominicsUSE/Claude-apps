"""Lay six Lesser Pemberton location sketches on the workshop desk as taped cards."""
import re

T = 'font-family="Caveat, cursive" stroke="none"'
A = 'font-family="Arial Black, Arial" stroke="none"'

PLAZA = f'''
<rect x="0" y="210" width="520" height="90" fill="#B9AE9E"/>
<g stroke="#FBF6EA" stroke-width="4">{''.join(f'<line x1="{x}" y1="226" x2="{x-10}" y2="290"/>' for x in (70,150,230,310,390))}</g>
<rect x="15" y="80" width="440" height="135" fill="#E4D3B4"/>
<rect x="10" y="66" width="450" height="18" fill="#7E9C7A"/>
''' + ''.join(f'''<rect x="{15+88*i+8}" y="128" width="72" height="72" fill="#B9C8D3"/>
<rect x="{15+88*i+5}" y="92" width="78" height="26" fill="{c}"/>
<text x="{15+88*i+44}" y="111" text-anchor="middle" {T} font-weight="700" font-size="16" fill="#3B2F28">{n}</text>'''
  for i, (n, c) in enumerate([("PHONE FIX", "#D98A4E"), ("TAXES &amp; TANS", "#D9A441"), ("", "#FBF6EA"),
                              ("VALUMORE", "#7E9C7A"), ("CLOUD NEIN", "#FBF6EA")])) + f'''
<rect x="200" y="140" width="40" height="28" fill="#FBF6EA"/>
<text x="220" y="158" text-anchor="middle" {T} font-size="12" fill="#A8402A">FOR LEASE</text>
<path d="M385 175 a12 12 0 0 1 20 -10 a12 12 0 0 1 22 4 a10 10 0 0 1 -4 18 h-34 a8 8 0 0 1 -4 -12 z" fill="#FBF6EA"/>
<rect x="463" y="168" width="52" height="44" fill="#5F7A63"/>
<rect x="460" y="160" width="58" height="10" fill="#4E6652"/>
<rect x="470" y="168" width="24" height="9" fill="#3A322D"/>
<circle cx="477" cy="172" r="2.4" fill="#FBF6EA" stroke="none"/><circle cx="487" cy="172" r="2.4" fill="#FBF6EA" stroke="none"/>
<line x1="505" y1="160" x2="505" y2="138"/><path d="M495 140 L515 140 L510 128 L500 128 Z" fill="#D9A441"/>
<g fill="none"><path d="M240 238 L290 238 L284 262 L246 262 Z M236 230 L240 238"/><circle cx="250" cy="268" r="4"/><circle cx="280" cy="268" r="4"/></g>
'''

HALL = f'''
<rect x="0" y="240" width="520" height="60" fill="#B9AE9E"/>
<rect x="0" y="230" width="520" height="12" fill="#A7B98F"/>
<rect x="130" y="150" width="260" height="92" fill="#E4D3B4"/>
<path d="M100 150 L420 150 L380 85 L140 85 Z" fill="#B5563A"/>
<rect x="200" y="98" width="120" height="34" fill="#FBF6EA"/>
<text x="260" y="125" text-anchor="middle" {A} font-size="24" fill="#B5563A" letter-spacing="2">PIZZ<tspan opacity="0.18">A</tspan></text>
<rect x="150" y="168" width="40" height="40" fill="#D98A4E"/><rect x="330" y="168" width="40" height="40" fill="#D98A4E"/>
<g stroke="#FBF6EA" stroke-width="3"><line x1="170" y1="168" x2="170" y2="208"/><line x1="150" y1="188" x2="190" y2="188"/>
<line x1="350" y1="168" x2="350" y2="208"/><line x1="330" y1="188" x2="370" y2="188"/></g>
<rect x="240" y="196" width="40" height="46" fill="#8B5E3C"/>
<g transform="rotate(-4 260 166)"><rect x="185" y="152" width="150" height="28" fill="#FBF6EA"/>
<text x="260" y="173" text-anchor="middle" {T} font-weight="700" font-size="22" fill="#3B2F28">TOWN HALL</text></g>
<line x1="455" y1="240" x2="455" y2="58"/><rect x="455" y="60" width="50" height="32" fill="#7E9C7A"/>
<text x="480" y="83" text-anchor="middle" {T} font-weight="700" font-size="20" fill="#FBF6EA">LP</text>
<path d="M66 240 L108 240 L102 200 L72 200 Z" fill="#8B5E3C"/><line x1="87" y1="200" x2="94" y2="184"/><circle cx="95" cy="182" r="4" fill="#3B2F28"/>
'''

PORCH = f'''
<rect x="0" y="248" width="520" height="52" fill="#A7B98F"/>
<rect x="40" y="40" width="440" height="210" fill="#EBC9A8"/>
<g stroke-opacity="0.25">{''.join(f'<line x1="40" y1="{y}" x2="480" y2="{y}"/>' for y in range(60, 250, 20))}</g>
<rect x="30" y="28" width="460" height="16" fill="#8B5E3C"/>
<rect x="80" y="90" width="100" height="80" fill="#4A403A"/>
<rect x="80" y="90" width="22" height="80" fill="#D9A441"/><rect x="158" y="90" width="22" height="80" fill="#D9A441"/>
<circle cx="124" cy="128" r="3.5" fill="#FBF6EA" stroke="none"/><circle cx="138" cy="128" r="3.5" fill="#FBF6EA" stroke="none"/>
<rect x="370" y="90" width="80" height="80" fill="#B9C8D3"/><line x1="410" y1="90" x2="410" y2="170"/><line x1="370" y1="130" x2="450" y2="130"/>
<rect x="230" y="110" width="80" height="140" fill="#7E9C7A"/><circle cx="296" cy="182" r="4" fill="#D9A441"/>
<rect x="320" y="160" width="16" height="26" rx="4" fill="#3B2F28"/><circle cx="328" cy="168" r="3.5" fill="#D9562E" stroke="none"/>
<path d="M342 160 a14 14 0 0 1 0 18 M348 154 a22 22 0 0 1 0 30" fill="none" stroke="#D9562E"/>
<rect x="212" y="250" width="116" height="12" fill="#C8B08A"/><rect x="202" y="262" width="136" height="12" fill="#C8B08A"/>
<line x1="120" y1="262" x2="120" y2="296"/>
<rect x="56" y="212" width="128" height="52" fill="#FBF6EA"/>
<text x="120" y="234" text-anchor="middle" {T} font-weight="700" font-size="17" fill="#3B2F28">WE ARE WATCHING</text>
<text x="120" y="254" text-anchor="middle" {T} font-size="15" fill="#3B2F28">(lovingly)</text>
<path d="M428 266 L452 266 L440 238 Z" fill="#D98A4E"/><circle cx="440" cy="270" r="6" fill="#F2C6A8"/>
<path d="M432 272 L448 272 L440 286 Z" fill="#FBF6EA"/><rect x="432" y="282" width="16" height="14" fill="#7E9C7A"/>
<path d="M434 274 L440 290 L446 274" fill="none" stroke="#D9A441" stroke-width="2"/>
'''

BYPASS_CLEAN = '''
<g stroke="#5E7A99" stroke-width="1.5">
<rect x="250" y="64" width="50" height="138" fill="#A9BACB"/><rect x="305" y="30" width="60" height="172" fill="#8FA6BD"/>
<rect x="370" y="84" width="45" height="118" fill="#A9BACB"/><rect x="420" y="46" width="55" height="156" fill="#8FA6BD"/>
<rect x="480" y="98" width="40" height="104" fill="#A9BACB"/>
<g stroke="#E6ECF2" stroke-width="1">''' + ''.join(f'<line x1="{x0}" y1="{y}" x2="{x1}" y2="{y}"/>' for x0, x1, top in ((250,300,64),(305,365,30),(370,415,84),(420,475,46),(480,520,98)) for y in range(top+12, 200, 14)) + '''</g></g>
<circle cx="112" cy="58" r="26" fill="#F1D9A6"/>
'''
BYPASS = f'''
<rect x="0" y="200" width="520" height="60" fill="#9C9184"/>
<g stroke="#FBF6EA" stroke-width="3" stroke-dasharray="18 14"><line x1="0" y1="230" x2="520" y2="230"/></g>
<rect x="80" y="208" width="44" height="18" rx="4" fill="#D98A4E"/><rect x="300" y="236" width="48" height="18" rx="4" fill="#7E9C7A"/>
<rect x="0" y="256" width="520" height="44" fill="#C8BBA6"/>
<line x1="0" y1="232" x2="520" y2="232" stroke-width="3"/>
<g>{''.join(f'<line x1="{x}" y1="232" x2="{x}" y2="256"/>' for x in range(13, 520, 26))}</g>
<path d="M300 256 L310 270 L302 280 L316 300" fill="none"/>
<line x1="90" y1="256" x2="90" y2="165" stroke-width="5"/>
<rect x="10" y="100" width="172" height="72" fill="#FBF6EA"/><rect x="16" y="106" width="160" height="60" fill="none" stroke="#7E9C7A" stroke-width="3"/>
<text x="96" y="128" text-anchor="middle" {A} font-size="13" fill="#5F7A63">LESSER PEMBERTON</text>
<text x="96" y="148" text-anchor="middle" {T} font-weight="700" font-size="19" fill="#3B2F28">pop. 4,012</text>
<text x="96" y="163" text-anchor="middle" {T} font-size="14" fill="#3B2F28">(pending review)</text>
'''

BARRY = f'''
<path d="M0 100 L0 50 L60 50 L60 30 L140 30 L140 60 L230 60 L230 40 L330 40 L330 55 L430 55 L430 35 L520 35 L520 100 Z" fill="#E4D3B4"/>
<rect x="0" y="100" width="520" height="22" fill="#DCD2C2"/>
<rect x="0" y="122" width="520" height="178" fill="#9C9184"/>
<g stroke="#D9A441" stroke-width="5" stroke-dasharray="30 22"><line x1="0" y1="148" x2="520" y2="148"/></g>
<ellipse cx="270" cy="225" rx="150" ry="48" fill="#5A4F48"/>
<ellipse cx="270" cy="231" rx="128" ry="35" fill="#8FAAA4"/>
<ellipse cx="300" cy="230" rx="15" ry="9" fill="#D9A441"/><circle cx="311" cy="218" r="7" fill="#D9A441"/>
<path d="M317 218 L325 220 L317 222 Z" fill="#D98A4E"/>
''' + ''.join(f'<rect x="{x}" y="{y}" width="8" height="16" fill="#FBF6EA"/><ellipse cx="{x+4}" cy="{y-5}" rx="3" ry="5" fill="#E8A13C" stroke="none"/>'
              for x, y in ((140, 196), (178, 180), (380, 184), (412, 200), (168, 258), (360, 262))) + f'''
<g><line x1="118" y1="250" x2="118" y2="228"/><circle cx="118" cy="224" r="7" fill="#D98A4E"/>
<line x1="424" y1="258" x2="424" y2="236"/><circle cx="424" cy="232" r="7" fill="#D9A441"/></g>
<line x1="230" y1="196" x2="222" y2="214"/><line x1="250" y1="196" x2="258" y2="214"/>
<rect x="220" y="162" width="40" height="32" fill="#FBF6EA"/><ellipse cx="240" cy="180" rx="12" ry="5" fill="#5A4F48"/>
<line x1="372" y1="200" x2="372" y2="160"/><rect x="346" y="140" width="56" height="24" fill="#C8B08A"/>
<text x="374" y="158" text-anchor="middle" {T} font-weight="700" font-size="18" fill="#3B2F28">BARRY</text>
<path d="M58 276 L86 276 L78 236 L66 236 Z" fill="#D98A4E"/><rect x="66" y="250" width="12" height="7" fill="#FBF6EA"/>
<path d="M458 268 L486 268 L478 228 L466 228 Z" fill="#D98A4E"/><rect x="466" y="242" width="12" height="7" fill="#FBF6EA"/>
'''

GARAGE = f'''
<rect x="0" y="270" width="520" height="30" fill="#A7B98F"/><rect x="60" y="270" width="240" height="30" fill="#B9AE9E"/>
<rect x="30" y="90" width="300" height="180" fill="#E4D3B4"/>
<path d="M18 92 L180 30 L342 92 Z" fill="#8B5E3C"/>
<rect x="60" y="130" width="240" height="140" fill="#4A403A"/>
<rect x="60" y="120" width="240" height="12" fill="#C8B08A"/>
<rect x="80" y="145" width="44" height="50" fill="#FBF6EA"/>
<text x="102" y="166" text-anchor="middle" {T} font-weight="700" font-size="17" fill="#A8402A">1987</text>
<g stroke-width="1"><line x1="84" y1="174" x2="120" y2="174"/><line x1="84" y1="183" x2="120" y2="183"/></g>
<line x1="200" y1="172" x2="290" y2="172" stroke="#C8B08A" stroke-width="4"/>
<rect x="240" y="150" width="36" height="20" fill="#D9A441"/><line x1="270" y1="150" x2="280" y2="134"/>
<rect x="165" y="200" width="30" height="26" fill="#7E9C7A"/><rect x="160" y="228" width="40" height="8" fill="#7E9C7A"/>
<g stroke="#7E9C7A" stroke-width="4"><line x1="162" y1="236" x2="198" y2="268"/><line x1="198" y1="236" x2="162" y2="268"/></g>
<rect x="380" y="160" width="120" height="110" fill="#C8B08A"/>
<g stroke-opacity="0.35">{''.join(f'<line x1="{x}" y1="160" x2="{x}" y2="270"/>' for x in range(395, 500, 15))}</g>
<path d="M370 162 L440 112 L510 162 Z" fill="#B5563A"/>
<rect x="415" y="200" width="46" height="70" fill="#4A403A"/>
<rect x="420" y="242" width="38" height="18" fill="#D98A4E"/><circle cx="428" cy="264" r="5" fill="#3B2F28"/><circle cx="450" cy="264" r="5" fill="#3B2F28"/>
<path d="M418 52 C430 90 440 130 452 196" fill="none" stroke="#6B4A32" stroke-width="7"/>
<ellipse cx="420" cy="58" rx="14" ry="8" fill="#7E9C7A"/><ellipse cx="438" cy="80" rx="12" ry="7" fill="#7E9C7A"/><ellipse cx="410" cy="78" rx="10" ry="6" fill="#7E9C7A"/>
<rect x="468" y="178" width="58" height="24" fill="#FBF6EA" transform="rotate(6 497 190)"/>
<text x="497" y="196" text-anchor="middle" {T} font-weight="700" font-size="16" fill="#A8402A" transform="rotate(6 497 190)">$1,450/mo</text>
'''

CARDS = [  # (drawing, label, x, y, rotation, clean-overlay)
    (PLAZA, "Pemberton Plaza", 60, 100, -2, ""), (HALL, "Town Hall (ex-pizza place)", 670, 115, 1.5, ""),
    (PORCH, "Deb's porch", 1280, 100, -1, ""), (BYPASS, "The Bypass", 60, 640, 1, BYPASS_CLEAN),
    (BARRY, "Barry (the pothole)", 670, 650, -1.5, ""), (GARAGE, "Gord's garage + shed", 1280, 640, 2, ""),
]

FILTERS = '''
<filter id="paintC" filterUnits="userSpaceOnUse" x="-20" y="-20" width="560" height="340">
  <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="3" seed="4" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.2" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.02" numOctaves="4" seed="9" result="m"/>
  <feColorMatrix in="m" type="matrix" values="0.35 0 0 0 0.72  0.35 0 0 0 0.72  0.35 0 0 0 0.72  0 0 0 0 1" result="mg"/>
  <feBlend in="d" in2="mg" mode="multiply" result="b"/>
  <feComposite in="b" in2="d" operator="in"/>
</filter>
<filter id="bleedC" filterUnits="userSpaceOnUse" x="-20" y="-20" width="560" height="340">
  <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="13" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="10" result="d"/>
  <feGaussianBlur in="d" stdDeviation="1.4"/>
</filter>
<clipPath id="cardclip"><rect x="0" y="0" width="520" height="300"/></clipPath>
'''

def card(i, draw, label, x, y, r, clean):
    return f'''
<g transform="translate({x} {y}) rotate({r} 290 210)">
  <rect width="580" height="430" fill="#F3E9D2" filter="url(#shadow)"/>
  <rect width="580" height="430" filter="url(#fibre)"/>
  <defs><g id="card{i}">{draw}</g></defs>
  <g transform="translate(30 30)" clip-path="url(#cardclip)">
    <use href="#card{i}" transform="translate(4 3)" opacity="0.4" filter="url(#bleedC)" style="mix-blend-mode:multiply"/>
    {clean}
    <use href="#card{i}" stroke="#3B2F28" stroke-width="2.2" stroke-linejoin="round" filter="url(#paintC)"/>
  </g>
  <rect x="30" y="30" width="520" height="300" fill="none" stroke="#3B2F28" stroke-width="2" opacity="0.6"/>
  <text x="290" y="385" text-anchor="middle" font-family="Caveat, cursive" font-weight="700" font-size="40" fill="#3B2F28">{label}</text>
  <rect x="225" y="-16" width="130" height="38" fill="#E6D9B6" opacity="0.85" transform="rotate({-r*2} 290 3)"/>
</g>'''

desk = open("desk.svg").read()
desk = desk.replace("</defs>", FILTERS + "</defs>", 1)
start, end = desk.index("<!-- under-sheet -->"), desk.index("<!-- paper clip -->")
cards = "".join(card(i, *c) for i, c in enumerate(CARDS))
desk = desk[:start] + cards + desk[end:]
desk = re.sub(r"<!-- paper clip -->.*?<!-- pencil -->", "<!-- pencil -->", desk, flags=re.S)
desk = re.sub(r"<!-- eraser -->.*?<!-- light -->", "<!-- light -->", desk, flags=re.S)
desk = desk.replace("translate(1290 1120) rotate(-14)", "translate(1180 1165) rotate(-4)")
desk = desk.replace("translate(1835 330)", "translate(1880 585)")
open("town-sheet.svg", "w").write(desk)
