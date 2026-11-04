# Roadmap, assembly, testing and upgrades

## Development roadmap

Each stage ends with a test you can pass before moving on. Modules you haven't built yet stay at `driver = "none"` (or `sim`) in `config.toml`.

| Stage | Goal | Parts | Config to enable | Done when |
|---|---|---|---|---|
| **1. Basic system** | Pi boots, joins Wi-Fi, app runs, dashboard reachable | Pi, SD card, power bank | everything `sim` except `battery` | `--selftest` all OK; dashboard opens on your phone |
| **2. Camera + thermal** | Live view, zoom, thermal page, fusion | camera, thermal sensor | `camera`, `thermal` | Hand appears warm on the correct side; fusion lines up at 2 m |
| **3. Night vision + sensors** | IR night mode, distance, environment, radar, RF | IR LEDs, ToF, BME, radar | `distance`, `environment`, `radar`, `rf` | Night mode shows a dark room to 2 m; distance within ±5 cm at 1 m |
| **4. AI assistant** | Voice commands, TTS, detection, cloud Q&A | mic, amp, speaker, buttons | `voice`, `detector`, `[assistant]` | "how far" is answered; "describe" names objects in front of you |
| **5. HUD** | OLED behind the beam splitter, readable | OLED, optics | `hud` | All 8 pages readable indoors with both eyes open |
| **6. Optimise** | Power, heat, size | heatsink, insulation | tune intervals, `cpu_throttle_c` | 1 h soak: CPU < 75 °C, skin-side < 40 °C, no under-voltage |
| **7. Assemble + test** | Everything on the frame | frame, wiring | final `config.toml` | Full test checklist below passes |

## Assembly

**Before you solder:** build the whole circuit on a breadboard with the Pi on a desk. Pass stage tests 1–5, and only then make it wearable.

1. **Prepare the Pi.** Solder thin silicone wires (30 AWG for signals, 24 AWG for 5 V/GND) directly to the header pads instead of fitting a pin header. This saves 8 mm of height. Stick a small heatsink on the SoC.
2. **Make an I2C "spine":** a strip of perfboard with 3V3, GND, SDA and SCL rails. Every I2C module plugs into it with a 4-wire JST-SH cable, which makes modules swappable.
3. **Front sensor bar.** Mount the camera, thermal sensor, ToF sensor and IR LEDs side by side on a strip of perfboard or a 3D-printed bar across the top of the frame. Keep the camera and thermal sensor as close together as possible (less parallax in fusion). Leave the thermal sensor's window **open** (no glass or plastic in front). Point the IR LEDs forward, slightly away from the camera lens, to avoid glare.
4. **Left temple pod:** Pi Zero, INA219 and the mic near the hinge (facing your mouth). Wrap the Pi side that faces your head in 2–3 mm of foam or cork, and leave the outer side vented.
5. **Right temple: HUD.** Mount the OLED facing down or sideways, then the 25 mm lens about 40 mm from it, then the beam splitter at 45° in front of your eye. Adjust the OLED–lens distance until the text looks sharp at arm's length. Set `[hud] mirror = true`, and set `rotate` until the text reads correctly.
6. **Speaker** near the right ear. **Buttons** under the left temple, where your thumb rests (talk) and in front of it (mode). **Privacy LED** on the front, visible to others.
7. **Radar:** the LD2410C fits on the bridge. The RCWL-0516 is larger, so mount it on top of a temple, facing forward, with nothing metal in front of it.
8. **Power:** run one thin cable from the left temple pod down to the pocket power bank (ultra) or the neck pod. Add strain relief with hot glue and heat-shrink at every hinge crossing.
9. **Final check:** no exposed 5 V near metal parts; all connectors glued or latched; weight balanced (add the battery at the back of the head if the front is too heavy).

## Test procedures

### Bench tests (stage by stage)

