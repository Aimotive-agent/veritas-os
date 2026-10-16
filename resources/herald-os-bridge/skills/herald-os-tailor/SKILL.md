---
name: herald-os-tailor
description: Change Herald OS itself - make and switch themes, fonts and the wallpaper, widgets, the menu bar, control-menu entries, branding, keybindings, settings, routines and hooks
metadata:
  hermes:
    tags: [herald-os, customise, themes, settings, linux, macos]
---

# Tailor Herald OS

Herald OS is meant to be shaped by the person using it, and by you on their behalf. Use this when
they ask to change how Herald OS looks or behaves: "make me a calm green theme", "use a bigger
font", "add a shortcut for Obsidian", "do this every time I log in".

Ground rules:

- Change settings through `os_ui` commands, never by editing `~/.hermes/herald-os/prefs.json`
  while the shell runs (it rewrites that file).
- Say what you changed and how to undo it in one sentence ("Switched to Dusk; say 'use the
  ocean theme' to go back").
- Ask before anything large or hard to undo, and keep a copy of any file you replace.

## Themes

A theme recolours everything at once: the shell, your own CLI skin and, on Herald OS Linux, the
compositor, GTK apps, the lock screen and the terminal.

- `os_ui action=run command=theme.list`, then `theme.set args={"theme": "<name>"}`.
- From an image: `theme.generate args={"image": "<path>", "name": "<label>"}` (optional
  `"scheme": "dark" | "light"`). It saves the theme, makes the image the wallpaper and applies it.
- From a description ("a sunset theme", "something like old paper"): write the theme yourself.
  Create `~/.config/herald-os/themes/<name>/theme.json` with `write_file`, then run `theme.set`.
  `<name>` is the folder name: lowercase letters, digits and dashes. The file:

```json
{
  "name": "sunset",
  "label": "Sunset",
  "description": "Warm dusk orange on deep plum.",
  "shell": { "scheme": "dark" },
  "wallpaper": "default",
  "colors": {
    "bg": "#170d14", "bg2": "#26131f", "surface": "#2e1726",
    "fg": "#fbefe9", "fg_dim": "#c4a0a4",
    "accent": "#ff8a4c", "accent_strong": "#ffa36e",
    "border_active": "#ff8a4c", "border_inactive": "#3e1f30",
    "urgent": "#ff6b6b", "ok": "#5fd39a", "warn": "#f2c25e"
  },
  "gtk": { "color_scheme": "prefer-dark", "theme": "Adwaita-dark" }
}
```

  Every colour is `#rrggbb`. Text (`fg`) needs at least 7:1 contrast against `bg`, the accent at
  least 3:1. Dark themes keep `bg` very dark; light themes set `"scheme": "light"`, a very light
  `bg`, dark `fg`, and `"gtk": {"color_scheme": "default", "theme": "Adwaita"}`. `bg2` and
  `surface` are a few steps from `bg` toward the accent (dark) or toward white (light). A
  `"terminal"` block (`background`, `foreground`, `cursor`, a 16-colour `palette`) is optional;
  the shell derives one when it is missing. `"wallpaper"` is `"default"` (the drawn Herald
  wallpaper, tinted to the theme) or an image file inside the theme's folder.
- Someone shared a theme repository: `theme.install args={"url": "https://…"}`. Only colours and
  images are kept.
- Undo: `theme.set args={"theme": "herald-ocean"}`, the default.

## Fonts and wallpaper

- `font.list` (optional `filter`), then `font.set args={"family": "Inter"}` for the interface or
  `{"family": "JetBrains Mono", "kind": "mono"}` for code and the terminal. `"default"` resets.
- `wallpaper.set args={"image": "<path>"}`, or `"default"` for the drawn wallpaper.

## Widgets

A widget is a small web page that sits in the menu bar (a 24 px strip), on the Overview (a card)
or in its own window. Make one when they want something to glance at: "a strip with the weather",
"a CPU meter", "a countdown to Friday".

1. Write it into `~/.config/herald-os/plugins/<id>/` with `write_file`. `<id>` is lowercase
   letters, digits and dashes, and is the folder name.
2. `manifest.json`:

```json
{
  "id": "weather-strip",
  "name": "Weather strip",
  "version": "1.0.0",
  "description": "The temperature here, in the menu bar.",
  "entry": "index.html",
  "placement": ["menubar"],
  "size": { "width": 90, "height": 96 },
  "permissions": ["storage"],
  "hosts": ["api.open-meteo.com"]
}
```

   - `placement`: any of `menubar`, `overview`, `panel`. `size.width` is its menu-bar width (up
     to 240), `size.height` its Overview card height.
   - `permissions`: only what it needs. `stats` (CPU, memory, disks, battery), `notify`,
     `storage` (its own small key-value store) and `run:<command.id>` for each Herald OS command
     it runs, such as `run:page.open`. Commands that change things still ask the person.
   - `hosts`: the HTTPS hosts it fetches from. Nothing else is reachable, and the API must allow
     cross-origin requests (most public JSON APIs do).
3. `index.html` loads the SDK and its own script file. Inline `<script>` is blocked; inline styles
   are fine. Keep the background transparent so it sits on the shell's glass.

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <script src="herald-plugin://sdk/widget.js"></script>
    <script src="widget.js" defer></script>
  </head>
  <body style="margin: 0; font: 500 11px/24px system-ui; color: var(--herald-fg)">
    <span id="out">…</span>
  </body>
</html>
```

4. The SDK in `widget.js`:
   - `await herald.stats()` gives `{ cpuPercent, memoryUsed, memoryTotal, disks, battery, uptimeSeconds }`.
   - `herald.notify(title, body)`, `herald.storage.get(key)` and `herald.storage.set(key, value)`.
   - `herald.run('page.open', { name: 'missions' })` runs a Herald OS command it was granted.
   - `herald.placement` is where it sits (`menubar`, `overview` or `panel`), also set as
     `data-placement` on `<html>` for CSS.
   - The theme arrives as CSS variables: `--herald-bg`, `--herald-surface`, `--herald-fg`,
     `--herald-fg-dim`, `--herald-accent`, `--herald-line`, `--herald-ok`, `--herald-warn`,
     `--herald-urgent`; `herald.onTheme(colors => …)` hears changes.
5. Never turn it on yourself. Say: "It's in Settings > Plugins; turn on Weather strip there after
   checking what it asks for." `os_ui action=run command=plugin.manage` shows that page. Once it is
   on, every saved change reloads it, so iterate by editing the files.
6. To share it, the folder is a git repository; others install it with `herald-os plugin add <url>`
   (it arrives turned off for them too).

## The menu bar

- `bar.layout` lists the items left to right (search, widgets, voice, indicators, usage, wifi,
  bluetooth, sound, battery, notifications, clock) and which are shown.
- `bar.hide item=bluetooth`, `bar.show item=battery`. The status lights (`indicators`: recording,
  dictation, switches that are on) always show; say why if asked to hide them.
- `bar.move item=clock position=first` (also `last`, a number with 1 leftmost, or `before=` /
  `after=` another item).
- `bar.clock hours=24` (`12`, `system`), `seconds=true`, `date=none` (`short`, `long`).
- `bar.reset` puts it all back. Settings > Appearance > Menu bar shows the result.

## Control-menu entries

The control menu (`Mod+M`) takes the person's own entries from `~/.config/herald-os/menu.json`.
Write it with `write_file`, keeping any entries already there:

```json
{
  "entries": [
    { "label": "Notes", "hint": "Obsidian", "icon": "notes", "herald-os": ["launch", "obsidian"] },
    { "label": "Back up photos", "group": "trigger", "exec": ["rsync", "-a", "~/Pictures/", "/mnt/backup/Pictures/"] },
    { "label": "Standup doc", "icon": "world", "url": "https://docs.example.com/standup" },
    { "label": "Missions", "command": "page.open", "args": { "name": "missions" } }
  ]
}
```

- Each entry has a `label` and exactly one action: `herald-os` (a `herald-os` command as a list of
  words), `exec` (a program and its arguments, as a list; `~/` is the home folder; no shell, so no
  pipes), `url` (http or https) or `command` (a Herald OS command id and its `args`).
- `group` puts it in an existing group (`install`, `remove`, `update`, `style`, `trigger`,
  `capture`, `toggle`, `system`, `hermes`); otherwise it sits under "Yours". `icon` is one of star,
  app, terminal, world, bolt, folder, notes, music, camera, code, calendar, mail, chat, heart,
  home, rocket.
- The menu reads the file each time it opens. `herald-os menu check` shows what it understood and
  any problems.

## Branding

- `branding.set args={"logo": "<image path>"}` puts a PNG, JPEG, WebP or SVG logo at the top of
  Settings > About; `"name": "Acme Corp"` adds a line under it. The image is copied, so the
  original can move.
- `branding.set args={"lock": "<image path>"}` (PNG or JPEG) is the picture behind the password
  ring on the Herald OS Linux lock screen.
- `branding.reset` (or `what=logo`, `lock`, `name`) goes back to the Herald logo and the theme's
  lock screen.

## Settings

The shell's settings are commands: `accent.set`, `dock.autoHide`, `motion.reduce`,
`voice.engine.set`, `voice.wake.set`, `crash.help`, `theme.followHermes` and more. Run
`os_ui action=list` for the full list with arguments, and `settings.open section=<id>` to show the
person the result.

## Keybindings (Herald OS Linux)

The compositor is niri. The Herald OS session starts it with `~/.config/niri/herald-os.kdl`, which
Herald OS renders from its template at every login and whenever the keymap changes, so never edit
it: the next login undoes the change. The person's own binds and other per-machine settings go in
`~/.config/niri/local.kdl`, which that file includes last and Herald OS never touches. Add binds
there, not to `~/.config/niri/config.kdl`, which the Herald OS session does not read:

```kdl
binds {
    Mod+Shift+O hotkey-overlay-title="Obsidian" { spawn "flatpak" "run" "md.obsidian.Obsidian"; }
    Mod+Ctrl+T { spawn "herald-os" "open" "terminal"; }
}
```

niri reloads the file as soon as it is saved. Check it with
`niri validate -c ~/.config/niri/herald-os.kdl` in the terminal (it reads `local.kdl` through the
include), and read the hotkey overlay (`Mod+K`) before reusing a key: Herald OS already binds many
`Mod+…` combinations. Any `herald-os` command can be a bind
(`spawn "herald-os" "theme" "set" "herald-dusk"`).

To change one of Herald OS's own keys, bind the same key in `local.kdl`: it is included last, and
niri lets a later bind replace an earlier one. To switch a key off, bind it to nothing:
`Mod+Q { spawn "true"; }`. Only bind a key once inside `local.kdl` itself; niri refuses a file that
binds the same key twice.

Inside Omarchy (Herald OS as an app on Hyprland), Herald's keys are in
`~/.config/hypr/herald-os.lua` on Omarchy 4 (`herald-os.conf` on Omarchy 3), which
`herald-os omarchy install` rewrites. Change them in the person's own Hyprland config instead: on
Omarchy 4, below the `require("hypr.herald-os")` line at the end of `~/.config/hypr/hyprland.lua`
(it has to run after Herald's), `hl.unbind("SUPER + ALT + H")` and then their own
`o.bind("KEYS", "description", "command")`; on Omarchy 3, `unbind = SUPER ALT, H` and then their
own `bind = …` line. Check the result with `hyprctl configerrors` after `hyprctl reload`.

## Routines

- Something on a schedule: `automation.create args={"name": …, "schedule": "every weekday at 9am", "prompt": …}`.
- Something each time an event happens ("every time I log in", "when the battery is low",
  "when Safari crashes"): `automation.create` with `"event"` (and `"match"`) instead of a schedule,
  or a hook script for chores that need no Hermes. The `herald-os` skill lists the events and how
  hooks run.
