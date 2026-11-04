#!/usr/bin/env bash
# One-time setup on Raspberry Pi OS Lite 64-bit (Bookworm or Trixie), Pi Zero 2 W.
# Run from anywhere: ./scripts/install.sh   (then reboot)
set -euo pipefail
cd "$(dirname "$0")/.."

CONFIG=/boot/firmware/config.txt
[ -f "$CONFIG" ] || CONFIG=/boot/config.txt

echo "== apt packages"
sudo apt-get update
sudo apt-get install -y python3-venv python3-picamera2 python3-opencv python3-numpy \
  python3-pil python3-gpiozero python3-lgpio i2c-tools alsa-utils espeak-ng unzip curl \
  v4l-utils network-manager
# Advanced build only: sudo apt-get install -y rtl-sdr

echo "== interfaces (I2C, SPI, UART without console)"
sudo raspi-config nonint do_i2c 0
sudo raspi-config nonint do_spi 0
sudo raspi-config nonint do_serial_cons 1 || echo "!! disable the serial console manually (raspi-config)"
sudo raspi-config nonint do_serial_hw 0 || echo "!! enable the serial port manually (raspi-config)"

add_line() { grep -qxF "$1" "$CONFIG" || echo "$1" | sudo tee -a "$CONFIG" >/dev/null; }
add_line "dtparam=i2c_arm_baudrate=400000"     # MLX90640 needs fast I2C
add_line "dtoverlay=googlevoicehat-soundcard"  # INMP441 mic + MAX98357A amp on I2S

echo "== python environment"
python3 -m venv --system-site-packages .venv
.venv/bin/pip install --upgrade pip
.venv/bin/pip install -r requirements-pi.txt

[ -f config.toml ] || cp configs/ultra.toml config.toml
if [ ! -f .env ]; then
  echo "# ANTHROPIC_API_KEY=sk-ant-...   (optional: enables the cloud assistant)" > .env
  chmod 600 .env
fi

sudo usermod -aG i2c,spi,gpio,dialout,video,audio,bluetooth,netdev "$USER"

echo "== systemd service"
sed "s|@DIR@|$PWD|g; s|@USER@|$USER|g" scripts/smart-glasses.service \
  | sudo tee /etc/systemd/system/smart-glasses.service >/dev/null
sudo systemctl daemon-reload

cat <<EOF
Done. Next:
  sudo reboot
  ./scripts/download_models.sh
  .venv/bin/python -m glasses --selftest
  sudo systemctl enable --now smart-glasses     # start on every boot
EOF
