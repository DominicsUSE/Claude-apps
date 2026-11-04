"""Sensor workers. Each module exposes one Worker subclass plus pure helpers."""

from glasses.hub import require


def i2c_bus():
    """Open I2C bus 1 through Adafruit Blinka.

    On Linux the bus speed comes from /boot/firmware/config.txt
    (dtparam=i2c_arm_baudrate=...), not from Python.
    """
    board = require("board", "pip install adafruit-blinka")
    busio = require("busio", "pip install adafruit-blinka")
    return busio.I2C(board.SCL, board.SDA)
