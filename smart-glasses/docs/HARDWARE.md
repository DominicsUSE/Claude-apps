# Hardware, shopping lists and budgets

Prices are typical single-unit prices in euros, including VAT, checked in November 2026. AliExpress prices assume the free-shipping "Choice" tier. EU shops usually add €4–6 of shipping per order. Prices move, so check before ordering. The sources for the key figures are listed at the end.

**Rule used throughout:** the cheapest part that does the job, unless a few euros more buys a large real gain. Those cases are marked ★.

## 1. Component catalog

Every option below works with the software (pick the `driver` in `config.toml`).

### Computer

| Option | € | Where | What it does / compatibility | Verdict |
|---|---|---|---|---|
| **Raspberry Pi Zero 2 W** (no header) | 19 (≈24 shipped) | BerryBase, Welectron, Reichelt (DE), Kiwi (NL), Botland (PL), The Pi Hut (UK) | Quad-core 1 GHz, 512 MB RAM, Wi-Fi + BLE, CSI camera port, I2C/SPI/UART/I2S. 65×30 mm, 11 g. In production until at least 2028. | **Chosen for all builds** |
| ESP32-S3 camera board (e.g. XIAO ESP32S3 Sense) | 14 | AliExpress, Seeed | Camera and mic, but no Linux, no OpenCV and no local speech recognition. Would need a phone to do all the "smart" work. | Cheaper, much less capable |
| Radxa Zero 3W / Orange Pi Zero 2W | 25–45 | AliExpress | More RAM, but weaker camera and driver support (no picamera2). | Not worth the porting work |
| Raspberry Pi 5 (pocket unit) | 60+ | Pi resellers | 5–10× faster AI, but too big and hot for the frame. | Upgrade path only |

### Camera (one CSI port on the Zero: choose one)

| Option | € | Where | What it does / compatibility | Verdict |
|---|---|---|---|---|
| **OV5647 5 MP NoIR mini, "for Pi Zero"** | 7–9 | AliExpress | No IR-cut filter, so it sees 850 nm light: night vision with IR LEDs. Comes with the Zero's 22-pin cable. Fixed focus. | **Ultra** |
| ★ **Raspberry Pi Camera Module 3 NoIR** (IMX708) | 29 | Welectron €28.90, BerryBase, Pi Hut | Much better low light, autofocus, HDR. Needs a Zero camera cable (€3). | **Mid** |
| Camera Module 3 Wide NoIR (120°) | 41 | Pi resellers | Wider view for navigation. | Option |
| ★ **Raspberry Pi AI Camera** (IMX500) | ~72 | Pi resellers | Runs the object-detection network on the sensor at camera frame rate: about 30 detections/s with no load on the Zero. Has an IR-cut filter (no NoIR night vision). | **Advanced** |

### Thermal sensor (real long-wave infrared)

| Option | € | Where | Pixels / speed / accuracy | Verdict |
|---|---|---|---|---|
| MLX90614 | 4–6 | AliExpress | 1 pixel (spot thermometer only) | Cheapest, no image |
| **AMG8833** (GY-AMG8833) | 18–25 (Seeed Grove ≈ 36) | AliExpress, The Pi Hut | 8×8, 10 fps, ±2.5 °C, people to about 5–7 m, 60° field of view. I2C 0x69. | **Ultra** |
| ★ **MLX90640** BAA (55°) or BAB (110°) | 35–48 | AliExpress, Waveshare (€48.40) | 32×24, 4–8 fps on a Pi, ±1.5 °C. I2C 0x33. Pick the 55° version: it lines up with the camera for fusion. | **Mid** (+€25 over ultra, 12× the pixels) |
| MLX90641 | ~30 | AliExpress | 16×12. Possible, but the MLX90640 is better value. | Skip |
| ★ **InfiRay P2 Pro** | 204–260 | InfiRay/Xinfrared store, Amazon, AliExpress | 256×192 radiometric, 25 Hz, 9 g, USB-C UVC. A real thermal image. Needs a micro-USB OTG adapter. | **Advanced** |
| FLIR Lepton 3.5 + PureThermal board | 300+ | Groupgets, DigiKey | 160×120 | Pricier than the P2 Pro for fewer pixels |

### HUD display and optics

