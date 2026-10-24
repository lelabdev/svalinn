# Persistent personal installation

Svalinn can be installed persistently for personal use in Zen Browser without
starting Marionette, Remote Agent, or any debugging port during normal browsing.

This is intentionally a **personal, local installation**, not a published
extension or a Sine mod. Public distribution is out of scope for this phase.

## What gets installed

Svalinn uses Zen's built-in autoconfig support (the same class of mechanism used
by `userChromeJS` loaders and Sine's bootloader), but it is self-contained and
does not depend on Sine.

| Location | Files |
| --- | --- |
| Zen installation root | `svalinn.cfg`, `defaults/pref/svalinn-autoconfig.js` |
| Profile | `chrome/svalinn/chrome.manifest`, `chrome/svalinn/content/loader.sys.mjs`, `chrome/svalinn/content/adapter.js`, `chrome/svalinn/version.json` |
| Profile | a managed block in `chrome/userChrome.css` and in `user.js` |

`defaults/pref/svalinn-autoconfig.js` enables autoconfig and selects
`svalinn.cfg`. That file registers the profile-local chrome manifest and imports
`chrome://svalinn/content/loader.sys.mjs`.

The loader waits until the first browser window is ready, loads the unchanged
adapter into a chrome window, and calls the normal `Svalinn.install()` path. No
network access is used at runtime.

### Why not a normal WebExtension?

A normal profile WebExtension is sandboxed and cannot reliably intercept all of
`gBrowser.removeTab`, `unpinTab`, `removeEssentials`, context-menu commands, and
drag/drop paths.

A WebExtension using `experiment_apis` was tested in a disposable profile on Zen
1.23.4b. It can load as an unsigned sideloaded add-on, but Gecko marks it
unprivileged: `experiment_apis` are only available to signed/builtin/privileged
add-ons, or to **temporary** add-ons when experiments are enabled. Temporary
add-ons do not survive a restart, so that path cannot satisfy persistent
installation.

The autoconfig bootstrap is therefore the smallest mechanism that is both
persistent and privileged enough for the existing adapter. It requires writing
two small files into the Zen installation directory. That change is explicit,
backed up, and removable.

## Requirements

- Zen 1.23.x, matching the verified adapter/capability line.
- Write permission to the Zen installation root for installation, update,
  rollback, and uninstall.
- Write permission to the target profile.
- Node.js 22 or newer for the installer and tests.

The installer refuses an unverified Zen version unless
`--allow-unverified-version` is passed. The loader also sets
`svalinn.status=unsupported` and attaches nothing if the adapter's runtime
capability probe fails. This is the non-destructive fallback: when internals
change, Svalinn does not partially hook the browser.

## Test in a disposable installation first

Copy the installation, use a disposable profile, and run the installed smoke
suite. The copy keeps `/opt` and `~/.zen` untouched.

```bash
cp -a /opt/zen-browser-bin /tmp/opencode/zen-copy
node src/zen/installed-smoke.mjs \
  --install-root /tmp/opencode/zen-copy \
  --headless
```

`zen:installed-smoke` without `--install-root` makes its own temporary copy from
`/opt/zen-browser-bin`. It:

1. installs the bootloader and profile assets into temporary locations;
2. starts the copied Zen **without Marionette** and verifies
   `svalinn.status=installed`;
3. runs the normal full smoke suite against the persistently loaded adapter;
4. verifies restart/session restore while the loader starts the adapter again;
5. runs one more no-Marionette startup with `svalinn.enabled=false` and verifies
   `svalinn.status=disabled` with zero guarded windows;
6. removes the temporary installation copy and disposable profile unless asked
   to keep them.

The `--headed` variant runs the same checks in a visible window. `--keep` keeps
the copied installation for inspection; `--profile` keeps a generated disposable
profile.

## Install for personal use

First close Zen completely. Then run the installer with an explicit profile.
The installer does not launch Zen and does not edit session/tab data.

```bash
# Report current installation state.
node src/zen/install.mjs \
  --profile /path/to/profile \
  --install-root /opt/zen-browser-bin \
  --command status

# Install or update.
node src/zen/install.mjs \
  --profile /path/to/profile \
  --install-root /opt/zen-browser-bin
```

For the normal Zen profile, add `--confirm-daily`. This guard is deliberately
required even for explicit paths; test with a disposable profile first.

```bash
node src/zen/install.mjs \
  --profile "$HOME/.zen" \
  --install-root /opt/zen-browser-bin \
  --confirm-daily
```

If the installation root is not writable by your user, run the installer with
`sudo` while preserving the invoking user so profile files are handed back to
that user:

```bash
sudo -E env "PATH=$PATH" node src/zen/install.mjs \
  --profile "$HOME/.zen" \
  --install-root /opt/zen-browser-bin \
  --confirm-daily
```

