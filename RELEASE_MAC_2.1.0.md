# Release Folia Browser 2.1.0 — Mac instructions

Walks the Mac through the full release: merge `dev` → `main`, bump version,
build `.dmg` + `.exe` + `.rpm` + `.deb`, publish a GitHub release. Five
new features on `dev` (per-commit log below) ship as **2.1.0** — minor
bump, no breaking changes.

After 2.1.0 is out, this file gets deleted (it's a one-shot doc, same
pattern as the prior `RELEASE_MAC_BETA3.md` cleanup).

## What's in 2.1.0

Commits on `dev` since `3ea4322` (2.0.0):

- **Stickies sit below OS chrome** — `setAlwaysOnTop` dropped from
  `'screen-saver'` to `'floating'` so stickies stop obscuring the macOS
  menu bar, Windows taskbar / notification area, and GNOME top bar.
- **Pre-fill sticky comment with selected page text** — selecting text
  then clicking the sticky button seeds the comment with the selection.
- **Per-window sticky position memory** — drag a sticky, maximize,
  re-sticky → it returns to the dragged spot. Cleared if you move the
  full-size window in between.
- **Previously closed Folias menu** — toolbar dropdown gains a fly-out
  listing the 20 most-recent closed windows; selecting one re-opens it
  with full back-button history intact.
- **Sticky titles use the page name** — `document.title` instead of
  "Visited host" / "Searched for 'query'" (the URL bar still uses the
  latter).

## Prerequisites

On the Mac, before starting:

```bash
node --version       # ≥ 18 ideally (electron 42 / electron-builder 26)
xcode-select -p      # any path is fine; if "not installed", run xcode-select --install
which wine || brew install --cask wine-stable    # needed for the Windows .exe build
gh auth status       # confirms you're logged into GitHub CLI as lhdharris
```

The Linux builds (`.rpm`, `.deb`) from a Mac host are technically supported by
electron-builder (it uses fpm under the hood and downloads Linux Electron
binaries from the Castlabs mirror). If the `.deb`/`.rpm` step fails, fall
back to building them on the Linux box from the same main-branch commit.

## Step 0 — Pull dev to the Mac

The Linux box pushed five feature commits to `origin/dev` on 2026-05-21.
Fetch them and verify locally:

```bash
cd ~/Sync/coding_projects/tabless-browser
git fetch origin
git checkout dev
git pull --ff-only
git log --oneline origin/main..dev
```

Expected tail of the log:

```
4cfc3d1 Sticky titles show the page name (document.title)
71f6c91 Previously closed Folias menu (with back-button history)
f62561d Per-window sticky position memory
b612592 Pre-fill sticky comment with selected page text
5687cb8 Stickies sit below OS chrome (menu bar, taskbar, tray)
a789546 Rename app to folia-browser-dev on dev branch
```

If the log doesn't match: **stop and ask** — something has diverged.

## Step 1 — Merge dev into main

```bash
git checkout main
git pull --ff-only
git merge --no-ff dev -m "Merge dev for 2.1.0 release"
```

`--no-ff` keeps the dev branch visible in the merge graph, matching the
2.0.0 release pattern (`f80d441`).

If the merge has conflicts: **stop and ask the user**. Don't auto-resolve.

## Step 2 — Release commit on main (rename revert + version bump + docs)

The merge brings in commit `a789546` which set the package name to
`folia-browser-dev` (for userData isolation on the Linux dev box).
Production builds **must** use `folia-browser` or the auto-updater (and
existing user installs) won't recognise the upgrade.

Edit `electron-app/package.json`:

```diff
-  "name": "folia-browser-dev",
-  "version": "2.0.0",
+  "name": "folia-browser",
+  "version": "2.1.0",
```

Update the README header (currently stale at `2.0.0-beta.2`):

```diff
-<p align="center"><strong>Beta — 2.0.0-beta.2.</strong> Folia is in public beta; expect rough edges and breaking changes between releases.</p>
+<p align="center"><strong>2.1.0.</strong> Stable; auto-updates from the GitHub releases feed.</p>
```