| Option | € | Where | What it does / compatibility | Verdict |
|---|---|---|---|---|
| **SSD1306 0.96" 128×64 OLED, I2C** (white) | 2.5–3 | AliExpress | Black pixels are transparent in a beam splitter. I2C 0x3C, shares the bus. | **Ultra** |
| SH1106 1.3" 128×64 OLED, I2C | 4 | AliExpress | Bigger version of the same | Option (`driver = "sh1106"`) |
| ★ **SSD1351 1.5" 128×128 colour OLED, SPI** | 13–16 | AliExpress | Colour thermal map in the HUD | **Mid / Advanced** |
| ST7789 1.3" 240×240 IPS LCD | 4–6 | AliExpress | Bright and sharp, but the LCD backlight makes black glow grey in a beam splitter | Only for a direct-view display |
| Your phone (dashboard) | 0 | – | Full-colour live view and controls over Wi-Fi | Always available |
| **Acrylic 50/50 beam splitter** 25×25 mm (or a piece of clear plexiglass) **+ 25 mm, f≈45 mm aspheric lens** ("Cardboard VR lens") | 3–4 | AliExpress | The lens puts the image at a comfortable focus distance; the splitter reflects it into your eye. | **Ultra** |
| Glass beam splitter cube or plate (20 mm) + lens | 8–12 | AliExpress | Sharper, no double image | **Mid / Advanced** |

### Distance

| Option | € | Range | Notes | Verdict |
|---|---|---|---|---|
| HC-SR04 ultrasonic | 1 | 4 m | Bulky, 5 V echo pin needs a level divider, wide beam | Not for glasses |
| **VL53L0X** ToF | 2–3 | about 1.2 m (up to 2 m in the dark) | I2C 0x29, 25° cone | **Ultra** |
| ★ **VL53L1X** ToF | 6–10 | about 4 m | I2C 0x29 | **Mid** |
| **TF-Luna** LiDAR | 20–25 | 8 m | I2C 0x10 (set by the UART config tool), 35 × 21 mm | **Advanced** |

### Environment

| Option | € | Measures | Notes | Verdict |
|---|---|---|---|---|
| AMG8833 on-board thermistor | 0 | ambient temperature (rough) | Already in the ultra build | **Ultra** |
| AHT20 + BMP280 combo | 2 | temperature, humidity, pressure | Needs extra drivers | Not wired in |
| **BME280** | 3–5 | temperature, humidity, pressure | Many "BME280" listings are BMP280s with no humidity; setup detects this | **Mid** |
| **BME680** | 8–10 | adds a gas/VOC trend (air quality) | | **Advanced** |

### Radar

| Option | € | What it reports | Notes | Verdict |
|---|---|---|---|---|
| **RCWL-0516** | 0.5–1.5 | motion yes/no, about 5–7 m | 5 V in, 3.3 V out (safe for the Pi), 36×17 mm | **Ultra** |
| ★ **HLK-LD2410C** | 2.5–4 | presence of a moving **or still** person, distance, about 5–6 m | UART 256000 baud, 5 V. Only 7×35 mm. | **Mid** |
| **HLK-LD2450** | 8–10 | x/y position and speed of up to 3 people, about 6 m | UART | **Advanced** |

### Radio frequency (passive)

| Option | € | What it does | Verdict |
|---|---|---|---|
| **Pi's built-in Wi-Fi/BLE** | 0 | Counts networks and BLE advertisers, best signal strength | **All builds** |
| **RTL-SDR Blog V4** | ~45 from rtl-sdr.com (DigiKey kit €87) | Spectrum power, 24 MHz–1.7 GHz (rtl_power), receive-only. Pocket module on the USB hub. | **Advanced** |

### Audio

| Option | € | Notes | Verdict |
|---|---|---|---|
| **INMP441 I2S microphone** | 2–3 | 3.3 V, digital: no noise from the Pi | **All builds** |
| USB mini microphone | 3–5 | Uses the Zero's only USB port | Alternative |
| **MAX98357A I2S amplifier** | 2–3 | 3 W class D, 5 V. Works alongside the INMP441 through one overlay. | **All builds** |
| **8 Ω 1 W 20 mm speaker** | 1–2 | Mount near the ear | **Ultra / Mid** |
| Bone-conduction exciter | 6–9 | Keeps your ears open, quieter, sound leaks less | **Advanced** |

### Power

| Option | € | Notes | Verdict |
|---|---|---|---|
| **USB power bank** 5000 mAh slim, in a pocket | 0 (own) – 12 | Safest and cheapest; the weight stays off your head. About 5–7 h. | **Ultra** |
| **INA219** current/voltage monitor | 2 | Battery gauge: energy counting (power bank) or voltage curve (LiPo) | **Ultra / Mid** |
| **1S LiPo 2000 mAh** (with protection board) **+ IP5306 charge/boost module** | 9 + 2 | All-in-one wearable, about 2–2.5 h. Mount it at the back of the head or in a neck pod. | **Mid** |
| Adafruit PowerBoost 1000C | 22 | More robust than the IP5306 | Mid upgrade |
| **Waveshare UPS HAT (C)** for Pi Zero | ~19 | 1000 mAh cell, charger, on-board INA219 (0x43); acts as a hot-swap buffer for the power bank | **Advanced** |

