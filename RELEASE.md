# Releasing Folia Browser

A reusable runbook for cutting a release. The repo syncs between the Linux box
and the Mac over Syncthing; **the Mac is the release machine** because
electron-builder can build every target there (Linux + Windows too) but cannot
build macOS `.dmg` from Linux.

Everything below assumes the version has already been bumped and committed
(done on whichever machine prepped the change). Confirm the version first:

```bash
cd electron-app
node -p "require('./package.json').version"   # e.g. 2.3.0 — this is what ships
```

If it still needs bumping, edit `version` in `electron-app/package.json`, then
`npm install --package-lock-only` to sync `package-lock.json`, and commit both.

---

## 1. Prep the Mac checkout

Syncthing copies `node_modules/` over, including the **Linux** Electron binary.
Re-running install swaps in the macOS one and rebuilds native deps for darwin:

```bash
cd electron-app
npm install
```

Sanity check the Electron version (should match `package.json`'s
`castlabs/electron-releases#vXX.Y.Z+wvcus`):

```bash
node -p "require('electron/package.json').version"   # e.g. 43.0.0+wvcus
```

The `electron` dep is **Castlabs ECS** (Widevine). If `npm install` ever refuses
to update it after a version bump, delete `package-lock.json` and
`node_modules/electron`, then `npm install` again — npm caches the git ref and
won't otherwise re-resolve the commit.

---

## 2. Build the installers

```bash
cd electron-app
npm run build:mac      # → dist/Folia Browser-<ver>.dmg
npm run build:linux    # → dist/folia-browser-<ver>.x86_64.rpm + folia-browser_<ver>_amd64.deb
npm run build:win      # → dist/Folia Browser Setup <ver>.exe   (NSIS)
```

Build them separately (not `npm run build`) so a failure on one target is easy
to spot. All artifacts land in `electron-app/dist/`.

Notes:
- macOS builds are **unsigned** (`mac.identity: null` in `package.json`), so
  Gatekeeper will warn on first launch — right-click → Open, or
  `xattr -dr com.apple.quarantine "/Applications/Folia Browser.app"`. Fine for
  personal distribution; revisit if you ever get an Apple Developer ID.
- electron-builder pulls Electron from the Castlabs mirror
  (`electronDownload` in `package.json`). First build downloads ~120 MB/target.

---

## 3. Publish ONE GitHub release with all assets

The hand-rolled updater (`electron-app/updater.js`) reads
`api.github.com/repos/lhdharris/folia-browser/releases` and serves **each OS the
matching asset from a single release**. So one release must carry all four
installers, or users on the missing platforms won't get the update.

```bash
cd electron-app
VER=$(node -p "require('./package.json').version")
gh release create "v$VER" \
  "dist/Folia Browser-$VER.dmg" \
  "dist/folia-browser-$VER.x86_64.rpm" \
  "dist/folia-browser_${VER}_amd64.deb" \
  "dist/Folia Browser Setup $VER.exe" \
  --repo lhdharris/folia-browser \
  --title "Folia Browser $VER" \
  --notes "See commit history for changes."
```

Rules the updater depends on:
- **Tag** is `vX.Y.Z` (a leading `v` is fine; the comparator strips it).
- **Stable releases must NOT be marked prerelease.** Stable users (no `-` in
  their version) are never offered a prerelease. Only tag+mark `prerelease` for
  actual betas like `v2.4.0-beta.1` (add `--prerelease` above).
- **Asset filenames are electron-builder's defaults** and already match what the
  updater expects — don't rename them:
  - `Folia Browser-<ver>.dmg`
  - `folia-browser-<ver>.x86_64.rpm`
  - `folia-browser_<ver>_amd64.deb`
  - `Folia Browser Setup <ver>.exe`

---

## 4. Verify

- On GitHub, the release shows all four assets and is **not** flagged Pre-release
  (for a stable cut).
- An older installed Folia should offer the update within its next check (at
  launch, then every 4 hours). To test immediately, install the previous version,
  launch it, and confirm the update dialog appears.
