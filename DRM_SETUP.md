# DRM (Widevine) setup

The app uses [Castlabs Electron-for-Content Security (ECS)](https://github.com/castlabs/electron-releases) — a Widevine-enabled fork of Electron — as its `electron` dependency. ECS is a drop-in replacement for stock Electron that adds Chromium's Component Updater Service to install the Widevine CDM automatically. It's pre-signed for development use, so no further signing is needed for personal builds.

> Vanilla Electron does not ship Widevine. The CDM extracted from Chrome won't register inside it (no integration code). ECS is the only viable path on every platform — Linux, macOS, Windows. There is no working "extract from Chrome" approach.

## Install

The dependency is already pinned in `electron-app/package.json`:

```json
"electron": "https://github.com/castlabs/electron-releases#v42.0.0+wvcus"
```

> Why v42: the [Castlabs supported-versions table](https://github.com/castlabs/electron-releases/wiki) shows the Widevine CDM is only served via Component Updater for the most recent ~year of Chromium releases. Older series (including 32) lose the CDM and report `No component available`. v42 (Chromium 148) is the latest supported.

Pulling it down:

```bash
cd <repo>/electron-app
rm -rf node_modules/electron node_modules/.package-lock.json
npm install
```

Expect a ~100 MB download from GitHub. `node_modules/electron/package.json` should show version `32.3.3+wvcus`.

## How the CDM gets there

`main.js` waits on `components.whenReady()` immediately after `app.whenReady()`. On first launch, that triggers Chromium's Component Updater to fetch the Widevine CDM from Google's CRX server and install it under `~/.config/folia-browser/Components/` (Linux) / `~/Library/Application Support/folia-browser/Components/` (macOS). Subsequent launches resolve immediately.

**Linux quirk:** Castlabs' docs note that on Linux, components installed for the first time require an app **restart** before they function (sandboxing). So:

1. `npm start` → terminal will pause briefly while the CDM installs → first window opens.
2. Quit the app.
3. `npm start` again → CDM is now active.

This restart is only needed once per machine.

## Verify

1. Open Settings → enable **Enable DRM (Widevine)**.
2. Navigate to <https://bitmovin.com/demos/drm>. Reload after the page loads.
3. Expected: **EME is supported by your current browser**, Widevine listed as detected, art-of-motion sample plays.

If EME still shows unsupported, drop a `console.log(components.status())` after the `await components.whenReady()` line in `main.js` — the entry for `components.WIDEVINE_CDM_ID` should report installed.

## Production signing (optional)

For a production AppImage distributed to others, Castlabs offers free EVS signing for stronger entitlements. The dev-signed binary is fine for personal use. See <https://github.com/castlabs/electron-releases/wiki/EVS> if you ever need it.

## Unrelated noise

Terminal warnings about SSL handshakes and `ERR_NAME_NOT_RESOLVED` for domains like `rt.marphezis.com`, `t.a3cloud.net` are tracker embeds blocked by the local DNS layer (Pi-hole / AdGuard). Not related to DRM.