## 2. The three builds

### Build 1: Ultra-budget (≈ €97)

| # | Part | Exact model | € | Where |
|---|---|---|---|---|
| 1 | Computer | Raspberry Pi Zero 2 W (no header) | 19 | BerryBase / Welectron |
| 2 | Storage | SanDisk/Samsung 32 GB microSD A1 | 6 | any |
| 3 | Camera | OV5647 5 MP NoIR mini camera for Pi Zero, with cable | 8 | AliExpress |
| 4 | Night illuminator | 4× 850 nm 5 mm IR LEDs, BC337 NPN, 2× 39 Ω, 470 Ω, 100 kΩ | 2 | AliExpress |
| 5 | Thermal | AMG8833 module (GY-AMG8833) | 20 | AliExpress |
| 6 | HUD display | SSD1306 0.96" 128×64 I2C OLED, white | 3 | AliExpress |
| 7 | HUD optics | 25×25 mm acrylic 50/50 beam splitter + 25 mm f≈45 mm lens | 4 | AliExpress |
| 8 | Distance | VL53L0X (GY-VL53L0XV2) | 2.5 | AliExpress |
| 9 | Radar | RCWL-0516 | 1 | AliExpress |
| 10 | Microphone | INMP441 | 2.5 | AliExpress |
| 11 | Amplifier | MAX98357A | 2.5 | AliExpress |
| 12 | Speaker | 8 Ω 1 W, 20 mm | 1.5 | AliExpress |
| 13 | Power monitor | INA219 (GY-INA219) | 2 | AliExpress |
| 14 | Controls | 2× 6 mm tactile buttons, 3 mm red LED, 330 Ω | 1 | AliExpress |
| 15 | Frame | safety glasses or sunglasses with wide temple arms | 4 | hardware store |
| 16 | Mounting | 30 AWG silicone wire, perfboard, JST/Dupont, heat-shrink, foam tape, M2 screws | 6 | AliExpress |
| 17 | Power | 5000 mAh slim power bank + 1 m thin micro-USB cable | 12 | any |
| | **Total** | | **≈ 97** | (≈ 85 with your own power bank) |

### Build 2: Mid-range (≈ €195)

| # | Part | Exact model | € | Where |
|---|---|---|---|---|
| 1 | Computer | Raspberry Pi Zero 2 W + small aluminium heatsink | 21 | Pi resellers |
| 2 | Storage | 32 GB microSD A1 | 6 | any |
| 3 | Camera | Raspberry Pi Camera Module 3 NoIR + Pi Zero camera cable | 32 | Welectron / BerryBase |
| 4 | Night illuminator | as ultra | 2 | AliExpress |
| 5 | Thermal | MLX90640**BAA** (55°) breakout | 45 | AliExpress / Waveshare |
| 6 | HUD display | SSD1351 1.5" 128×128 colour OLED (SPI) | 15 | AliExpress |
| 7 | HUD optics | 20 mm glass beam splitter + 25 mm lens | 10 | AliExpress |
| 8 | Distance | VL53L1X | 8 | AliExpress / Tinytronics |
| 9 | Environment | BME280 (3.3 V board) | 4 | AliExpress |
| 10 | Radar | HLK-LD2410C | 4 | openelab / Tinytronics |
| 11 | Audio | INMP441 + MAX98357A + 20 mm speaker | 6.5 | AliExpress |
| 12 | Battery | 1S LiPo 2000 mAh (103450, protected) | 9 | AliExpress |
| 13 | Charger/boost | IP5306 5 V 2.1 A module (USB-C) | 2 | AliExpress |
| 14 | Power monitor | INA219 | 2 | AliExpress |
| 15 | Controls | buttons, LED, resistors | 1 | AliExpress |
| 16 | Frame | safety glasses/sunglasses | 4 | hardware store |
| 17 | Mounting | wire, connectors, heat-shrink, screws | 8 | AliExpress |
| 18 | Wall probe | ESP32 DevKit V1 (5) + GY-271 QMC5883L (2) + copper tape (2) + 10 MΩ resistor + 18650 cell with 5 V charge/boost board (4.5) + small box (2) | 16 | AliExpress |
| | **Total** | | **≈ 195** | |

### Build 3: Advanced (≈ €530)

