# Indicative country fundamentals for real-estate development, 0-100 (higher = better).
#   D  Demand: population growth, urbanisation, household formation
#   E  Economy: GDP growth outlook, income trend, inflation control
#   A  Affordability & yield: price-to-income, rental yields, land/build cost
#   S  Stability: rule of law, property rights, political & currency risk
#   F  Business & finance: permits, foreign ownership rules, mortgage depth
# These are editorial estimates for a planning tool, not audited data.
WEIGHTS = {"D": 0.25, "E": 0.25, "A": 0.15, "S": 0.20, "F": 0.15}

COUNTRIES = """
USA 840 62 70 45 80 88
CAN 124 65 58 30 85 80
MEX 484 62 55 68 45 58
GTM 320 70 52 60 38 45
BLZ 084 60 48 55 50 45
SLV 222 45 50 58 42 45
HND 340 62 48 58 30 40
NIC 558 55 45 60 22 30
CRI 188 55 58 52 68 55
PAN 591 62 62 55 58 62
CUB 192 20 20 40 25 10
JAM 388 45 45 52 52 55
HTI 332 50 15 40 8 15
DOM 214 62 68 58 52 55
PRI 630 30 45 52 72 70
BHS 044 45 50 35 70 60
TTO 780 40 40 50 55 55
BRB 052 35 45 40 75 60
COL 170 58 55 62 45 58
VEN 862 25 22 50 10 12
ECU 218 52 40 58 35 45
PER 604 58 52 58 40 55
BOL 068 55 40 55 30 35
BRA 076 52 50 58 45 52
PRY 600 60 55 62 45 50
URY 858 40 50 45 75 62
ARG 032 45 40 65 35 35
CHL 152 50 48 45 65 68
GUY 328 65 95 55 48 45
SUR 740 45 35 52 42 35
GBR 826 50 45 38 78 85
IRL 372 68 70 30 85 75
FRA 250 42 40 40 72 65
DEU 276 40 38 45 85 72
NLD 528 50 50 32 85 75
BEL 056 45 42 48 78 68
LUX 442 65 55 25 90 75
CHE 756 50 48 25 92 75
AUT 040 45 40 42 85 68
ITA 380 25 35 55 62 52
ESP 724 55 58 55 68 62
PRT 620 55 58 45 75 65
GRC 300 35 55 58 58 52
CYP 196 55 65 52 65 62
MLT 470 65 72 42 70 62
POL 616 50 68 55 70 65
CZE 203 45 52 38 80 68
SVK 703 38 48 50 68 60
HUN 348 35 48 52 55 58
ROU 642 40 60 62 58 58
BGR 100 30 55 65 55 58
HRV 191 35 60 50 62 55
SVN 705 40 52 45 78 62
SRB 688 32 58 58 48 55
BIH 070 25 45 60 38 40
MNE 499 42 58 55 50 50
ALB 008 35 60 62 45 50
MKD 807 30 45 60 45 52
KOS 000 40 55 58 45 50
TUR 792 55 55 50 35 50
EST 233 45 45 45 82 85
LVA 428 25 40 58 72 70
LTU 440 40 55 52 78 75
FIN 246 35 30 50 90 78
SWE 752 50 42 40 90 78
NOR 578 48 48 38 92 78
DNK 208 48 52 42 92 82
ISL 352 60 55 35 88 70
UKR 804 20 30 55 18 35
BLR 112 20 30 55 20 25
MDA 498 20 45 55 40 45
RUS 643 30 35 52 18 30
GEO 268 50 70 60 52 72
ARM 051 45 70 58 50 62
AZE 031 45 45 55 40 50
AND 020 40 45 30 85 60
MCO 492 40 50 10 90 70
LIE 438 40 50 25 90 70
SMR 674 30 45 40 85 55
ARE 784 85 78 60 75 88
SAU 682 78 72 58 62 68
QAT 634 55 55 50 75 70
KWT 414 50 45 45 65 50
BHR 048 55 52 58 60 68
OMN 512 58 55 60 68 62
ISR 376 72 58 28 55 65
JOR 400 55 42 55 55 55
LBN 422 25 20 50 18 30
SYR 760 25 10 50 5 10
IRQ 368 62 45 52 22 30
IRN 364 40 30 52 15 20
YEM 887 50 10 45 5 8
PSX 275 50 20 45 12 25
EGY 818 72 55 62 40 45
MAR 504 60 58 58 58 60
DZA 012 55 45 55 40 35
TUN 788 45 38 58 45 48
LBY 434 45 35 50 12 20
SDN 729 45 10 45 5 12
SSD 728 50 10 40 5 8
ETH 231 72 62 50 28 32
ERI 232 40 30 45 15 10
DJI 262 55 60 45 45 45
SOM 706 70 40 45 8 15
SOL 000 60 40 45 25 20
KEN 404 78 68 60 48 55
UGA 800 80 65 58 40 45
TZA 834 82 68 58 52 45
RWA 646 75 75 55 65 72
BDI 108 65 35 45 22 25
COD 180 80 55 50 12 22
COG 178 62 45 50 30 30
GAB 266 55 45 50 40 40
CMR 120 70 52 55 35 35
NGA 566 80 52 55 30 40
GHA 288 72 58 55 58 52
CIV 384 78 72 55 52 52
SEN 686 75 70 55 60 55
BEN 204 72 65 55 52 48
TGO 768 70 62 55 45 50
BFA 854 68 50 50 18 35
MLI 466 70 45 50 15 30
NER 562 75 50 50 15 30
TCD 148 70 40 45 15 20
MRT 478 62 55 50 40 38
GMB 270 70 55 52 50 42
GIN 324 70 60 50 32 35
GNB 624 60 50 48 25 30
SLE 694 65 50 52 42 38
LBR 430 62 45 50 40 38
GNQ 226 50 20 45 25 25
CAF 140 55 30 40 8 15
AGO 024 70 40 52 38 35
ZMB 894 72 55 55 52 48
ZWE 716 55 40 52 25 28
MWI 454 70 40 52 45 38
MOZ 508 72 50 52 30 35
MDG 450 70 48 52 35 35
ZAF 710 52 38 55 50 62
NAM 516 55 45 52 62 55
BWA 072 55 48 52 72 58
LSO 426 40 35 50 45 42
SWZ 748 45 40 50 40 42
MUS 480 45 60 52 75 72
SYC 690 45 55 40 70 58
CPV 132 50 60 52 70 55
COM 174 55 45 48 40 35
STP 678 55 40 48 50 38
SAH 732 30 20 40 15 15
IND 356 72 82 55 55 58
PAK 586 75 42 55 25 38
BGD 050 65 65 55 35 38
LKA 144 45 45 55 45 48
NPL 524 55 50 52 42 40
BTN 064 45 50 45 70 42
MDV 462 60 55 45 50 50
AFG 004 60 15 45 5 10
CHN 156 30 52 35 45 40
HKG 344 30 40 15 55 75
MAC 446 35 45 20 60 60
TWN 158 30 58 25 72 68
KOR 410 30 45 30 75 70
PRK 408 15 10 30 5 3
JPN 392 25 30 62 88 70
MNG 496 55 58 55 52 52
VNM 704 70 80 55 55 52
THA 764 45 45 55 52 60
KHM 116 65 65 55 40 45
LAO 418 55 40 52 35 30
MMR 104 45 20 50 8 15
MYS 458 62 62 60 62 70
SGP 702 55 60 25 92 90
IDN 360 68 68 58 52 50
PHL 608 70 70 58 45 50
BRN 096 40 35 50 70 52
TLS 626 60 40 48 50 32
KAZ 398 58 62 58 45 55
UZB 860 72 72 58 40 50
KGZ 417 60 55 58 35 42
TJK 762 65 55 52 30 32
TKM 795 50 40 45 20 15
AUS 036 65 52 30 88 78
NZL 554 58 42 28 90 80
PNG 598 65 40 45 25 32
FJI 242 45 50 52 52 45
SLB 090 60 40 45 35 30
VUT 548 55 40 45 50 38
NCL 540 40 40 45 60 55
PYF 258 40 40 42 65 52
WSM 882 45 40 45 60 45
TON 776 40 40 45 55 42
GRL 304 25 40 40 85 50
CYN 000 35 40 55 40 40
"""

