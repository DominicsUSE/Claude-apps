"""Low-cost AI smart glasses for the Raspberry Pi Zero 2 W.

Sensors, vision, voice assistant and HUD run as independent worker threads
that share one state store (``glasses.hub.Hub``). Every hardware module has a
``sim`` driver, so the whole system runs on a laptop with ``--sim``.
"""

__version__ = "0.1.0"

# One mode drives both the camera pipeline and the HUD page.
MODES = ("normal", "lowlight", "night", "thermal", "fusion", "sensors", "wall", "ai")
