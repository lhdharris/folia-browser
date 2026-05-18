# Folia Browser 2.0.0 — Mac one-shot release

**Goal:** produce all five 2.0.0 installers (deb, rpm, dmg×2, exe) and publish
a single GitHub release from the Mac in one Claude session. Marked as a
**GitHub pre-release** initially so stable users don't auto-pull it; flip the
flag on github.com when you're confident.

Repo: <https://github.com/lhdharris/folia-browser>
Working tree: `~/Sync/coding_projects/tabless-browser` (adjust below if elsewhere).

---

## BEFORE LEAVING LINUX (do this manually before opening Claude on the Mac)

The Mac box only sees what's on `origin/dev`. Anything still uncommitted on
the Linux box won't ship.

```bash
# From the Linux box, in the repo root:
cd ~/Sync/coding_projects/tabless-browser
git status                                # confirm changes you want to ship
git switch dev
git add -A                                # or stage selectively
git commit -m "<your release-prep commit message>"
git push origin dev
```

Confirm `git log --oneline origin/dev | head -5` on Linux includes the commits
you expect to ship. Then close the laptop.

> **About the folia-browser-dev rename:** commit `cca6770` set the package
> name to `folia-browser-dev` for dev-userData isolation; a later commit
> on dev (`0591a05`) restored it to `folia-browser` ahead of this
> release. After the merge, `electron-app/package.json` will already have
> `"name": "folia-browser"` — no manual revert needed. (If you re-instate
> the dev rename later for further development, do it as a fresh commit
> on dev after the release tag.)

---

## ON THE MAC — instruction to Claude

Open Claude Code in this repo on the Mac and say:

> read RELEASE_MAC_BETA3 and do what it says

Everything below this line is the script Claude executes.

---

## Step 0 — Verify one-time prereqs

Run each of these; if any is missing, install per the comment and **stop and
ask the user before proceeding** (some of these are interactive).

```bash
xcode-select -p              # Xcode CLT path. If absent: xcode-select --install
node --version               # ≥ 18.  If absent: install via Homebrew (brew install node)
npm --version
gh --version                 # If absent: brew install gh
gh auth status               # Must show authenticated as lhdharris.
                             # If not: ask the user to run `gh auth login` interactively
                             # (Claude cannot complete the device-code flow non-interactively)
which wine || which wine64   # If absent: brew install --cask wine-stable
which rpmbuild               # If absent: brew install rpm
which dpkg                   # If absent: brew install dpkg
```

If `gh auth status` is not authenticated, do **not** proceed — surface a
message asking the user to run `gh auth login` in the terminal themselves
(via the `!gh auth login` prompt) and re-invoke the script after.

If Wine is freshly installed, run `wine --version` once interactively so it
seeds its prefix (`~/.wine`). On Apple Silicon, Wine builds Windows installers
under Rosetta — the build will be slow (~5–10 min) but works.

---

## Step 1 — Sync and merge dev → main

```bash
cd ~/Sync/coding_projects/tabless-browser    # adjust if the repo is elsewhere
git status                                   # must be clean. If not, stop and ask.
git fetch origin --tags --prune
git switch main
git pull --ff-only origin main
git merge --no-ff origin/dev -m "Merge dev for 2.0.0 release"
```

If the merge has conflicts: **stop and ask the user**. Don't auto-resolve.

---

## Step 2 — Bump version to 2.0.0

Confirm the package name is already correct (a dev-only commit had
renamed it for userData isolation, but a later dev commit restored it):

```bash
cd ~/Sync/coding_projects/tabless-browser
grep '"name"' electron-app/package.json       # must show "folia-browser" (NOT "folia-browser-dev")
```

If it still says `folia-browser-dev`, **stop and ask the user** — that
means the dev branch's restore-name commit didn't make it through and
shipping like this would break the auto-updater for existing installs.

Edit `electron-app/package.json`:
- Set `"version": "2.0.0"` (was `"2.0.0-beta.3"`)

Leave everything else as-is. Then:

```bash
cd ~/Sync/coding_projects/tabless-browser
git diff electron-app/package.json           # confirm: only version changed
git add electron-app/package.json
git commit -m "Folia Browser 2.0.0"
```

---

## Step 3 — Tag and push

```bash
git tag v2.0.0
git push origin main
git push origin v2.0.0
```

If `git push origin v2.0.0` fails because the tag already exists upstream:
**stop and ask the user** — never force-push a release tag.

---

## Step 4 — Build all five installers

