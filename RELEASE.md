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
npm run build:mac      # → dist/Folia Browser-<ver>.dmg (x64) + Folia Browser-<ver>-arm64.dmg
npm run build:linux    # → dist/folia-browser-<ver>.x86_64.rpm + folia-browser_<ver>_amd64.deb  (x64)
npm run build:win      # → dist/Folia Browser Setup <ver>.exe   (one NSIS installer, x64 + arm64)
```

Build them separately (not `npm run build`) so a failure on one target is easy
to spot. All artifacts land in `electron-app/dist/`.

### Architectures: arm64 + x64 where Castlabs ships both

The `build:*` scripts pin the arch flags on purpose — **never drop them.**
electron-builder defaults to the *host* arch, so on this Apple Silicon Mac a bare
`npm run build:linux`/`build:win` would try to package `arm64` and fail: Castlabs
publishes **no `linux-arm64` ECS build** (`…-linux-arm64.zip → 404`). What Castlabs
*does* publish for v43 decides what we can ship:

| Platform | x64 | arm64 | What we build |
|----------|-----|-------|---------------|
| macOS    | ✓   | ✓     | **two dmgs** — `--x64 --arm64` (see universal note below) |
| Windows  | ✓   | ✓     | **one multi-arch NSIS** `.exe` — `--x64 --arm64` bundles both, installer picks at run time |
| Linux    | ✓   | ✗     | **x64 only** — `--x64` (no arm64 Widevine binary exists) |

- **macOS can't be a universal binary.** `--mac dmg --universal` fails with
  *"Expected all non-binary files to have identical SHAs"* because Castlabs' per-arch
  Widevine signature (`Electron Framework.sig`) differs between the x64 and arm64
  frameworks. So macOS ships **two separate dmgs** instead: `Folia Browser-<ver>.dmg`
  (x64) and `Folia Browser-<ver>-arm64.dmg` (arm64 — electron-builder only tags the
  non-default arch in the filename).
- **Two dmgs means the updater must choose by arch.** `pickAsset` in `updater.js`
  (shipping since 2.3.0) is arch-aware: when more than one asset shares an extension
  it matches `process.arch` (arm64 → the `-arm64` dmg, x64 → the un-suffixed one),
  falling back to the other arch if only one was published. Single-asset formats
  (Linux deb/rpm, the one Windows exe) skip that path. So for anyone on **2.3.0 or
  newer, arch selection is automatic and upload order is irrelevant** — GitHub
  serves the `/releases` assets alphabetically anyway (`…-arm64.dmg` sorts before
  `….dmg`), which you can't control.
- **One-time transition caveat.** A Mac still on a *pre-2.3.0* Folia has the old
  extension-only updater that just grabs the first `.dmg` — which, per GitHub's
  alphabetical order, is the **arm64** one. On Apple Silicon that's correct; on an
  **Intel** Mac it's the wrong arch, so that (rare) user needs a **manual** x64
  download (`Folia Browser-<ver>.dmg`) once to get onto the arch-aware updater.
  Nothing to do at release time — just know it's a pre-2.3.0 legacy edge, not an
  ongoing problem.
- **Windows arm64 rides inside the one installer.** electron-builder's default NSIS
  packs both arches into a single `Setup` exe that installs the matching build — no
  second asset, so the updater's single-exe match still works.

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
matching asset from a single release**. So one release must carry every
installer (all five assets), or users on the missing platforms won't get the
update.

```bash
cd electron-app
VER=$(node -p "require('./package.json').version")
gh release create "v$VER" \
  "dist/Folia Browser-$VER.dmg" \
  "dist/Folia Browser-$VER-arm64.dmg" \
  "dist/folia-browser-$VER.x86_64.rpm" \
  "dist/folia-browser_${VER}_amd64.deb" \
  "dist/Folia Browser Setup $VER.exe" \
  --repo lhdharris/folia-browser \
  --title "Folia Browser $VER" \
  --notes "See commit history for changes."
```

(Upload order doesn't matter — GitHub serves release assets alphabetically, and
the 2.3.0+ updater picks the dmg by CPU arch regardless. See the arch note in
step 2 for the one-time pre-2.3.0 caveat.)

Rules the updater depends on:
- **Tag** is `vX.Y.Z` (a leading `v` is fine; the comparator strips it).
- **Stable releases must NOT be marked prerelease.** Stable users (no `-` in
  their version) are never offered a prerelease. Only tag+mark `prerelease` for
  actual betas like `v2.4.0-beta.1` (add `--prerelease` above).
- **Asset filenames are electron-builder's defaults** and already match what the
  updater expects — don't rename them:
  - `Folia Browser-<ver>.dmg`  (macOS **x64** — no arch suffix)
  - `Folia Browser-<ver>-arm64.dmg`  (macOS **arm64** — electron-builder appends
    `-arm64` only to the non-default arch)
  - `folia-browser-<ver>.x86_64.rpm`
  - `folia-browser_<ver>_amd64.deb`
  - `Folia Browser Setup <ver>.exe`  (Windows x64 + arm64 in one installer)
- GitHub rewrites spaces in uploaded asset names to dots
  (`Folia.Browser-<ver>.dmg`). Harmless — the updater matches on extension +
  the `arm64` token, both of which survive the rewrite.

---

## 4. Verify

- On GitHub, the release shows all five assets (two dmgs + rpm + deb + exe) and is **not** flagged Pre-release
  (for a stable cut).
- An older installed Folia should offer the update within its next check (at
  launch, then every 4 hours). To test immediately, install the previous version,
  launch it, and confirm the update dialog appears.
