# Quake Anything

Drop down (or side-dock) **any** GUI app with a keyboard shortcut — Quake-style, not just a terminal.

Configure apps in **Extension Manager** / **Extensions** → Quake Anything → Settings. There is no panel tray icon.

**UUID:** `quake-anything@yccoskun.github.io`  
**GNOME Shell:** 46–50

## Features

- Dock any installed GUI app to **top**, **bottom**, **left**, or **right**
- Multiple apps, each with its own shortcut and size
- Toggle show/hide with a custom keyboard shortcut
- Default size as a **percentage** of the monitor work area
- First spawn appears on the monitor under the mouse pointer
- Later show/hide restores the docked Quake layout (side + size %)
- While visible you can move, resize, minimize, or maximize freely; the next shortcut show snaps back to Quake position
- Only windows **spawned by this extension** are controlled (other windows of the same app are left alone)
- Cross-monitor moves keep the size **ratio** (not fixed pixels)

## Install

### Extension Manager / extensions.gnome.org

1. Open **Extension Manager** (or [extensions.gnome.org](https://extensions.gnome.org))
2. Search for **Quake Anything** (once published)
3. Install and enable it
4. Open the extension’s **Settings** and add your apps

### From this repository (manual)

```bash
git clone https://github.com/yccoskun/quake-anything.git
cd quake-anything
bun install
bun run pack
gnome-extensions install --force quake-anything@yccoskun.github.io.shell-extension.zip
```

Or install straight into your user extensions directory:

```bash
bun run install-ext
```

Then log out and back in (Wayland), and enable:

```bash
gnome-extensions enable quake-anything@yccoskun.github.io
```

## Setup

In Settings, add an entry and set:

| Setting | Meaning |
|--------|---------|
| **Application** | Any installed GUI app |
| **Side** | Top / bottom / left / right |
| **Keyboard shortcut** | Toggle show/hide (Esc cancels, Backspace clears; conflicts are warned) |
| **Default size** | Percentage of the monitor work area (10–90%) |

Press the shortcut to spawn. Press again to hide. Press again to show at the Quake edge and size.

## Notes

- On Wayland, reloading GNOME Shell requires logging out and back in. You can often reload just this extension with disable → enable.
- Client-side window buttons (minimize/maximize) stay visible for many apps; GNOME does not let extensions remove them reliably.
- Some single-instance apps cannot open a second window when one is already running. For these, the shortcut adopts the app's existing window into the Quake layout instead of doing nothing.

## Development

Requires [Bun](https://bun.sh/) (or Node) and TypeScript. Source under `src/` is compiled with `tsc` into separate modules under `dist/` (not bundled into one file — required for EGO review).

```bash
bun install
bun run build          # tsc → dist/*.js (+ dist/prefs/)
bun run schemas        # compiles GSettings schemas
bun run pack           # stages modular tree and packs the zip
bun run install-ext    # stages and installs into ~/.local/share/...
```

Packed runtime layout:

- `extension.js`, `prefs.js` (entry points)
- `types.js`, `geometry.js`, `keybindings.js`, `quake-manager.js`
- `prefs/conflicts.js`, `prefs/shortcut-dialog.js`
- `metadata.json`, `LICENSE`, `schemas/`