The installer uses `SUDO_UID`/`SUDO_GID` to restore ownership of the profile
files and backups. Installation-root files remain owned by the installation
owner, which is appropriate. Do not run a browser as root.

### Enable, disable, and drag mode

The managed `user.js` block contains:

```js
user_pref("svalinn.enabled", true);
user_pref("svalinn.protectedDragBehavior", "block");
user_pref("toolkit.legacyUserProfileCustomizations.stylesheets", true);
```

`chrome/userChrome.css` also receives a marker-delimited Svalinn block. Existing
user CSS outside the markers is preserved on install/update/uninstall. The
stylesheet pref is required for Firefox/Zen to load `userChrome.css`; removing
the Svalinn block leaves any user CSS intact.

- Disable: reinstall with `--disabled`, then restart Zen.
- Enable: reinstall with `--enabled`, then restart Zen.
- Switch optional duplication: reinstall with `--drag-behavior duplicate`.
- Changes take effect on the next Zen start because the loader activates at
  startup; close Zen before changing files.

`block` is the default. `duplicate` retains the existing copy-on-drop behavior
for safe single-tab cross-category drops.

## Status, update, backup, rollback, uninstall

```bash
PROFILE="$HOME/.zen"
ROOT=/opt/zen-browser-bin

# File-level installation status. During a running session, runtime status is
# also written to prefs (see below).
node src/zen/install.mjs --profile "$PROFILE" --install-root "$ROOT" \
  --command status

# Update: creates a new timestamped backup and replaces the profile assets.
node src/zen/install.mjs --profile "$PROFILE" --install-root "$ROOT" \
  --command update --confirm-daily

# Restore the latest backup (or pass --backup <dir>).
node src/zen/install.mjs --profile "$PROFILE" --install-root "$ROOT" \
  --command rollback --confirm-daily

# Remove the bootloader, profile assets, and managed user.js block.
node src/zen/install.mjs --profile "$PROFILE" --install-root "$ROOT" \
  --command uninstall --confirm-daily
```

Backups are stored under `<profile>/svalinn-backup/<timestamp>/`, with a
`backup.json` manifest. They include the previous user.js, profile assets, and
installation-directory files. Rollback restores files that existed and deletes
files that Svalinn created. Uninstall deliberately does **not** delete the
backup directory, so rollback remains possible until you remove it.

The installer refuses to overwrite a different autoconfig loader by default. If
another `defaults/pref/*.js` file already sets `general.config.filename`,
remove it or use `--force` only after reviewing the conflict. Sine and Svalinn
are not claimed to coexist; both want to be the autoconfig entry point.

### Runtime status prefs

The loader writes these prefs, which are useful when diagnosing startup:

| Pref | Meaning |
| --- | --- |
| `svalinn.status` | `starting`, `installed`, `disabled`, `unsupported`, `not-ready`, or `error` |
| `svalinn.lastError` | Last loader error, empty when healthy |
| `svalinn.loaderVersion` | Profile loader version (`0.1.0`) |
| `svalinn.guardWindows` | Windows attached when installation completed |

`prefs.js` is normally flushed when Zen shuts down. You can also inspect the
status with `about:config` while Zen is running.

## Safety model

- Normal browsing uses no `--marionette`, no `--remote-allow-system-access`, and
  no open debugging port.
- Marionette is used only by the test harness on disposable profiles.
- The loader never edits tabs or session files. Installation writes only the
  files listed above.
- Installation/update is backed up first. The bootloader and profile assets are
  removable without touching browsing data.
- Unsupported Zen versions fail closed: the adapter reports `unsupported` and
  does not attach close/drop/detach hooks.
- If the loader or profile assets are missing, `userChrome.css` has no active
  marker and Zen's native controls return.
- Zen package updates may replace the installation root. Reinstall or update
  Svalinn afterwards; the profile assets and backups remain.
- Back up important profiles before installing unofficial startup hooks. The
  autoconfig file can execute privileged code at every browser start.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| No protection after restart | Run `--command status`; verify `svalinn.cfg` and `defaults/pref/svalinn-autoconfig.js` exist in the installation root. |
| `svalinn.status=unsupported` | Zen version or internals changed; do not force hooks. Test an updated Svalinn build. |
| `svalinn.status=error` | Read `svalinn.lastError`; check the copied profile and loader files. |
| Installer reports another autoconfig loader | Remove the other loader or review `--force`; do not stack autoconfig entry points. |
| Zen update removed protection | Re-run `--command update` or install; the package replaced the installation root. |
| Installer cannot write `/opt` | Close Zen and re-run with `sudo -E env "PATH=$PATH" ...`; verify profile ownership. |

## Sine

Sine was investigated as a reference for the autoconfig bootloader pattern. It
is a theme/mod manager that installs its own `config.js` entry point. Svalinn
does not depend on Sine, does not publish a Sine mod in this phase, and does not
claim Sine compatibility. Using the two autoconfig loaders together is not
supported without an explicit integration review.
