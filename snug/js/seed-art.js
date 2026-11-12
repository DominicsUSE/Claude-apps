// Sample pictures for the demo data, drawn as small SVGs so the app ships with
// no image files and no network requests. These are content, not interface.

const uri = (svg) => `data:image/svg+xml,${encodeURIComponent(svg)}`;
const font = 'font-family="system-ui,sans-serif"';

const tiles = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
<rect width="640" height="400" fill="#d8d2c4"/><rect y="300" width="640" height="100" fill="#b9a58a"/><rect y="296" width="640" height="8" fill="#9c8669"/>
<g fill="#00000022"><ellipse cx="112" cy="300" rx="58" ry="6"/><ellipse cx="247" cy="300" rx="58" ry="6"/><ellipse cx="382" cy="300" rx="58" ry="6"/><ellipse cx="517" cy="300" rx="58" ry="6"/></g>
<rect x="60" y="80" width="105" height="220" rx="6" fill="#e9e4d6"/><path d="M60 86a6 6 0 0 1 6-6h93a6 6 0 0 1 6 6v150q-26 14-52 0t-53 6z" fill="#a8c9b5"/>
<rect x="195" y="80" width="105" height="220" rx="6" fill="#2f1c14"/><path d="M195 86a6 6 0 0 1 6-6h93a6 6 0 0 1 6 6v16q-52 14-105 0z" fill="#7b3f1c"/><path d="M294 96v190" stroke="#7b3f1c" stroke-width="6"/>
<rect x="330" y="80" width="105" height="220" rx="6" fill="#3c7a5e"/><g fill="#cdbb9f"><ellipse cx="362" cy="150" rx="16" ry="11"/><ellipse cx="404" cy="196" rx="20" ry="13"/><ellipse cx="368" cy="246" rx="13" ry="18"/><ellipse cx="412" cy="128" rx="9" ry="7"/></g>
<rect x="465" y="80" width="105" height="220" rx="6" fill="#efebe1"/><path d="M465 250q52 12 105 0v44a6 6 0 0 1-6 6h-93a6 6 0 0 1-6-6z" fill="#dcd5c4"/>
<g fill="#d8d2c4"><circle cx="112" cy="100" r="7"/><circle cx="247" cy="100" r="7"/><circle cx="382" cy="100" r="7"/><circle cx="517" cy="100" r="7"/></g>
<g ${font} font-size="15" fill="#5b5245" text-anchor="middle"><text x="112" y="340">celadon</text><text x="247" y="340">tenmoku</text><text x="382" y="340">copper green</text><text x="517" y="340">satin white</text></g></svg>`;

const curve = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400">
<rect width="640" height="400" fill="#f6f4ee"/>
<text x="70" y="26" ${font} font-size="16" font-weight="600" fill="#2b2a26">Cone 6 glaze firing, slow cool</text>
<g stroke="#dedacf" stroke-width="1"><path d="M70 294h530M70 248h530M70 202h530M70 155h530M70 109h530M70 63h530"/></g>
<rect x="313" y="40" width="88" height="300" fill="#b4472b" opacity="0.1"/>
<path d="M70 340h530M70 40v300" stroke="#8d897e" stroke-width="1.5" fill="none"/>
<path d="M70 335L158 202L247 86L291 58L298 58L313 109L401 165L600 305" fill="none" stroke="#b4472b" stroke-width="3" stroke-linejoin="round" stroke-linecap="round"/>
<circle cx="294" cy="58" r="5" fill="#b4472b"/>
<g ${font} font-size="13" fill="#6b675d"><g text-anchor="end"><text x="62" y="298">200</text><text x="62" y="252">400</text><text x="62" y="206">600</text><text x="62" y="159">800</text><text x="62" y="113">1,000</text><text x="62" y="67">1,200</text></g>
<g text-anchor="middle"><text x="70" y="360">0 h</text><text x="158" y="360">4</text><text x="247" y="360">8</text><text x="335" y="360">12</text><text x="423" y="360">16</text><text x="512" y="360">20</text><text x="600" y="360">24</text></g>
<text x="70" y="388">Temperature in °C against hours from start</text></g>
<g ${font} font-size="13" fill="#2b2a26"><text x="306" y="52">1,222 °C, hold 20 min</text><text x="410" y="150">slow cool, 60 °C/h</text><text x="410" y="167">1,000 to 760 °C</text></g></svg>`;

const mug = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 480 480">
<rect width="480" height="480" fill="#d5cfc2"/><rect y="360" width="480" height="120" fill="#8a6a48"/><rect y="356" width="480" height="8" fill="#6f5438"/>
<ellipse cx="244" cy="362" rx="92" ry="9" fill="#00000030"/>
<path d="M312 232c56 0 56 84 0 92" fill="none" stroke="#7f9d97" stroke-width="18" stroke-linecap="round"/>
<path d="M170 200h140v128a32 32 0 0 1-32 32h-76a32 32 0 0 1-32-32z" fill="#7f9d97"/>
<path d="M170 328a32 32 0 0 0 32 32h76a32 32 0 0 0 32-32v-8H170z" fill="#cdb99b"/>
<ellipse cx="240" cy="200" rx="70" ry="13" fill="#5f7d78"/><ellipse cx="240" cy="203" rx="60" ry="9" fill="#4b6662"/>
<g fill="#5f7d78"><circle cx="196" cy="246" r="2.5"/><circle cx="222" cy="288" r="2"/><circle cx="268" cy="258" r="3"/><circle cx="286" cy="300" r="2"/><circle cx="244" cy="232" r="2"/><circle cx="206" cy="306" r="2.5"/></g></svg>`;

const elev = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 280">
<rect width="640" height="280" fill="#eef0ea"/>
<text x="40" y="30" ${font} font-size="16" font-weight="600" fill="#26302a">Sunday club ride: 82 km, 1,150 m climbing</text>
<path d="M40 220L40 190L100 182L150 160L190 105L215 98L250 150L300 175L350 170L395 160L420 90L432 84L470 160L520 180L560 188L600 190L600 220Z" fill="#8fae9a"/>
<path d="M40 190L100 182L150 160L190 105L215 98L250 150L300 175L350 170L395 160L420 90L432 84L470 160L520 180L560 188L600 190" fill="none" stroke="#4f7a63" stroke-width="2.5" stroke-linejoin="round"/>
<path d="M40 220h560" stroke="#8a9189" stroke-width="1.5"/>
<g ${font} font-size="13" fill="#26302a" text-anchor="middle"><text x="203" y="84">Tring Hill, 4.1%</text><text x="428" y="70">Ivinghoe Beacon, 9.8%</text></g>
<g ${font} font-size="13" fill="#5d665f" text-anchor="middle"><text x="40" y="244">0</text><text x="177" y="244">20</text><text x="313" y="244">40</text><text x="450" y="244">60</text><text x="600" y="244">82 km</text></g></svg>`;

export const ART = { tiles: uri(tiles), curve: uri(curve), mug: uri(mug), elev: uri(elev) };
