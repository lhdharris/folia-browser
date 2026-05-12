<p align="center">
  <img src="folia-icon.svg" alt="" width="96" height="96">
</p>

<h1 align="center"><em>Folia Browser</em></h1>

<p align="center"><em>A browser for people who do things on purpose.</em></p>

---

One window holds one page, one intention. No tabs. No notifications. No "for you" anywhere.

When you're done, you close it.

That's the whole interaction model.

## What it is

A frameless, single-page Electron browser. Every link that wants a new context — `target="_blank"`, `window.open()`, OAuth popups, middle-click — opens its own window. The URL bar appears once; you type into it, hit enter, and it's replaced by a quiet label saying what this window is for.

You read the page. You finish reading. You close the window.

## What it does

- **One page per window.** No tab strip. No tab hoarding. Window management is your OS's job.
- **Notifications are off.** Permanently. No prompts, no override, no toggle.
- **One login works everywhere.** All windows share a single cookie jar — sign into Google once and Gmail, Docs, YouTube all follow.
- **DRM works.** Netflix, Spotify, Bitmovin — Widevine is built in via [Castlabs ECS](https://github.com/castlabs/electron-releases).
- **Camera, microphone, screen sharing** all work for Meet, Jitsi, Discord, and the rest.
- **Available** for Linux (`.rpm`, `.deb`), Windows (`.exe`), and macOS (`.dmg`).

## What it deliberately doesn't have

No tabs. No notifications. No bookmarks bar. No history dropdown. No "continue where you left off." No telemetry. No "for you" surfaces. No extensions store. No sync service.

Each is a feature.

## Install

Grab the latest installer for your OS from the [Releases](https://github.com/lhdharris/folia-browser/releases) page.

### Linux

```bash
# Fedora, RHEL, openSUSE
sudo rpm -i folia-browser-*.x86_64.rpm

# Debian, Ubuntu
sudo dpkg -i folia-browser_*_amd64.deb
```

A `.desktop` entry registers Folia as a candidate `http`/`https` handler.

### macOS

The app is unsigned. The first time you launch it, right-click → **Open** to bypass Gatekeeper.

### Windows

Run the NSIS installer (`Folia Browser Setup *.exe`).

## Build from source

```bash
cd electron-app
npm install
npm start                         # dev
npm start -- https://example.com  # pass a URL

npm run build:linux               # → dist/  .rpm + .deb
npm run build:win                 # → dist/  .exe   (needs wine on Linux hosts)
npm run build:mac                 # → dist/  .dmg   (must run on a Mac)
```

## Credit

Widevine DRM via [Castlabs Electron for Content Security](https://github.com/castlabs/electron-releases) (their `+wvcus` build).

## License

MIT.

---

<p align="center"><em>One window. One page. When you're done reading, close it.</em></p>
