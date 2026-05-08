# Folia Browser

A frameless, transparent, single-page Electron browser. There are no tabs — every link that wants a new context (`target="_blank"`, `window.open()`, OAuth popups, middle-click) opens its own window. Widevine DRM works out of the box via [Castlabs ECS](https://github.com/castlabs/electron-releases), so Netflix, Spotify, bitmovin etc. play.

## Install

### Linux (RPM)

Built for openSUSE Tumbleweed; should work on any RPM-based distro (Fedora, RHEL).

```bash
sudo rpm -i folia-browser-1.0.0.x86_64.rpm
```

The binary lands at `/opt/Folia Browser/folia-browser`, with a `folia-browser` symlink in `/usr/bin/`. A `.desktop` entry registers it as a candidate `http`/`https` handler.

### macOS

Build on a Mac (cross-compiling from Linux is officially unsupported by `electron-builder`):

```bash
cd electron-app
npm install
npm run build:mac           # → dist/Folia Browser-1.0.0-{arch}-mac.zip
unzip "dist/Folia Browser-1.0.0-arm64-mac.zip"
mv "Folia Browser.app" /Applications/
```

The app is unsigned. The first time you launch it, right-click → **Open** to bypass Gatekeeper.

## First-launch DRM note

On first launch, Castlabs ECS downloads the Widevine CDM via Chromium's Component Updater (a few seconds). On Linux, sandboxing requires an **app restart** before the CDM is active — quit and relaunch once. Subsequent launches are instant. See [`DRM_SETUP.md`](./DRM_SETUP.md).

## Build from source

```bash
cd electron-app
npm install
npm start                       # dev
npm run build:linux             # → dist/folia-browser-1.0.0.x86_64.rpm
npm run build:mac               # → dist/Folia Browser-1.0.0-mac.zip   (run on a Mac)
```

## Credit

Widevine DRM via [Castlabs Electron for Content Security](https://github.com/castlabs/electron-releases) (their `+wvcus` build).

## License

MIT.
