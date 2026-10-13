# PyInstaller recipe for the one-file Tradebot app (Windows .exe and macOS).
# Build from the tradebot folder:  pyinstaller --noconfirm packaging/Tradebot.spec
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

root = SPECPATH + "/.."
hidden = collect_submodules("hyperliquid") + collect_submodules("eth_account") + collect_submodules("solders") + ["base58"]
datas = [(root + "/bot/static", "bot/static"), (root + "/tradingview", "tradingview"), (root + "/config.example.json", ".")]
datas += collect_data_files("eth_account") + collect_data_files("hyperliquid")

a = Analysis([root + "/run.py"], pathex=[root], datas=datas, hiddenimports=hidden, excludes=["tkinter", "pytest"])
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, a.binaries, a.datas, name="Tradebot", console=True, upx=False)