| # | Part | Exact model | € | Where |
|---|---|---|---|---|
| 1 | Computer | Raspberry Pi Zero 2 W + heatsink | 21 | Pi resellers |
| 2 | Storage | 64 GB microSD A2 | 9 | any |
| 3 | Camera | Raspberry Pi AI Camera (IMX500) + Zero cable | 75 | Pi resellers |
| 4 | Thermal | InfiRay P2 Pro (USB-C) | 220 | InfiRay store / Amazon |
| 5 | USB | micro-USB OTG hub, 3 ports | 6 | AliExpress |
| 6 | Distance | TF-Luna LiDAR | 22 | AliExpress |
| 7 | Environment | BME680 | 9 | AliExpress |
| 8 | Radar | HLK-LD2450 | 10 | smarthomeshop.io / AliExpress |
| 9 | RF | RTL-SDR Blog V4 with dipole kit | 45 | rtl-sdr.com store |
| 10 | HUD | SSD1351 1.5" colour OLED + glass beam splitter + lens | 27 | AliExpress |
| 11 | Audio | INMP441 + MAX98357A + bone-conduction exciter | 13 | AliExpress |
| 12 | Power | Waveshare UPS HAT (C) + 10 000 mAh pocket power bank | 34 | Waveshare / any |
| 13 | Controls | buttons, LED, resistors | 1 | AliExpress |
| 14 | Frame + neck pod | glasses + 3D-printed pods/neck pod (own printer) | 8 | – |
| 15 | Mounting | wire, 50 cm camera ribbon for the neck pod, connectors | 12 | AliExpress |
| 16 | Wall probe | as mid | 16 | AliExpress |
| | **Total** | | **≈ 530** | |

The P2 Pro is 40 % of this budget. "Advanced-lite" keeps everything else and uses the MLX90640 instead, for **≈ €355**.

## 3. Budget summary

| | Ultra | Mid | Advanced |
|---|---|---|---|
| Hardware | €97 | €195 | €530 |
| Software | €0 | €0 | €0 |
| Cloud AI (optional) | €0–8/month | €0–8/month | €0–8/month |
| Tools, if you have none | €35–50 | €35–50 | €35–50 |
| 3D printing (optional) | €0 | €0–15 | €0–20 |
| Build time | 8–12 h | 12–20 h | 20–30 h |

**Tools you need once:** a soldering iron (cheap 60 W kit €15, or a Pinecil €30), solder, a multimeter (€12), a hot-glue gun (€8), flush cutters and tweezers. A 3D printer is helpful but optional: foam tape, Velcro, cable ties and heat-shrink are enough for a first prototype.

**Assembly cost** is your time: none of these builds needs paid assembly. Online 3D printing services charge about €10–20 for the small pods.

### Software costs

Everything on the device is free and open source: Raspberry Pi OS, Python, OpenCV, picamera2, Vosk, espeak-ng, Piper, luma.oled, the Adafruit CircuitPython drivers and bleak.

The **cloud assistant is optional** and pay-as-you-go through the Anthropic API. With no API key, the glasses answer from their own sensors. Estimated cost per question that includes a 768×576 camera image (about 600 image tokens, about 400 text tokens and a short answer):

| Model (`[assistant] model`) | Price per million tokens (input / output) | ≈ per question | 30 questions/day |
|---|---|---|---|
| `claude-opus-5-5` (default, most capable) | $4 / $20 | ≈ €0.009 | ≈ €8/month |
| `claude-haiku-5-5` | $0.10 / $0.50 | ≈ €0.0003 | ≈ €0.25/month |

These are estimates: actual cost depends on answer length and reasoning tokens. Choosing the model is your call. Haiku is about 40× cheaper, and Opus gives better descriptions and judgement.

## 4. What each build can do

