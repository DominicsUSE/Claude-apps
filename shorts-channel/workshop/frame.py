"""9:16 Shorts frame (1080x1920) in the workshop style: Short 1 hook, 'Barry's been with us eleven years.'"""
import re
from build import sheet

desk = open("desk.svg").read()
desk_defs = desk[desk.index("<defs>") + 6: desk.index("</defs>")]
cast = sheet("../character-lineup.svg")
cast_defs = cast[cast.index("<defs>") + 6: cast.index("</defs>")]
lenny = re.search(r'<!-- LENNY -->\s*(<g transform="translate\(1650 860\) scale\(1.4\)">.*?)\s*<!-- names -->', cast, re.S).group(1)
lenny = lenny.replace('translate(1650 860) scale(1.4)', 'translate(330 300) scale(0.62)')

T = 'font-family="Caveat, cursive" stroke="none"'
CANDLES = [(270, 660), (330, 622), (430, 600), (660, 600), (760, 625), (820, 665), (300, 775), (780, 770), (540, 812)]

SCENE = f'''
<path d="M0 250 L0 150 L90 150 L90 120 L230 120 L230 160 L360 160 L360 110 L520 110 L520 150 L640 150 L640 175 L700 175 L700 250 Z" fill="#E4D3B4"/>
<g fill="#B9C8D3">{''.join(f'<rect x="{x}" y="{y}" width="34" height="34"/>' for x, y in ((20,175),(130,150),(180,150),(270,190),(400,140),(460,140),(560,180)))}</g>
<rect x="380" y="200" width="120" height="34" fill="#D9A441"/>
<text x="440" y="225" text-anchor="middle" {T} font-weight="700" font-size="22" fill="#3B2F28">TAXES &amp; TANS</text>
<rect x="0" y="250" width="880" height="42" fill="#DCD2C2"/>
<rect x="0" y="292" width="880" height="688" fill="#9C9184"/>
<g stroke="#D9A441" stroke-width="7" stroke-dasharray="46 34"><line x1="0" y1="362" x2="880" y2="362"/></g>
<ellipse cx="540" cy="700" rx="300" ry="105" fill="#5A4F48"/>
<ellipse cx="540" cy="712" rx="262" ry="76" fill="#8FAAA4"/>
<path d="M420 700 Q470 690 520 700 M600 735 Q650 725 700 735" fill="none" stroke="#FBF6EA" stroke-opacity="0.6"/>
<ellipse cx="600" cy="708" rx="30" ry="18" fill="#D9A441"/><circle cx="622" cy="684" r="14" fill="#D9A441"/>
<path d="M634 682 L650 686 L634 690 Z" fill="#D98A4E"/><circle cx="624" cy="680" r="2.5" fill="#3B2F28" stroke="none"/>
''' + ''.join(f'<rect x="{x-7}" y="{y-14}" width="14" height="28" fill="#FBF6EA"/>' for x, y in CANDLES) + f'''
<g><line x1="250" y1="760" x2="250" y2="722"/><circle cx="250" cy="714" r="12" fill="#D98A4E"/><circle cx="238" cy="726" r="7" fill="#7E9C7A"/>
<line x1="835" y1="768" x2="835" y2="730"/><circle cx="835" cy="722" r="12" fill="#D9A441"/></g>
<line x1="450" y1="598" x2="436" y2="640"/><line x1="490" y1="598" x2="504" y2="640"/>
<rect x="435" y="545" width="70" height="56" fill="#FBF6EA"/><ellipse cx="470" cy="575" rx="22" ry="9" fill="#5A4F48"/>
<line x1="728" y1="610" x2="728" y2="540" stroke-width="4"/>
<rect x="668" y="500" width="120" height="52" fill="#C8B08A"/>
<text x="728" y="530" text-anchor="middle" {T} font-weight="700" font-size="30" fill="#3B2F28">BARRY</text>
<text x="728" y="547" text-anchor="middle" {T} font-size="16" fill="#3B2F28">est. 2015</text>
<path d="M820 880 L866 880 L854 812 L832 812 Z" fill="#D98A4E"/><rect x="834" y="836" width="18" height="11" fill="#FBF6EA"/>
'''
FLAMES = ''.join(f'<ellipse cx="{x}" cy="{y-22}" rx="5" ry="9" fill="#F0A33C" opacity="0.95"/><ellipse cx="{x}" cy="{y-20}" rx="2.5" ry="5" fill="#FBE7A8"/>' for x, y in CANDLES)
TOWERS = '''<g stroke="#5E7A99" stroke-width="1.5">
<rect x="700" y="70" width="60" height="180" fill="#A9BACB"/><rect x="765" y="30" width="62" height="220" fill="#8FA6BD"/><rect x="832" y="95" width="48" height="155" fill="#A9BACB"/>
<g stroke="#E6ECF2" stroke-width="1">''' + ''.join(f'<line x1="{a}" y1="{y}" x2="{b}" y2="{y}"/>' for a, b, t in ((700,760,70),(765,827,30),(832,880,95)) for y in range(t + 12, 246, 15)) + '</g></g>'