(If you prefer to keep the beta wording, swap in whatever you like — the
auto-updater doesn't read README.)

Update `CHANGELOG.md` — insert a new `## [2.1.0]` block above the existing
`## [2.0.0-beta.3]` entry:

```markdown
## [2.1.0] — 2026-05-21

Five sticky-note + window-management improvements.

- Stickies sit below the OS menu bar / taskbar / notification area
  instead of above. `alwaysOnTop` dropped from `screen-saver` to
  `floating` — stickies are desktop post-its, not always-on-top chrome.
- Selecting text on a page and then clicking the sticky button pre-fills
  the sticky comment with the selection.
- Stickies remember the spot the user last dragged them to: drag,
  maximize, re-sticky → returns to the dragged spot. Cleared the moment
  the user moves the full-size window.
- New "Previously closed Folias" submenu in the toolbar dropdown lists
  the 20 most-recent closed windows; re-opening one restores the full
  back-button history, not just the active page.
- Sticky titles show the page's `document.title` rather than the
  origin / search-query label the URL bar uses.
```

Commit:

```bash
git add electron-app/package.json README.md CHANGELOG.md
git commit -m "Folia Browser 2.1.0"
```

Confirm:

```bash
grep -A1 '"name"' electron-app/package.json | head -2
# expect:  "name": "folia-browser",
#          "version": "2.1.0",
```

If the name still says `folia-browser-dev` here: **stop**, the production
build won't update existing installs.

## Step 3 — npm install + sanity smoke

```bash
cd electron-app
npm install
npm start
```

The dev run will use `~/Library/Application Support/folia-browser/`
(production userData dir, since we just reverted the rename). If you've
got production Folia installed and don't want to touch its profile,
sanity-test by building first instead, then running the installer in a
disposable user account — but at minimum, confirm `npm start` boots
without errors and the toolbar menu shows "Previously closed Folias".

## Step 4 — Build all three platforms

Still in `electron-app/`:

```bash
npm run build:mac        # → dist/Folia Browser-2.1.0.dmg
npm run build:win        # → dist/Folia Browser Setup 2.1.0.exe
npm run build:linux      # → dist/folia-browser-2.1.0.x86_64.rpm
                         #   dist/folia-browser_2.1.0_amd64.deb
```

Each step downloads the Castlabs Electron binary for that target on first
run (cached after) and packages into `dist/`. Expect ~2–5 min per target.

**If `build:linux` fails on the Mac**: fall back to building it on the
Linux box. From the Linux box:

```bash
cd ~/Sync/coding_projects/tabless-browser
git fetch origin && git checkout main && git pull --ff-only
cd electron-app && npm install && npm run build:linux
# scp dist/folia-browser*.{rpm,deb} to the Mac, or upload from Linux directly
```

Verify all four artifacts exist before tagging:

```bash
ls -lh electron-app/dist/ | grep -E '2\.1\.0'
```

Expected: one `.dmg`, one `.exe`, one `.rpm`, one `.deb` — all dated today.

## Step 5 — Tag and push

```bash
cd ~/Sync/coding_projects/tabless-browser
git tag v2.1.0
git push origin main
git push origin v2.1.0
```

## Step 6 — Publish the GitHub release

```bash
cd electron-app
gh release create v2.1.0 \
  --title "Folia Browser 2.1.0" \
  --notes "$(cat <<'EOF'
Five sticky-note + window-management improvements.

- Stickies sit below the OS menu bar / taskbar / notification area
  instead of above.
- Selecting text on a page and clicking sticky pre-fills the sticky
  comment with the selection.
- Stickies remember the spot they were last dragged to and return
  there on the next shrink — cleared if you move the full-size window.
- New "Previously closed Folias" submenu in the toolbar dropdown lists
  recently-closed windows; re-opening one restores the full back-button
  history, not just the active page.
- Sticky titles show the page name (document.title) rather than the
  origin / search-query label the URL bar uses.

See [CHANGELOG.md](CHANGELOG.md) for details.
EOF
)" \
  "dist/Folia Browser-2.1.0.dmg" \
  "dist/Folia Browser Setup 2.1.0.exe" \
  "dist/folia-browser-2.1.0.x86_64.rpm" \
  "dist/folia-browser_2.1.0_amd64.deb"
```

Asset filenames must match electron-builder's defaults so the auto-updater
recognises them — the names above are exactly what electron-builder
produces. If you've changed any naming in `package.json`'s `build:`
section, list whatever's actually in `dist/`.

This is a **stable** release (not pre-release): the auto-updater treats
stable users (no `-` in version) and pre-release users differently — see
`electron-app/updater.js`'s channel rules. Stable users on 2.0.0 will be
offered 2.1.0 on the next check (every 4 hours, plus on launch).

## Step 7 — Verify the auto-updater picks it up

On the Mac with `Folia Browser-2.0.0.dmg` installed (or any existing
2.0.0 install on any platform):

1. Launch Folia.
2. Within ~30 seconds, the updater hits `api.github.com/.../releases?per_page=30`
   and (because `2.1.0 > 2.0.0` by SemVer) shows the native dialog
   "Folia Browser 2.1.0 is available."
3. Click **Download**. The download lands in
   `userData/updates/` (not the user's Downloads folder) and on completion
   prompts **Install now?**.
4. Accept → Folia quits and hands the installer to the OS handler
   (`open` on macOS, `xdg-open` on Linux, `spawn` on Windows).

If the dialog doesn't appear: check `electron-app/updater.js` console
output (View → Toggle DevTools on the main window — or just look at
stderr). The most common cause is an asset filename mismatch.

## Step 8 — Tear down this doc

Once the release is up and the auto-update has been verified:

```bash
git rm RELEASE_MAC_2.1.0.md
git commit -m "Drop one-shot 2.1.0 release notes"
git push origin main
```

Same one-shot-doc cleanup pattern as `6c6dee2` (`Drop one-shot 2.0.0
release notes`).

## Step 9 — Re-instate the dev rename (optional)

If you want to keep developing on `dev` from the Linux box without
clobbering production Folia's userData, the existing `a789546` rename
commit on dev still applies — but it'll be a no-op against post-release
main since main has the rename reverted. On the Linux box:

```bash
git checkout dev
git merge main                       # pull the release into dev
# package.json on dev now says "folia-browser" — re-apply the rename:
# edit electron-app/package.json to set "name": "folia-browser-dev"
git add electron-app/package.json
git commit -m "Rename app to folia-browser-dev on dev branch"
git push origin dev
```

This mirrors the cca6770/a789546 pattern from prior cycles.