```bash
cd electron-app
npm install
rm -rf dist

# macOS dmg, both architectures (x64 + arm64). On Apple Silicon, electron-builder
# defaults to the host arch only — pass both flags explicitly.
npx electron-builder --mac dmg --x64 --arm64

# Linux .deb + .rpm (x86_64). Uses the rpm + dpkg tools installed in step 0.
npm run build:linux

# Windows .exe via wine. Slowest step on Apple Silicon (Rosetta).
npm run build:win
```

If any build fails with a "version not found" or "404" error fetching
Electron, double-check `electronDownload.mirror` in `package.json` still
points at `https://github.com/castlabs/electron-releases/releases/download/`
— that's the only source for the `+wvcus` Widevine-enabled Electron.

If `build:win` fails specifically with a Wine error, surface the error and
ask the user — Wine on macOS is the flakiest piece. You can re-run just
`npm run build:win` without redoing the other targets.

---

## Step 5 — Verify dist contents

```bash
cd ~/Sync/coding_projects/tabless-browser/electron-app
ls -1 dist | grep -E '\.(dmg|deb|rpm|exe)$'
```

Expect exactly these five filenames (Linux .rpm naming uses `x86_64`, .deb
uses `amd64` — electron-builder defaults):

```
Folia Browser-2.0.0.dmg
Folia Browser-2.0.0-arm64.dmg
Folia Browser Setup 2.0.0.exe
folia-browser_2.0.0_amd64.deb
folia-browser-2.0.0.x86_64.rpm
```

If any are missing or named differently, **stop and ask the user** before
uploading — naming matters because `updater.js` selects assets by filename
extension and the existing auto-update logic expects these exact patterns.

---

## Step 6 — Create the GitHub release with all five assets

Single command, run from the repo root:

```bash
cd ~/Sync/coding_projects/tabless-browser
gh release create v2.0.0 \
  --title "Folia Browser 2.0.0" \
  --prerelease \
  --generate-notes \
  "electron-app/dist/Folia Browser-2.0.0.dmg" \
  "electron-app/dist/Folia Browser-2.0.0-arm64.dmg" \
  "electron-app/dist/Folia Browser Setup 2.0.0.exe" \
  "electron-app/dist/folia-browser_2.0.0_amd64.deb" \
  "electron-app/dist/folia-browser-2.0.0.x86_64.rpm"
```

`--generate-notes` builds the release body from commit messages between
`v2.0.0-beta.3` and `v2.0.0`. `--prerelease` keeps `updater.js`'s stable-user
filter from picking it up automatically — promote on github.com when you're
ready by editing the release and unchecking "Set as a pre-release".

---

## Step 7 — Sanity check after upload

```bash
gh release view v2.0.0 --json assets --jq '.assets[].name'
```

Expect all five filenames from Step 5. If the count is less, re-run a
targeted `gh release upload v2.0.0 "<path>"` for the missing one(s).

Then verify the release page loads in a browser and the assets are
downloadable: <https://github.com/lhdharris/folia-browser/releases/tag/v2.0.0>

---

## After-release housekeeping

After the release lands, **stop and hand back to the user** — don't touch
`dev` automatically. The dev branch deliberately carries the
`folia-browser-dev` rename for userData isolation, so syncing main → dev
would undo that. The user will decide how to reconcile (typically: cherry-
pick the rename back onto dev, or branch a fresh dev off main and re-apply
the rename).

You can delete this file as the final action on `main` if the user
confirms:

```bash
# Only if the user confirms:
git rm RELEASE_MAC_BETA3.md
git commit -m "Drop one-shot 2.0.0 release notes"
git push origin main
```

---

## Notes / gotchas

- Builds are unsigned. macOS Gatekeeper says "damaged" on first launch —
  `xattr -d com.apple.quarantine /Applications/Folia\ Browser.app` clears it.
  README documents this for end users.
- First launch installs the Widevine CDM via Castlabs ECS. Linux needs an
  app restart after that; macOS and Windows do not.
- `electronDownload.mirror` in `package.json` must keep pointing at Castlabs'
  GitHub release assets — that's where the `+wvcus` Electron tarballs live.
  Stock Electron mirrors don't have them and cross-builds will silently fail.
- The auto-updater (`updater.js`) reads the `/releases` list endpoint and
  applies SemVer comparison; tag must be `v2.0.0` (a leading `v` is fine,
  it's stripped before comparison). Don't tag as `2.0.0` without the `v` —
  electron-builder's defaults and the existing tags all use `v` prefix.