DEB_FACE = '''<g filter="url(#wob)" stroke="#3B2F28" stroke-width="3" stroke-linecap="round" fill="none">
  <circle cx="-15" cy="-305" r="4.5" fill="#3B2F28"/><circle cx="15" cy="-305" r="4.5" fill="#3B2F28"/>
  <line x1="-27" y1="-315" x2="-8" y2="-322"/><line x1="27" y1="-315" x2="8" y2="-322"/>
  <path d="M-9 -279 Q0 -286 9 -279"/>
  <path d="M-20 -296 Q-24 -284 -20 -280 Q-15 -284 -20 -296 Z" fill="#8FAAA4" stroke-width="1.5"/>
  <circle cx="-43" cy="-290" r="5" fill="#D9A441" stroke-width="2"/><circle cx="43" cy="-290" r="5" fill="#D9A441" stroke-width="2"/>
  <circle cx="-32" cy="-210" r="4" fill="#FBF6EA" stroke-width="2"/><circle cx="-38" cy="-170" r="4" fill="#FBF6EA" stroke-width="2"/>
  <circle cx="-44" cy="-130" r="4" fill="#FBF6EA" stroke-width="2"/>
  <circle cx="146" cy="-322" r="4" fill="#C8432D" stroke="none"/>
</g>'''

svg = f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1080 1920" width="1080" height="1920">
<defs>{desk_defs}{cast_defs}
<filter id="paintF" filterUnits="userSpaceOnUse" x="-20" y="-20" width="920" height="1020">
  <feTurbulence type="fractalNoise" baseFrequency="0.03" numOctaves="3" seed="4" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.5" result="d"/>
  <feTurbulence type="fractalNoise" baseFrequency="0.016" numOctaves="4" seed="9" result="m"/>
  <feColorMatrix in="m" type="matrix" values="0.35 0 0 0 0.72  0.35 0 0 0 0.72  0.35 0 0 0 0.72  0 0 0 0 1" result="mg"/>
  <feBlend in="d" in2="mg" mode="multiply" result="b"/><feComposite in="b" in2="d" operator="in"/>
</filter>
<filter id="bleedF" filterUnits="userSpaceOnUse" x="-20" y="-20" width="920" height="1020">
  <feTurbulence type="fractalNoise" baseFrequency="0.05" numOctaves="2" seed="13" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="12" result="d"/><feGaussianBlur in="d" stdDeviation="1.6"/>
</filter>
<filter id="stampF" x="-10%" y="-10%" width="120%" height="120%">
  <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2" seed="5" result="t"/>
  <feColorMatrix in="t" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 -5 4.1" result="m"/>
  <feComposite in="SourceGraphic" in2="m" operator="in"/>
</filter>
<filter id="glow" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="6"/></filter>
<clipPath id="sceneclip"><rect width="880" height="980"/></clipPath>
<g id="scene">{SCENE}</g>
</defs>

<rect width="1080" height="1920" filter="url(#wood)"/>
<g opacity="0.3" filter="url(#soft)"><circle cx="170" cy="1720" r="92" fill="none" stroke="#5E3417" stroke-width="8"/></g>

<g transform="translate(70 150) rotate(2.2)"><rect width="950" height="1340" fill="#E9DDC2" filter="url(#shadow)"/><rect width="950" height="1340" filter="url(#fibre)"/></g>

