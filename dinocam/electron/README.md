# DinoCamSecurity — native Windows app (Electron)

This packages `../index.html` as a real Windows `.exe` — a proper installer with
Desktop and Start Menu shortcuts (dinosaur icon), no browser required, no `.cmd` file
to run. If you just want the lighter-weight option (open the same app in an Edge/Chrome
app-window via a Desktop shortcut, no ~70MB download), see `../windows/` instead — both
ship the exact same `../index.html`, this just wraps it in its own window instead of
reusing your browser's.

## Build it yourself

```
npm install
npm run dist:win
```

Output lands in `dist/`:
- `DinoCamSecurity Setup 2.0.0.exe` — the installer (creates the Desktop/Start Menu
  shortcuts, lets you pick an install directory). This is the one most people want.
- `DinoCamSecurity 2.0.0.exe` — a portable single-file version, no installation, no
  shortcuts, just run it from wherever it sits.

`npm run prebuild` (runs automatically before `start`/`dist:win`) copies the current
`../index.html` and `../windows/dinosaur.ico` in here before packaging, so what gets
built always matches whatever's currently in `dinocam/index.html` — nothing is
duplicated or hand-maintained in this folder.

## Building on Linux/macOS (cross-compiling for Windows)

electron-builder needs Wine to embed the icon and version info into a Windows `.exe`
when you're not building on Windows itself:

```
sudo dpkg --add-architecture i386
sudo apt-get update
sudo apt-get install -y wine wine64 wine32:i386
```

(Just `wine64` isn't enough — the icon-embedding tool electron-builder uses is 32-bit,
so `wine32:i386` specifically is required too. If you're building on an actual Windows
machine, or in GitHub Actions' `windows-latest` runner, none of this is needed.)

## What was and wasn't verified before this shipped

Both `.exe` files were actually built here (not just configured) and checked for real:
- Valid Windows PE32 executable headers (MZ/PE signatures) on both files.
- The dinosaur icon is genuinely embedded — extracted from the built `.exe`'s own
  resources and confirmed pixel-for-pixel, not assumed from the build config.
- The packaged `index.html` inside the `.exe` was diffed against the committed
  `dinocam/index.html` and is byte-identical — the build isn't shipping a stale copy.

**Not verified: actually running on Windows.** This was all built and checked from a
Linux environment with no Windows machine available, so nobody has clicked these files
and watched the app open, the camera start, or a plate get read. Do that once before
handing this to anyone else. The camera permission handling in `main.js`
(`setPermissionRequestHandler`) is the one part most likely to need a second look if
the camera doesn't start — Electron's permission model differs from a normal browser's.