# Fallback for small territories not listed above.
DEFAULT = (45, 45, 45, 60, 50)

# Local momentum adjustments (points) for cities that clearly out- or under-perform
# their national baseline: job/population inflows, supply gaps, or overheated prices.
HOTSPOTS = """
USA Austin +8 | Dallas +8 | Houston +6 | San Antonio +5 | Phoenix +6 | Nashville +8 | Raleigh +8
USA Charlotte +8 | Tampa +7 | Orlando +7 | Jacksonville +6 | Miami +5 | Atlanta +6 | Boise +5
USA Salt Lake City +6 | Denver +3 | Las Vegas +4 | Columbus +4 | Indianapolis +4 | Greenville +4
USA San Francisco -8 | San Jose -6 | Los Angeles -4 | New York -2 | Chicago -3 | Detroit -6
USA Cleveland -4 | St. Louis -4 | Honolulu -6 | Seattle -2 | Portland -3 | Boston -2
CAN Toronto -3 | Vancouver -6 | Calgary +6 | Edmonton +4 | Halifax +3 | Ottawa +1
MEX Monterrey +8 | Queretaro +8 | Guadalajara +5 | Merida +6 | Cancun +6 | Tijuana +3 | Saltillo +5
MEX Mexico City +2 | Puerto Vallarta +4
COL Medellin +6 | Bogota +2 | Barranquilla +3 | Cartagena +3
BRA Sao Paulo +3 | Florianopolis +5 | Curitiba +3 | Rio de Janeiro -2
GBR London -2 | Manchester +6 | Birmingham +4 | Leeds +4 | Bristol +3 | Liverpool +3 | Edinburgh +2
IRL Dublin -3 | Cork +3
ESP Madrid +5 | Malaga +6 | Valencia +5 | Barcelona -1 | Alicante +4
PRT Lisbon +3 | Porto +5 | Faro +3
POL Warsaw +6 | Krakow +6 | Wroclaw +6 | Gdansk +5 | Poznan +3
CZE Prague +4 | Brno +3
ROU Bucharest +5 | Cluj-Napoca +6
HUN Budapest +4
BGR Sofia +5
EST Tallinn +4
LTU Vilnius +5
DEU Berlin +2 | Munich -2 | Leipzig +5 | Frankfurt +2 | Hamburg +1
NLD Amsterdam -3 | Rotterdam +3 | Eindhoven +3
ITA Milan +8 | Rome +1
GRC Athens +6 | Thessaloniki +3
FRA Paris -2 | Lyon +2 | Bordeaux +2 | Montpellier +3
CHE Zurich -2 | Geneva -2
AUT Vienna +2
TUR Istanbul +4 | Antalya +4
GEO Tbilisi +5 | Batumi +5
ARE Dubai +6 | Abu Dhabi +4 | Ras al Khaymah +6
SAU Riyadh +7 | Jeddah +3
QAT Doha +2
ISR Tel Aviv-Yafo -3
EGY Cairo +3
OMN Muscat +2
KEN Nairobi +5
RWA Kigali +5
NGA Lagos +6 | Abuja +4
GHA Accra +5
CIV Abidjan +5
SEN Dakar +4
TZA Dar es Salaam +5
ETH Addis Ababa +4
MAR Casablanca +4 | Marrakesh +4 | Tangier +5 | Rabat +3
ZAF Cape Town +7 | Johannesburg +2 | Durban -2
UGA Kampala +4
ZMB Lusaka +3
IND Bengaluru +6 | Hyderabad +7 | Pune +6 | Chennai +3 | Mumbai +1 | New Delhi +3 | Delhi +3
IND Gurgaon +5 | Ahmedabad +5
VNM Ho Chi Minh City +5 | Hanoi +5 | Da Nang +6
PHL Manila +2 | Cebu +4
IDN Jakarta +2 | Denpasar +5 | Surabaya +2
MYS Kuala Lumpur +4 | Johor Bahru +4 | George Town +3
THA Bangkok +3 | Phuket +4 | Chiang Mai +2
KHM Phnom Penh +2
SGP Singapore +3
CHN Shenzhen +6 | Shanghai +5 | Hangzhou +5 | Chengdu +5 | Guangzhou +3 | Beijing +3 | Hefei +4
JPN Tokyo +8 | Osaka +5 | Fukuoka +7 | Sapporo +2 | Nagoya +3 | Kumamoto +4
KOR Seoul +4 | Busan -2
TWN Hsinchu +4 | Kaohsiung +2
AUS Brisbane +6 | Perth +6 | Adelaide +4 | Sydney -4 | Melbourne -1 | Gold Coast +4
NZL Christchurch +3
KAZ Almaty +4 | Astana +4
UZB Tashkent +6
"""


def parse_countries():
    out = {}
    for line in COUNTRIES.strip().splitlines():
        iso, num, *f = line.split()
        out[iso] = {"num": num, "f": tuple(int(x) for x in f)}
    return out


def parse_hotspots():
    out = {}
    for line in HOTSPOTS.strip().splitlines():
        iso, rest = line.split(" ", 1)
        for item in rest.split("|"):
            name, delta = item.strip().rsplit(" ", 1)
            out[(iso, name.lower())] = int(delta)
    return out