| Feature | Ultra (€97) | Mid (€195) | Advanced (€530) |
|---|---|---|---|
| Live camera feed and zoom | ✅ 5 MP sensor, 4× crop zoom | ✅ 12 MP, autofocus, HDR | ✅ 12 MP |
| Night vision (850 nm active IR) | ✅ about 2–3 m | ✅ about 3–5 m, cleaner | ❌ (IR-cut camera); thermal replaces it |
| Low-light enhancement (software) | ✅ | ✅ much better sensor | ✅ |
| Thermal imaging | ⚠️ 8×8 heat grid | ✅ 32×24 image, 4 fps | ✅✅ 256×192, 25 fps |
| Thermal + camera fusion overlay | ⚠️ coarse | ✅ | ✅ |
| Object recognition on device | ✅ about 1/s, on request | ✅ about 1/s | ✅✅ about 30/s, continuous |
| Distance | ✅ about 1.2–2 m | ✅ about 4 m | ✅ 8 m |
| Air temperature / humidity / pressure | ⚠️ rough ambient only | ✅ | ✅ + VOC trend |
| Radar | ⚠️ motion yes/no | ✅ presence + distance, still people too | ✅ 3 people, x/y and speed |
| RF awareness | ✅ Wi-Fi/BLE counts | ✅ | ✅ + SDR spectrum |
| Wall probe (stud / metal / live AC hints) | ➕ add for €16 | ✅ | ✅ + thermal wall inspection |
| Voice commands (offline) + TTS | ✅ | ✅ | ✅ nicer voice (Piper) |
| Cloud vision Q&A | ✅ | ✅ | ✅ |
| HUD | ✅ mono 128×64 | ✅ colour 128×128 | ✅ colour 128×128 |
| Battery and system status | ✅ power-bank estimate | ✅ LiPo voltage curve | ✅ |
| Runtime | 5–7 h (pocket bank) | 2–2.5 h on-head LiPo | 6–8 h (bank + UPS buffer) |
| Weight on head | 70–90 g | 100–130 g | 90–120 g (neck pod) |

⚠️ = works with clear limits. ➕ = optional add-on.

## 5. Compatibility notes

- **Logic levels:** Pi GPIO pins are 3.3 V and are **not 5 V tolerant**. Power every I2C/SPI module from 3.3 V so its pull-up resistors pull to 3.3 V. The LD2410/LD2450 and RCWL-0516 run on 5 V but output 3.3 V, which is safe.
- **One I2C bus, no conflicts:** AMG8833 0x69, MLX90640 0x33, VL53L0X/VL53L1X 0x29, TF-Luna 0x10, BME280 0x76, BME680 0x77, INA219 0x40 (UPS HAT C: 0x43), SSD1306 0x3C.
- **One camera:** the Zero has a single CSI port. The P2 Pro is USB, so it can run alongside any CSI camera.
- **I2S:** the INMP441 and MAX98357A share one I2S bus through the `googlevoicehat-soundcard` overlay (the same pairing as Google's AIY Voice HAT).
- **UART:** the radar uses `/dev/serial0` (GPIO14/15). The serial console must be off (install.sh does this).
- **USB:** the Zero has one OTG port. The advanced build needs a small OTG hub for the P2 Pro and the RTL-SDR.

## Sources (price checks)

- Raspberry Pi Zero 2 W ≈ €24 shipped from BerryBase/Welectron: [Notebookcheck](https://www.notebookcheck.com/Deal-Raspberry-Pi-Zero-2-W-zum-vertretbaren-Preis-bei-deutschem-Haendler-sofort-verfuegbar.760084.0.html)
- Camera Module 3 NoIR €28.90: [Welectron](https://welectron.com/Official-Raspberry-Pi-Camera-Module-3-NoIR)
- MLX90640 module €48.40: [Waveshare](https://www.waveshare.com/product/modules/sensors/mlx90640-d110-thermal-camera.htm)
- AMG8833 Grove £31.40: [The Pi Hut](https://thepihut.com/collections/seeed/products/grove-amg8833-8-x-8-infrared-thermal-temperature-sensor-array)
- HLK-LD2410C from about €2.50: [openelab](https://openelab.io/products/ld2410c-distance-detection-radar-sensor-module), [Tinytronics](https://www.tinytronics.nl/en/home-automation/sensors/motion-and-presence/hi-link-hlk-ld2410c-24ghz-radar-sensor-module-with-bluetooth)
- HLK-LD2450 €9.50: [smarthomeshop.io](https://smarthomeshop.io/en/products/hlk-ld2450-24ghz-mmwave)
- InfiRay P2 Pro €204–260: [Notebookcheck](https://www.notebookcheck.com/Black-Friday-Deal-InfiRay-P2-Pro-Smartphone-Waermebildkamera-mit-Makrolinse-aktuell-21-guenstiger.925393.0.html)
- RTL-SDR Blog V4 (kit €87 at DigiKey; US$39.95 at launch from the official store): [DigiKey](https://www.digikey.de/en/products/detail/sparkfun-electronics/WRL-27543/26769969), [rtl-sdr.com](https://www.rtl-sdr.com/tag/rtl-sdr-blog/)
- Commodity modules (OLED, VL53L0X/L1X, INMP441, MAX98357A, INA219, RCWL-0516, BME280): typical AliExpress prices; resellers such as Fruugo and eBay often charge 3–10× more for the same boards.
