// Wall probe for the AI smart glasses - ESP32 DevKit V1 (ESP32-WROOM-32).
//
// Streams three raw readings as JSON over Wi-Fi UDP broadcast, ~4 times a second:
//   cap - touchRead() of a copper-tape pad on the probe face. It DROPS over
//         denser material behind the wall (stud, water pipe).
//   mag - field strength from a GY-271 (QMC5883L) magnetometer. It CHANGES near
//         ferrous metal: screws/nails in studs, steel pipes, rebar.
//   ac  - 50 Hz component picked up by an antenna wire. It RISES near live,
//         unshielded mains wiring close to the surface.
// The glasses do calibration and thresholds (glasses/sensors/wallprobe.py).
//
// A HINT TOOL, NOT A SAFETY DEVICE. Switch off the circuit and use a certified
// detector before drilling. It cannot detect plastic pipes, deep or shielded
// cables, or anything more than ~2-3 cm behind the surface.
//
// Arduino IDE: board "ESP32 Dev Module" (esp32 core 2.x or 3.x).

#include <WiFi.h>
#include <WiFiUdp.h>
#include <Wire.h>
#include <math.h>

// ---- settings ---------------------------------------------------------------
const char* WIFI_SSID = "YOUR_HOTSPOT";  // same network as the glasses
const char* WIFI_PASS = "YOUR_PASSWORD";
const uint16_t UDP_PORT = 5005;          // must match [wallprobe] port
const float MAINS_HZ = 50.0f;            // 60.0 in the Americas
const int TOUCH_PIN = T0;                // GPIO4 -> copper pad (insulate it with tape)
const int AC_PIN = 34;                   // ADC1 pin: 15 cm antenna wire + 10 MOhm to GND
const int LED_PIN = 2;                   // on-board LED toggles on every packet
const uint8_t QMC5883L = 0x0D;           // GY-271 boards with the QMC chip

WiFiUDP udp;
bool magOk = false;

void qmcWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(QMC5883L);
  Wire.write(reg);
  Wire.write(val);
  Wire.endTransmission();
}

bool qmcInit() {
  Wire.beginTransmission(QMC5883L);
  if (Wire.endTransmission() != 0) return false;  // not connected
  qmcWrite(0x0B, 0x01);  // SET/RESET period
  qmcWrite(0x09, 0x1D);  // continuous, 200 Hz, 8 gauss, oversampling 512
  return true;
}

float qmcMagnitude() {
  Wire.beginTransmission(QMC5883L);
  Wire.write(0x00);
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom((int)QMC5883L, 6) != 6) return NAN;
  int16_t v[3];
  for (int i = 0; i < 3; i++) {
    uint8_t lo = Wire.read();
    uint8_t hi = Wire.read();
    v[i] = (int16_t)(lo | (hi << 8));
  }
  return sqrtf((float)v[0] * v[0] + (float)v[1] * v[1] + (float)v[2] * v[2]);
}

float capacitive() {
  uint32_t sum = 0;
  for (int i = 0; i < 16; i++) sum += touchRead(TOUCH_PIN);
  return sum / 16.0f;
}

// Goertzel filter: strength of the mains frequency in 200 ms of samples at 1 kHz.
float mainsField() {
  const int N = 200;
  const float FS = 1000.0f;
  static float buf[N];
  float mean = 0;
  uint32_t next = micros();
  for (int i = 0; i < N; i++) {
    while ((int32_t)(micros() - next) < 0) {}
    next += 1000;
    buf[i] = analogRead(AC_PIN);
    mean += buf[i];
  }
  mean /= N;
  const float coeff = 2.0f * cosf(2.0f * PI * MAINS_HZ / FS);
  float s1 = 0, s2 = 0;
  for (int i = 0; i < N; i++) {
    float s0 = (buf[i] - mean) + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return sqrtf(fmaxf(s1 * s1 + s2 * s2 - coeff * s1 * s2, 0.0f)) * 2.0f / N;  // amplitude in ADC counts
}

void setup() {
  Serial.begin(115200);
  pinMode(LED_PIN, OUTPUT);
  Wire.begin(21, 22);  // SDA, SCL
  magOk = qmcInit();
  Serial.println(magOk ? "magnetometer OK" : "no magnetometer (mag will read 0)");
  analogReadResolution(12);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  for (int i = 0; i < 30 && WiFi.status() != WL_CONNECTED; i++) delay(500);
  Serial.println(WiFi.status() == WL_CONNECTED ? WiFi.localIP().toString() : "Wi-Fi not connected yet");
}

void loop() {
  float cap = capacitive();
  float mag = magOk ? qmcMagnitude() : NAN;
  float ac = mainsField();
  char msg[96];
  snprintf(msg, sizeof msg, "{\"cap\":%.1f,\"mag\":%.1f,\"ac\":%.1f}", cap, isnan(mag) ? 0.0f : mag, ac);
  if (WiFi.status() == WL_CONNECTED) {
    udp.beginPacket(IPAddress(255, 255, 255, 255), UDP_PORT);
    udp.print(msg);
    udp.endPacket();
  }
  Serial.println(msg);  // also readable in the Serial Monitor for threshold tuning
  digitalWrite(LED_PIN, !digitalRead(LED_PIN));
}