<g transform="translate(60 160) rotate(-1)">
  <rect width="960" height="1320" fill="#F3E9D2" filter="url(#shadow)"/>
  <rect width="960" height="1320" filter="url(#blotch)" opacity="0.35" style="mix-blend-mode:multiply"/>
  <rect width="960" height="1320" filter="url(#fibre)"/>
  <g transform="translate(40 110)" clip-path="url(#sceneclip)">
    {TOWERS}
    <use href="#scene" transform="translate(5 4)" opacity="0.42" filter="url(#bleedF)" style="mix-blend-mode:multiply"/>
    <use href="#scene" stroke="#3B2F28" stroke-width="2.6" stroke-linejoin="round" filter="url(#paintF)"/>
    <g filter="url(#glow)" opacity="0.55">{''.join(f'<circle cx="{x}" cy="{y-22}" r="16" fill="#FFC86B"/>' for x, y in CANDLES)}</g>
    {FLAMES}
    {lenny}
    <g transform="translate(150 960) scale(1.3)">
      <use href="#deb" transform="translate(7 5)" opacity="0.45" filter="url(#bleed)" style="mix-blend-mode:multiply"/>
      <use href="#deb" stroke="#3B2F28" stroke-width="3" stroke-linejoin="round" filter="url(#paint)"/>
      {DEB_FACE}
    </g>
  </g>
  <rect x="40" y="110" width="880" height="980" fill="none" stroke="#3B2F28" stroke-width="2.5" opacity="0.65"/>

  <!-- sticky note -->
  <g transform="translate(610 230) rotate(5)" filter="url(#propshadow)">
    <rect width="230" height="150" fill="#E9CF7A"/>
    <text x="115" y="56" text-anchor="middle" {T} font-weight="700" font-size="34" fill="#3B2F28">the duck has</text>
    <text x="115" y="96" text-anchor="middle" {T} font-weight="700" font-size="34" fill="#3B2F28">been here since</text>
    <text x="115" y="134" text-anchor="middle" {T} font-weight="700" font-size="34" fill="#A8402A">2015</text>
  </g>
  <path d="M720 400 C790 520 710 690 655 788" fill="none" stroke="#A8402A" stroke-width="4" stroke-linecap="round"/>
  <path d="M638 772 L654 792 L674 778" fill="none" stroke="#A8402A" stroke-width="4" stroke-linecap="round"/>

  <!-- caption strip -->
  <g transform="translate(40 1130) rotate(-1.2)" filter="url(#propshadow)">
    <path d="M0 6 L60 0 L120 7 L200 1 L300 6 L420 0 L540 5 L660 0 L760 6 L860 2 L870 128 L780 134 L660 128 L540 135 L420 129 L300 136 L180 129 L60 135 L4 130 Z" fill="#FBF6EA"/>
    <text x="34" y="44" {T} font-weight="700" font-size="30" fill="#D98A4E">DEB</text>
    <text x="34" y="104" {T} font-weight="700" font-size="58" fill="#3B2F28">"Barry's been with us eleven years."</text>
  </g>
  <rect x="380" y="1110" width="120" height="40" fill="#E6D9B6" opacity="0.85" transform="rotate(4 440 1130)"/>
</g>

<!-- format stamp -->
<g transform="translate(300 225) rotate(-5)" filter="url(#stampF)" opacity="0.9">
  <rect x="-210" y="-52" width="420" height="104" rx="8" fill="#F3E9D2" fill-opacity="0.25" stroke="#A8402A" stroke-width="7"/>
  <text x="0" y="-8" text-anchor="middle" font-family="Arial Black, Arial" font-size="40" letter-spacing="5" fill="#A8402A">TOWN PROBLEM</text>
  <text x="0" y="38" text-anchor="middle" font-family="Arial Black, Arial" font-size="38" letter-spacing="4" fill="#A8402A">#212</text>
</g>

<g transform="translate(860 120) rotate(8)" filter="url(#propshadow)">
  <path d="M0 0 L0 110 A18 18 0 0 0 36 110 L36 -14 A26 26 0 0 0 -16 -14 L-16 96" fill="none" stroke="url(#metal)" stroke-width="6" stroke-linecap="round"/>
</g>
<g transform="translate(420 1650) rotate(-9)" filter="url(#propshadow)">
  <rect x="0" y="-14" width="470" height="28" fill="url(#pencilFacet)"/>
  <line x1="0" y1="-4" x2="470" y2="-4" stroke="#B88A32" stroke-width="1.5"/><line x1="0" y1="5" x2="470" y2="5" stroke="#9E7228" stroke-width="1.5"/>
  <rect x="470" y="-15" width="44" height="30" fill="url(#metal)"/><rect x="514" y="-14" width="36" height="28" rx="8" fill="#C97A63"/>
  <path d="M0 -14 L-70 0 L0 14 Z" fill="#E6C595"/><path d="M-48 -4.5 L-70 0 L-48 4.5 Z" fill="#3B2F28"/>
</g>

<rect width="1080" height="1920" fill="url(#lamp)" style="mix-blend-mode:screen"/>
<rect width="1080" height="1920" fill="url(#vignette)"/>
</svg>'''
open("short01-frame.svg", "w").write(svg)
