# Svalinn

[![CI](https://github.com/lelabdev/svalinn/actions/workflows/ci.yml/badge.svg)](https://github.com/lelabdev/svalinn/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Tab Guardian for Zen Browser** — keep your Pinned and Essential tabs safe from accidental closing and unwanted removal. Svalinn is free and open source under the [MIT License](LICENSE).

## What works today

Svalinn is **already functional** as a persistent personal customization of [Zen Browser](https://zen-browser.app/), not just a proposed feature. The installer and browser integration have been exercised with **Zen 1.23.4b** in disposable profiles and copied installations.

| Action | Current protected behavior (Locked default) |
| --- | --- |
| Close a Pinned or Essential tab (close button, middle-click, `Ctrl+W`, menus) | Block accidental closure |
| Unpin / Remove from Essentials | Block by default; explicit per-tab context-menu commands authorize a deliberate action |
| Drag a protected tab out of its category or window | Block unsafe moves and preserve the source tab |
| Reorder within the same protected category | Allow native Zen reordering |
| Duplicate across categories | Optional `protectedDragBehavior=duplicate` for tested single-tab transitions; otherwise block safely |
| Global **Protect Pinned & Essentials** checkbox | Checked = Locked (default). Unchecked = Unlocked: native Zen close, unpin, removal, drag and detach behavior for all Pinned and Essential tabs |
| Unload a tab, restart Zen, quit the browser | Preserve normal behavior |
| Ordinary tabs | Preserve native Zen behavior |

Right-click any Pinned or Essential tab and use the single global **Protect Pinned & Essentials** checkbox. Unchecking it temporarily suspends Svalinn's guards and restores native Zen behavior without moving, closing, unpinning or recreating any tab. Re-checking restores protection immediately in every window. The choice is persisted across normal restarts; a fresh profile starts Locked. This is one browser-wide toggle, not a per-tab mode, and `protectedDragBehavior` remains a separate low-level preference.

The implementation covers multi-selection, folders, workspaces, containers, split views and cross-window cases by either preserving safe native behavior or blocking unsupported destructive transitions. Some physical drag gestures and UI variations still require manual verification; see [the real-Zen checklist](docs/manual-zen-checklist.md).

**Important:** Svalinn is currently a **privileged browser customization**, **not** a regular Firefox WebExtension, a CSS-only Zen Mod, or an official Zen feature. It installs a small autoconfig bootloader in the Zen installation directory plus a profile-local loader. Normal browsing requires **no Marionette or debugging port**. It is not yet distributed as a tagged installable release.

## Try it on a disposable Zen copy

Requires **Node.js 22+** and a supported local Zen installation. This path does **not** modify your real Zen installation or daily profile.

```bash
git clone https://github.com/lelabdev/svalinn.git
cd svalinn
npm run check
npm run zen:installed-smoke -- --headless
```

The installed smoke suite copies Zen, installs Svalinn in a temporary profile, exercises the protected-tab behavior, checks no-Marionette startup and restart/session restore, and checks startup with Svalinn disabled.

## Install for personal use

**Close Zen first.** For a typical Linux installation at `/opt/zen-browser-bin` and a profile stored under `~/.zen`, after testing the disposable installation:

```bash
# Back up the complete daily profile container yourself first.
cp -a "$HOME/.zen" "$HOME/.zen.backup-before-svalinn"

# Installation-root changes commonly need administrator permissions.
sudo -E env "PATH=$PATH" node src/zen/install.mjs \
  --profile "$HOME/.zen" \
  --install-root /opt/zen-browser-bin \
  --confirm-daily
```

The installer resolves `~/.zen/profiles.ini` to the actual default **leaf profile**, rejecting ambiguous selections. It creates versioned backups and automatically restores previous files if installation fails. The explicit `--confirm-daily` flag protects daily profiles from accidental changes. **Never launch Zen itself with sudo.**

Restart Zen normally. In `about:config`, `svalinn.status` should read `installed`.

Right-click a Pinned or Essential tab to find the **Protect Pinned & Essentials** checkbox. It is checked (Locked) by default; uncheck it to restore native Zen close/unpin/removal/drag behavior for protected tabs, then check it again to re-enable the guards.

### Status, rollback and uninstall

Run these from the Svalinn repository after **closing Zen** (change the installation root/profile if yours differ):

```bash
# Inspect installation status.
node src/zen/install.mjs --profile "$HOME/.zen" \
  --install-root /opt/zen-browser-bin --command status --confirm-daily

# Restore the latest Svalinn backup.
sudo -E env "PATH=$PATH" node src/zen/install.mjs \
  --profile "$HOME/.zen" --install-root /opt/zen-browser-bin \
  --command rollback --confirm-daily

# Remove Svalinn without deleting tabs or session data.
sudo -E env "PATH=$PATH" node src/zen/install.mjs \
  --profile "$HOME/.zen" --install-root /opt/zen-browser-bin \
  --command uninstall --confirm-daily
```

See [persistent installation, update, enable/disable, safety and troubleshooting](docs/persistent-install.md) for the complete instructions, permission model and multi-profile behavior. Installation modifies shared files in Zen's installation directory: carefully review conflicts with other privileged autoconfig loaders (including Sine). Unverified Zen versions are refused by default.

## Development and verification

```bash
npm test                         # Node policy/adapter and installer tests
npm run check                    # Syntax checks plus the full Node suite
npm run zen:smoke -- --headless   # Disposable profile with injected adapter
npm run zen:installed-smoke      # Real loader in a copied Zen installation
npm run zen:manual               # Manual real-Zen verification environment
```

GitHub Actions runs the Node checks on Node 22 and 24. Browser smoke tests require a local Zen executable and are not part of hosted CI. The policy, adapter, installer and safety regressions are covered in `tests/`; see [integration details](docs/zen-integration.md).

## What comes next

The working protection, personal installation and global Locked / Unlocked toggle are complete. Remaining improvements are tracked separately:

1. [#21 — Native Zen contribution](https://github.com/lelabdev/svalinn/issues/21): investigate a focused upstream PR against `zen-browser/desktop`. No upstream acceptance or integration is claimed. See the [native contribution research plan](docs/upstream-native-plan.md) for the mapped call sites, proposed prefs/defaults and test plan.
2. [#7 — Optional standalone release](https://github.com/lelabdev/svalinn/issues/7): decide whether a downloadable package is useful alongside a native contribution. [#8 — Logo](https://github.com/lelabdev/svalinn/issues/8) is deferred branding, not a release blocker.

A related community request is [Zen Browser discussion #7050 — Idea on Pinned Tabs Functionality](https://github.com/zen-browser/desktop/discussions/7050).

## License and Zen Browser integration

Svalinn is released under the [MIT License](LICENSE). You may use, modify and redistribute it provided the copyright and permission notice are preserved; the MIT badge at the top links to the same license file.

[Zen Browser](https://github.com/zen-browser/desktop) is a separately developed upstream project licensed under [MPL-2.0](https://github.com/zen-browser/desktop/blob/dev/LICENSE). Zen's source files, assets and trademarks retain their own terms. Svalinn's MIT license does **not** relicense Zen Browser or any bundled third-party material. If future work introduces non-original assets or code, their notices must be inventoried and retained separately.

Svalinn currently works as a **privileged, independent Zen customization**, installed through a small autoconfig bootloader. It is not an official Zen feature, a standard WebExtension, or a tagged standalone release. See [persistent installation, rollback and security warnings](docs/persistent-install.md) before installing it.

A native contribution is only under research in [#21](https://github.com/lelabdev/svalinn/issues/21); the related community request is [Zen Discussion #7050](https://github.com/zen-browser/desktop/discussions/7050). No upstream pull request has been created, and no Zen maintainer endorsement, acceptance or shipped native integration is claimed. Only describe the feature as integrated after Zen accepts and ships it.

Any future native port would be submitted under Zen's contribution requirements. MIT-licensed Svalinn code can be proposed for use in the MPL-2.0 project, but the actual upstream implementation, its license headers, attribution and review follow Zen's rules.