| Test | Command / action | Expected |
|---|---|---|
| I2C bus | `i2cdetect -y 1` | `33`/`69` (thermal), `29` (ToF), `76`/`77` (BME), `40` (INA219), `3c` (OLED) |
| Camera | `rpicam-hello --list-cameras` then `rpicam-still -o test.jpg` | camera listed (`ov5647`, `imx708` or `imx500`); sharp image |
| UART radar | `python -m glasses --selftest` | `radar ld2410 OK` |
| Microphone | `arecord -l`, then `arecord -D plughw:0 -f S16_LE -r 16000 -c 1 -d 3 t.wav && aplay t.wav` | card `sndrpigooglevoi`; your voice plays back |
| Speaker | `speaker-test -t sine -f 440 -l 1` then `espeak-ng "hello"` | tone and speech |
| Thermal cameras (USB) | `v4l2-ctl --list-devices` | P2 Pro listed; set its `/dev/videoN` in `[thermal] device` |
| All modules | `.venv/bin/python -m glasses --selftest` | every line `OK` |
| Software logic | `.venv/bin/python -m pytest` | all tests pass |

### Functional tests

| Feature | Procedure | Pass criterion |
|---|---|---|
| Distance accuracy | Tape measure, white wall at 0.3 / 0.6 / 1.0 m (and 2 / 3 m for the L1X/TF-Luna) | within ±5 % indoors |
| Thermal accuracy | Glass of ice water (0 °C) and a mug of just-boiled water (cooling from about 95 °C; check with a kitchen thermometer). Measure at 30 cm with the target filling the centre. | AMG8833 within ±2.5 °C, MLX90640 within ±1.5 °C, P2 Pro within ±2 °C |
| Thermal orientation | Hold a hand on the left of the view | heat appears on the left (otherwise flip `flip_h`) |
| Fusion alignment | Hot mug at 2 m in fusion mode | hotspot sits on the mug; tune `fusion_offset_*` / `fusion_scale` |
| Night vision | Dark room, night mode | person recognisable at 2 m (ultra) / 3 m (mid) |
| Radar | Walk towards the glasses from 6 m | motion reported from about 5 m; LD2410 distance within ±0.5 m |
| Obstacle alert | Approach a wall slowly | "Obstacle ahead" below 0.6 m, repeated at most every 8 s |
| Voice | 20 commands from the table in SOFTWARE.md, in a quiet room | at least 17 recognised correctly; raise `mic_gain` if words are missed |
| Assistant | "describe" with Wi-Fi on, then off | sensible description online; offline fallback sentence otherwise |
| Wall probe | Calibrate on a bare wall, then slide across a known stud, a screw and a socket (circuit on, no contact with the metal) | stud / metal / AC flags at those spots. Tune the thresholds from the values in the dashboard. |
| HUD readability | Indoors, by a window, outdoors in the shade | readable in the first two; direct sun is a known limit |
| Battery runtime | Full power bank, `normal` mode, dashboard closed, check every 30 min | ≥ 5 h (ultra, 5000 mAh); the `runtime_h` estimate is within ±20 % after the first hour |
| Heat soak | 1 h in `fusion` mode with the dashboard open | CPU < 80 °C (throttle alert above 75 °C), temple pod surface < 40 °C to the touch |
| Robustness | Unplug the thermal sensor while running, then plug it back in | status turns `unavailable`, HUD shows "NO THERMAL DATA", and it recovers within about 30 s without a restart |

## Upgrade recommendations

In order of value per euro:

1. **AMG8833 → MLX90640 (+€25).** 12× the thermal pixels. This is the biggest single jump in the ultra build.
2. **RCWL-0516 → LD2410C (+€3).** Distance plus detection of still people.
3. **OV5647 → Camera Module 3 NoIR (+€21).** Far better low-light and night images, plus autofocus.
4. **Wall probe (+€16).** Stud, metal and live-AC hints, plus thermal wall inspection with an MLX90640 or better.
5. **Mono OLED → SSD1351 colour OLED (+€12).** Colour thermal map in the HUD.
6. **Pi AI Camera (+€72).** Continuous 30 fps object detection without loading the CPU.
7. **InfiRay P2 Pro (+€220).** A real thermal camera: people at more than 20 m, fine detail.
8. **Faster speech:** replace Vosk-small with a Whisper-tiny server on your phone or a home PC, through the same `("text", ...)` command path.
9. **More compute:** move the Pi into a neck pod and swap it for a Raspberry Pi 5 (keep the glasses as sensors plus display over a 50 cm cable). This allows YOLO-class detection at 10 fps and local LLMs.
10. **Better display:** commercial open-source AR glasses such as Brilliant Labs Frame (about €350) can act as the display, receiving HUD text over BLE instead of the DIY optics.

Not recommended: "through-wall" radar imaging modules sold to hobbyists (they do not deliver imaging), and high-power IR floodlights near the face.
