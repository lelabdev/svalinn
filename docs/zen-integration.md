# Zen integration and disposable smoke test

Svalinn protects Pinned and Essential tabs inside Zen Browser. This document
covers the privileged integration: how a script reaches Zen's browser chrome,
how a disposable profile is used, how close/unpin removal is blocked, and how
drag/drop preserves protected category membership (with optional duplication).

There are two execution paths:

- **Persistent personal installation:** a minimal autoconfig bootloader in a
  copied or real Zen installation loads a trusted profile loader at startup. No
  debug port is used. See
  [`persistent-install.md`](persistent-install.md).
- **Test harness:** Marionette chrome context on a disposable profile injects
  the same adapter. The installed smoke suite verifies that the persistent path
  behaves identically.

> Status: **close/unpin/remove protection, explicit per-tab unpin/removal,
> lifecycle-safe close/menu hiding, drag category protection, and persistent
> personal installation are implemented and smoke-tested.** Protected
> cross-category drags are blocked by default; duplication is an opt-in mode.
> Normal tabs, safe same-category reordering/folder moves, unloading, browsing,
> browser quit, and session restore stay native.

## Verified environment

| Item | Value |
| --- | --- |
| Zen | 1.23.4b (`zen-browser-bin 1.23.4b-1`) |
| Build ID | `20261020090730` |
| Gecko | Firefox 158-compatible |
| Host | Arch Linux / CachyOS, Wayland |
| Node | 22+ |
| Smoke result | PASS, windowed and `--headless` |

Zen internals observed in this build:

- `chrome/browser/content/browser/zen-components/ZenPinnedTabManager.mjs`
- `gZenPinnedTabManager` with `addToEssentials`, `removeEssentials`,
  `onCloseTabShortcut`
- Pinned tabs expose `tab.pinned === true`
- Essential tabs expose the `zen-essential` attribute
- Startup readiness via `gZenStartup.isReady` / `gZenStartup.promiseInitialized`
  and `SessionStore.promiseAllWindowsRestored`

## Execution mechanisms

Several mechanisms can run code near Zen's tab UI. Svalinn uses autoconfig for a
persistent personal install and Marionette only for disposable tests.

| Mechanism | Persistent? | Can intercept removal/drag? | Writes outside a disposable profile? |
| --- | --- | --- | --- |
| Zen Mods | Yes | No — CSS only | No |
| `userChrome.css` | Yes | No — presentation only | No |
| Profile unsigned WebExtension | Yes | No — sandboxed; privileged experiments need signing | Profile |
| **Autoconfig bootloader + profile loader** | **Yes** | **Yes** | **Two files in the installation root** |
| **Marionette chrome context** | No | **Yes** | **No** |

### Persistent path

The installer writes `svalinn.cfg` and
`defaults/pref/svalinn-autoconfig.js` into the Zen installation root. The
autoconfig file registers a profile-local `chrome.manifest` and imports
`chrome://svalinn/content/loader.sys.mjs`. The loader waits for browser startup
and installs the same adapter used by the tests. Install/update/backup/rollback/
uninstall and status are handled by `src/zen/install.mjs`.

This path has no Marionette flag, no Remote Agent, and no open debugging port
during normal browsing. It is a personal local installation, not a signed
extension or a public add-on. See
[`persistent-install.md`](persistent-install.md) for commands and safety.

### Test path

Marionette is built into Gecko and is enabled per process with `--marionette`.
Chrome-context scripts need Gecko's explicit system-access flag:

```text
zen-browser --profile <test-profile> --marionette -remote-allow-system-access --no-remote
```

The smoke harness starts Zen with those flags, verifies the Marionette session's
`moz:profile` matches the disposable profile, and only then switches to chrome
context. `zen:smoke` never patches `/opt/zen-browser-bin`. The installed smoke
suite uses a **copied** installation and starts it once without Marionette before
running the same checks.

### Why not a normal WebExtension?

An unsigned sideloaded extension using `experiment_apis` was tested in a
disposable Zen 1.23.4b profile. The extension loads, but Gecko marks it
unprivileged; experiment APIs require a signed/builtin/privileged add-on or a
temporary add-on. Temporary add-ons do not survive restart. Standard extensions
cannot reliably intercept all close, unpin, context-menu, and drag paths.

## Run the smoke test

```bash
npm run zen:smoke
```

This is the adapter-level, disposable test path:

1. A profile is created with `mkdtemp()` under the system temp directory, with
   `userChrome.css` copied into its `chrome/` directory.
2. Zen launches with Marionette, a unique profile, and `--no-remote`.
3. The harness verifies `moz:profile` before executing any chrome script.
4. Before install, protected-tab CSS is verified to be inert (no active marker).
5. The adapter bundle is evaluated in the chrome context.
6. One normal, one Pinned, and one Essential tab are created through Zen's own
   APIs.
7. The adapter maps the tabs back to `normal` / `pinned` / `essential`.
8. Default `block` mode verifies all four protected cross-zone transitions keep
   the source category with no copy; multi-selection, folder same-category, and
   cross-window paths are checked.
9. Same-zone reordering and normal-tab drops stay native.
10. `duplicate` mode verifies the four safe single-tab transitions create one
    copy, keep the source protected, and preserve container identity.
11. Duplication failure and a protected `about:config` tab leave the source
    intact.
12. Close, close-current, mixed multi-close, unpin, Remove from Essentials, and
    Zen's close shortcut are checked against protected and normal tabs.
13. Unloading a protected tab is checked to remain available.
14. Close-button CSS, folder-contained tabs, and context-menu restrictions are
    checked; Zen's native hidden/disabled menu state must remain unchanged.
15. Intentional Unpin and Remove-from-Essentials commands are executed for
    Pinned, Essential, and folder tabs; other protected tabs, close, and drag
    authorization remain blocked afterward.
16. Install, re-install, uninstall, and disabled mode are checked against a tab
    fingerprint to prove tabs were not changed.
17. Uninstall removes the active marker, menu style and guards so native close
    affordances return.
18. A second window is opened to verify the `domwindowopened` observer, close
    guard, menu style, and drop hook attach without touching tabs.
19. Zen restarts on the same profile and the original tabs must restore with
    their zones intact, with both guards reattached.
20. Zen shuts down, and the temporary profile is removed.

The persistent installed suite uses the same checks after installing the real
bootloader and profile loader in a copied installation:

```bash
npm run zen:installed-smoke                 # headless, temporary copy
npm run zen:installed-smoke -- --headed     # visible window
# --install-root names a SOURCE tree; the harness always copies it first.
node src/zen/installed-smoke.mjs --install-root /tmp/opencode/zen-copy
```

It starts Zen once without `--marionette` and requires
`svalinn.status=installed`, `svalinn.loaderVersion=0.1.0`, and at least one
guarded window, then runs the full suite through the loaded adapter. It also
reinstalls with `svalinn.enabled=false`, starts once more without Marionette, and
requires `svalinn.status=disabled` with zero guarded windows. The installation
copy keeps `/opt` and `~/.zen` untouched.

Useful flags:

```bash
# Print a machine-readable report
node src/zen/smoke.mjs --json

# Keep the generated profile for inspection
node src/zen/smoke.mjs --keep-profile

# Use a specific new/empty disposable directory (or a profile previously
# generated by this test); explicit profiles are kept for reuse
node src/zen/smoke.mjs --profile /tmp/svalinn-zen-manual

# Use a different Zen binary or port
node src/zen/smoke.mjs --zen /usr/bin/zen-browser --port 2828

# Run headless, or skip the restart phase
node src/zen/smoke.mjs --headless
node src/zen/smoke.mjs --skip-restart

# Test an installed copy; --install-root selects the source tree to copy.
# Skip the no-Marionette preflight only when needed.
node src/zen/installed-smoke.mjs --install-root /tmp/opencode/zen-copy \
  --skip-preflight
```

The profile is rejected if it is `~/.zen` or inside it. If the requested
Marionette port is already used by another Zen, the `moz:profile` check aborts
the run before any privileged script executes.

## Close affordances, menus and intentional removal

Issue #4 hides accidental close affordances, prevents destructive menu commands
from appearing actionable, and provides explicit per-tab commands for intentional
unpin/removal. There is no padlock icon, toolbar button, or timed authorization.
Global protection is controlled only by the explicit Locked / Unlocked checkbox
described in [Issue #20 acceptance](#issue-20-acceptance).

### Close affordance CSS

`userChrome.css` hides the close button/overlay for Pinned and Essential tabs
only inside a window with the `svalinn-active` marker that is also currently
locked (`:root[svalinn-active]:not([svalinn-unlocked])`):

```css
:root[svalinn-active] .tabbrowser-tab[pinned] .tab-close-button { ... }
```

The marker is set by the adapter **only after** every guard for that window has
installed successfully. It is removed on uninstall, disable, partial-install
rollback, and window detach. If the adapter is absent or failed, the CSS is inert
and Zen's native controls return. Normal tabs are never matched.

CSS is presentation only. It cannot block `Ctrl+W`, middle click, context menus,
drag/drop, or native removal; the privileged behavioral guard is the security
boundary. Zen Mods/themes that override tab-strip CSS may re-show the close
control, but closing remains blocked. The selectors cover ordinary, Pinned,
Essential, and folder-contained tabs; visual checks still need to be repeated in
light/dark themes and compact/expanded layouts.

Requires:

```text
toolkit.legacyUserProfileCustomizations.stylesheets = true
```

### Context menu and intentional actions

Zen owns the native `hidden`/`disabled` state of context-menu items. Svalinn does
not mutate it. While a protected tab's menu is open, the adapter marks destructive
native commands with a `svalinn-blocked` attribute; a small injected style hides
only those marked items:

- Close Tab
- Unpin Tab / Unpin Selected Tabs
- Remove from Essentials

On the next menu opening the marks are recomputed from the actual context tab, so
normal tabs, multi-selection, and Zen's own visibility decisions remain intact.
Uninstall removes the marks and the style element.

Svalinn adds two single-tab commands:

| Context tab | Svalinn command | Result |
| --- | --- | --- |
| Pinned (not Essential) | **Unpin This Pinned Tab** | Native unpin, tab remains open as Normal |
| Essential | **Remove This Tab from Essentials** | Native Essential removal, then native unpin to Normal |
| Normal | none | Native menu unchanged |
| Multi-selected | none | Native menu unchanged; protected tabs remain guarded |

Each command runs the native Zen operation under a **per-tab, per-action**
authorization held only for the duration of that synchronous call. Removing an
Essential authorizes both `remove-essential` and the nested `unpin` call for that
same tab. No other tab, close action, or drag operation is authorized. The
authorization is cleared in a `finally` block, including when the native call
throws or is a no-op, so protection is restored immediately afterward. Repeated
attempts after success see a normal tab and do nothing.

## Close and demotion protection

With the adapter installed, protected tabs cannot be closed or demoted through
the covered browser paths:

| Entry point | Guard |
| --- | --- |
| `gBrowser.removeTab` | Blocks a protected tab |
| `gBrowser.removeTabs` | Filters protected tabs; normal tabs still close |
| `gBrowser.removeCurrentTab` | Blocks when the selected tab is protected |
| `gBrowser.removeTabGroup` | Blocks a group containing a protected tab |
| `gBrowser.unpinTab` | Blocks Pinned and Essential tabs |
| `gZenPinnedTabManager.removeEssentials` | Blocks Essential removal, including context-menu calls |
| Zen `onCloseTabShortcut` | Its `close` path reaches the guarded `removeTab`; unload/switch/reset paths remain |

Covered gestures include the tab close button, middle click, `Ctrl+W`, context
menu close/unpin/remove, close-other/selected actions, and Zen close commands,
because they all reach these entry points.

Safety and lifecycle rules:

- Normal tabs are unaffected.
- Mixed multi-close removes normal tabs and keeps protected tabs.
- `Svalinn` authorizes only the duplicated copy's specific zone-change or cleanup
  call; there is no global guard bypass.
- Hooks stand down while Zen is starting/restoring, while the window is closing,
  or while the application is shutting down, so browser quit, window close,
  session restore, and updates are not trapped.
- Unloading/suspending is never intercepted.
- Disabling/uninstalling removes the hooks and native affordances return.
- Installing is all-or-nothing: both the close guard and drop guard must attach;
  the CSS active marker and menu style are applied only after success.

### Manual smoke matrix

Run `node src/zen/smoke.mjs --keep-profile` to inspect a disposable profile, or
perform the following by hand in a test profile:

| Gesture | Pinned | Essential | Normal |
| --- | --- | --- | --- |
| Close button | Stays open | Stays open | Closes |
| Middle click | Stays open | Stays open | Closes |
| `Ctrl+W` | Stays open | Stays open | Closes |
| Context menu → Close | Hidden/blocked | Hidden/blocked | Native |
| Context menu → Unpin | Hidden; use Svalinn command | Hidden/blocked | Native |
| Context menu → Remove from Essentials | — | Hidden; use Svalinn command | — |
| Svalinn → Unpin This Pinned Tab | Unpins once, source remains open | — | — |
| Svalinn → Remove This Tab from Essentials | — | Removes once to Normal | — |
| Unload / suspend | Allowed | Allowed | Allowed |
| Quit browser and restart | Restored | Restored | Native |
| Close browser window | Allowed | Allowed | Allowed |
| Disable integration, then close | Allowed | Allowed | Allowed |

Manual presentation checks: protected tabs show no close X while the adapter is
active; normal tabs look unchanged; Pinned tabs inside folders are covered. Repeat
in light/dark themes and compact/expanded layouts, then disable/uninstall and
confirm Zen's native close controls return.

The automated smoke test covers the API-level close/unpin/removal paths, the Zen
close shortcut, mixed multi-close, unloading, CSS close-button visibility,
folder-contained tabs, locked context-menu restrictions without mutating native
menu state, uninstall restoring native affordances, multi-window attachment,
restart/session restore, and shutdown.

## Drag category protection and optional duplication

Issue #5 protects **category membership and existence**, not tab position.
With the default `block` mode:

| Drag | Result |
| --- | --- |
| Reorder within Essentials or within Pinned | Native allow |
| Move between folders that stays in the same protected category | Native allow |
| Essential → Normal/Pinned, or Pinned → Normal/Essential | Block; source keeps category |
| Cross-window move of a protected tab | Block |
| Multi-selection containing a protected tab that would cross categories | Block whole drop; source tabs stay put |
| Workspace/container/group/split-view interaction with unclear category effect | Block when a protected tab is involved |
| Duplicate via Zen's native context menu | Allow; original unchanged |
| Normal tabs | Native Zen behavior |

The invariant is: while protected and locked, a drop can never silently close,
detach, unpin, remove Essential status, or turn the original into Normal. Safe
same-category organization is still allowed.

### Out-of-window detachment

Releasing a tab outside the window does not go through `handle_drop`; Firefox and
Zen reach `gBrowser.replaceTabsWithWindow` from `handle_dragend`. Svalinn wraps
that entry point per window and reuses the same protected-member resolver:

- protected Pinned/Essential tabs, group/folder labels containing protected
  members, split views, and mixed selections are blocked from detaching;
- native `handle_dragend` still executes for animation/visibility/drag-state
  cleanup;
- normal tabs are delegated to the original `replaceTabsWithWindow` and keep
  native new-window detachment;
- uninstall restores the original method.

A real-input xdotool run on Zen 1.23.4b verified dragging Pinned and Essential
tabs outside the window: no new window, source tab/window/category unchanged,
and `detach-blocked:protected-tab` recorded. Dragging a Normal tab out created a
new window and cleaned up normally.

### Optional duplicate mode

The merged copy-on-drop path from #2 is retained as an opt-in mode:

```text
svalinn.protectedDragBehavior = block   # default
svalinn.protectedDragBehavior = duplicate
```

It can also be set per install (`Svalinn.install({ dragBehavior: "duplicate" })`)
or for the current session with `Svalinn.setDragBehavior("duplicate")`.
`Svalinn.dragBehavior()` returns the active mode.

In `duplicate` mode, the four single-tab, same-window cross-category transitions
copy into the destination and keep the original. Duplication is only attempted
for that proven-safe shape; multi-selection, cross-window, workspace, group, and
split-view cases still fail closed. If duplication fails, the copy is removed and
the source is preserved.

How the guard works:

1. Svalinn wraps `gBrowser.tabContainer.tabDragAndDrop.handle_drop` in every
   browser window.
2. It canonicalizes the entire moving set: the primary source, every
   `movingTabs` entry, native tab-group labels, Zen folders, and split-view
   members. Unreadable/cyclic/unknown membership fails closed.
3. It resolves the target category, active/source/target workspace, container
   context, and split-view involvement before Zen mutates anything.
4. A protected drag is allowed natively only when it is a proven same-window,
   same-workspace, same-category, compatible-container, non-split organization
   change (reorder or safe folder move).
5. Non-protected drags fall through to native behavior.
6. Protected cross-category, cross-window, cross-workspace, container-incompatible
   Essentials, multi-tab/group, split-view, and unknown-target drops are consumed:
   native demotion/adoption is not called and the source remains in its original
   category/workspace/container.
7. Out-of-window detach is guarded separately: the per-window
   `gBrowser.replaceTabsWithWindow` entry point is wrapped so a protected tab,
   group label, split view, or mixed selection returns without migration. Zen's
   native `handle_dragend` still runs for cleanup/visuals; normal-tab detach
   delegates unchanged.
8. In duplicate mode, only a single protected tab crossing a category is copied.
   The destination zone is applied after `SSTabRestored`; a nonempty tab id is not
   proof of restoration. Pending copies are cancelled on uninstall/window detach,
   and failures remove the copy while keeping the source.

## Installation and lifecycle model

The persistent personal install has two layers:

1. **Bootloader:** `svalinn.cfg` and `defaults/pref/svalinn-autoconfig.js` in the
   Zen installation root register the profile chrome manifest and import the
   loader at startup.
2. **Loader:** `chrome://svalinn/content/loader.sys.mjs` waits for browser
   startup, loads the unchanged adapter into a chrome host window, and calls
   `Svalinn.install({ enabled: true, waitForStartup: true })`. It records
   `svalinn.status`, `svalinn.lastError`, `svalinn.loaderVersion`, and
   `svalinn.guardWindows` in prefs.
3. **Presentation pref:** the managed `user.js` block enables
   `toolkit.legacyUserProfileCustomizations.stylesheets`, and the installer adds
   a marker-delimited Svalinn block to `chrome/userChrome.css` so protected tabs
   hide their close controls. Existing user CSS is preserved.

The adapter remains the same code used by the tests. It attaches a
non-enumerable `__svalinn` marker to each browser window, installs the close and
drop guards, and observes new windows.

- **Enable/disable:** the managed `svalinn.enabled` pref (default `true` for a
  personal install). Disable with `--disabled` and restart; the loader marks
  itself disabled and attaches nothing.
- **Update:** the installer backs up and replaces the bootloader/profile assets.
- **Rollback:** restores the latest or selected backup, including the prior
  `user.js` and installation files.
- **Uninstall:** removes the bootloader, profile assets, and managed `user.js`
  block. It does not touch tabs/session data and keeps the backup directory.
- **Unsupported version/fallback:** the adapter's capability probe must pass. If
  it fails, `Svalinn.install()` returns `unsupported`, nothing is attached, and
  the loader writes the status/error prefs. CSS has no active marker.
- **Normal shutdown/restart:** the loader starts again from autoconfig; the
  installed smoke suite verifies session restore and both guards reattaching.

The full command reference, backup layout, sudo ownership handling, and
troubleshooting live in [`persistent-install.md`](persistent-install.md).

### In-browser API

```js
Svalinn.probe({ allowUnverifiedVersion: false });
// { ok, isZen, appName, version, versionStatus, missing, tabShape }

await Svalinn.install({ enabled: true, waitForStartup: true, timeoutMs: 30000 });
// { status: "installed" | "unsupported" | "disabled" | "not-ready" | "already-installed", ... }
// optional: dragBehavior: "block" | "duplicate"

Svalinn.snapshot();
// { adapter, installed, enabled, dragBehavior, warnings, pending,
//   windows: [{ ready, hasManager, hooked, closeHooked, tabCount, tabs }] }

Svalinn.hookedWindows(); // number of windows with the drop guard installed
Svalinn.closeGuardedWindows(); // number of windows with close/demotion guards
Svalinn.pendingDuplications(); // restore operations waiting for SSTabRestored
Svalinn.setDragBehavior("block" | "duplicate"); // session-scoped
Svalinn.dragBehavior(); // active drag mode
Svalinn.uninstall(); // { status: "uninstalled", changedTabs: false }
Svalinn.classify(tab); // { zone: "essential" | "pinned" | "normal", ... }
```

`install()` returns `unsupported` with a `missing` list when Zen renames or
removes any internal. Nothing is attached in that case, so a partial or
destructive hook cannot exist. Version verification accepts the `1.23.x` line;
`allowUnverifiedVersion: true` is available only for deliberate experiments on a
newer build.

## Security implications

The persistent loader is privileged code that runs at every Zen start. Treat the
installation root and profile chrome files as trusted code:

- Review installer changes and keep backups.
- Do not install while Zen is running.
- Do not run Zen as root.
- Do not use `--force` to stack autoconfig loaders without understanding which
  file wins.
- Keep `svalinn.enabled` disabled when you do not need protection; the profile
  files can remain installed but inert.
- The normal browsing path does **not** open a Marionette/Remote Agent port.
- The test path still uses `--marionette -remote-allow-system-access`; it is
  equivalent to arbitrary code execution with the browser's full privileges.
  Use only disposable profiles and stop the process after testing.

Rules for the test harness:

- Never launch `zen:smoke` with `~/.zen` or a profile containing real data.
- Never keep a Zen process running with `--marionette
  -remote-allow-system-access` after testing.
- Never expose the Marionette port beyond loopback.
- Keep the harness's `moz:profile` verification; it prevents driving the wrong
  browser when the port is already in use.
- The installed smoke suite uses a copied installation and does not touch
  `/opt/zen-browser-bin` or `~/.zen`.

If the harness is interrupted, stop the spawned browser and delete the
disposable profile:

```bash
pgrep -af 'zen-browser.*svalinn-zen-'   # inspect first
pkill -f 'zen-browser.*svalinn-zen-'
rm -rf /tmp/svalinn-zen-*
```

No rollback is required for the test harness because neither the installation
directory nor the daily profile was modified. The persistent installer has its
own backups and rollback commands; see
[`persistent-install.md`](persistent-install.md).

## Tests

```bash
npm test
npm run check
npm run zen:smoke
npm run zen:installed-smoke
```

`npm test` covers:

- version parsing and the verified release line
- capability probing, including non-Zen, renamed methods, hostile globals, and
  unverified versions
- adapter behaviour in a VM: close/unpin/remove-essentials guards, explicit
  per-tab unpin/Remove-from-Essentials authorization (including nested
  `removeEssentials → unpinTab`), failed-action cleanup, repeated attempts,
  mixed multi-close filtering, group close blocking, unload passthrough,
  shutdown/startup/window-close bypasses, active-marker lifecycle on
  install/uninstall/failed install, native context-menu hidden-state preservation,
  opt-in/disabled mode, idempotent install, clean uninstall, startup timeouts,
  multi-window snapshots and observer attachment, default drag blocking,
  optional duplication mode, multi-selection/cross-window/group fail-closed
  behavior, source/destination workspace and container provenance, group-label
  expansion (including normal-origin labels), split-view source/target handling,
  out-of-window detachment blocking for tab/group/split/mixed sources and native
  normal-tab detachment, unreadable group membership, same-zone native reorder,
  event-driven lazy
  SessionStore restoration (including a nonempty-id false signal), restore
  timeout, unknown and throwing targets, planning errors, uninstall cancellation,
  duplication failures, Essential rejection, and no source-tab mutation
- global Locked/Unlocked menu semantics, native close/unpin/drop/detach while
  unlocked, relock propagation, multi-window/new-window synchronization, pending
  duplication cancellation, preference-write failure, and restart persistence
- injection bundling, CSS marker scoping, and Marionette framing/error handling
- installer `user.js` merge/remove idempotence, install-root validation,
  autoconfig conflict detection, backup/install/status/uninstall on temporary
  fixtures, version refusal/override, and rollback restoration
- profile-container resolution (unique/default/ambiguous leaf selection),
  cross-profile shared-bootloader ownership and stale-registry retention,
  foreign root-file refusal, rollback identity/path/hash/duplicate validation,
  transactional install/update failure recovery, and installed-smoke copy
  isolation/live-root refusal

### CI and manual coverage

GitHub Actions (`.github/workflows/ci.yml`) runs `npm test` and `npm run check`
on Node 22 and 24 for every pull request and every push to `main`. A failing
policy, adapter, syntax, or bundling test fails the workflow. Browser smoke and
manual gesture checks are intentionally outside CI because they require a real
Zen binary and display.

A disposable-profile manual checklist lives in
[`manual-zen-checklist.md`](manual-zen-checklist.md). Start it with:

```bash
npm run zen:manual -- --keep-profile
```

The launcher canonicalizes the intended profile path (including symlinked
ancestors and missing final targets), refuses the real `~/.zen` before any write,
creates a temporary profile, copies `userChrome.css`, verifies `moz:profile`,
installs the adapter for that session only, and requires `status === "installed"`
with active drop/close hooks before printing the checklist. It exits nonzero on
startup/capability/install/hook failures. It never patches
`/opt/zen-browser-bin` and never edits the daily profile.

`npm run zen:smoke` is the integration check against a real Zen process. It
covers startup, pre-install CSS being inert, capability probing, install/uninstall,
close/unpin/removal guards, mixed multi-close, Zen's close shortcut, unloading,
CSS close-button visibility, folder-contained tabs, locked context-menu
restrictions without mutating Zen's native hidden state, intentional unpin and
Remove-from-Essentials commands (including folder tabs and authorization
cleanup), default block behavior for all four cross-category transitions,
multi-selection/folder/cross-window drag safety, two real workspaces, a
non-default container workspace, container-specific Essentials incompatibility,
group-label moves with before/after membership snapshots, split-view
source/target drops with group-membership invariants, a real multi-selected
same-category reorder using Zen's selection state, folder-to-folder membership
through the native drop handler, protected and normal out-of-window dragend
detachment checks, optional duplicate mode with non-default
container identity, duplication failure/internal pages, same-zone and normal-tab
dragging, deletion-safe failure paths, an unknown-target negative control,
delayed-restore cancellation by uninstall, reinstall after cancellation,
multi-window attachment, restart/session restore, and shutdown. It is not part of
`npm test` because it launches a browser.

`npm run zen:installed-smoke` is the persistent-install integration check. It
always copies the Zen installation source (`--zen-root` or `--install-root`),
installs the autoconfig bootloader and profile loader into the temporary copy,
verifies startup **without Marionette**, then runs the same full suite through the
loaded adapter, including restart and session restore. It never touches
`/opt/zen-browser-bin` or `~/.zen`; the direct smoke harness refuses to install
into a live root or a symlink alias to it.

A separate **real-input UI matrix** was run against a windowed Zen 1.23.4b test
profile using xdotool (X11/XWayland), not direct API calls:

- close X on Normal works; close X absent on Pinned/Essential;
- middle click and `Ctrl+W` close Normal but leave Pinned/Essential;
- protected context menus hide native Close/Unpin/Remove and show the matching
  Svalinn command;
- clicking **Unpin This Pinned Tab** and **Remove This Tab from Essentials**
  performs exactly that action, and protection is active again afterward;
- unload from the real menu leaves the protected tab open;
- close-button hiding holds in compact/expanded layouts and light/dark themes;
- screenshots were captured for each layout/theme combination.

## Issue #4 acceptance

- **Protected tabs show no close X and no actionable destructive menu entries.**
  CSS is scoped to `:root[svalinn-active]`; native Close/Unpin/Remove menu items
  are hidden with `svalinn-blocked` marks while protected.
- **Intentional removal is possible.** Right-click a Pinned tab for **Unpin This
  Pinned Tab**, or an Essential for **Remove This Tab from Essentials**. Each
  executes the native Zen action for that single tab only.
- **Protection returns automatically.** Authorization is held only for the
  synchronous native call, cleared in `finally`; there is no timer or persistent
  per-tab state. Failed, cancelled, and repeated calls leave no authorization.
- **Normal-tab controls remain native.** Normal tabs keep their close X, menu
  items, middle click, and `Ctrl+W`; the Svalinn commands are hidden.
- **CSS is not the security boundary.** Behavioral guards block close/unpin/
  removal even if a theme re-shows the X; CSS limits are documented.
- **Folder and layout coverage.** Folder-contained Pinned tabs are covered by the
  selectors and tests; close hiding was verified in compact/expanded and
  light/dark combinations in a windowed Zen profile.
- **Disposable profile only.** The harness creates an isolated profile, verifies
  `moz:profile`, and never edits `/opt/zen-browser-bin` or `~/.zen`.

## Issue #5 acceptance

- **Protected category survives every covered drag.** Cross-category,
  cross-window, multi-tab, group/split-view, and unknown-target drops are blocked
  before Zen demotes/adopts; source tabs remain in their original category.
- **Safe organization remains native.** Same-category reordering, multi-selection
  reordering within a category, and folder moves that stay in the same protected
  category are delegated to Zen.
- **Default cross-category drag is blocked.** No copy, no phantom/partial move,
  no source category change.
- **Optional duplicate mode preserves the original.** It is opt-in
  (`svalinn.protectedDragBehavior = duplicate` or `setDragBehavior`); only the
  proven single-tab/same-window transitions copy, and failures remove the copy.
- **Unsupported paths fail closed.** Cross-window, workspace/container/group/
  split-view, unknown-target, and multi-tab protected category changes do not
  reach native demotion/adoption. Source and destination workspace/container
  provenance is checked before delegation.
- **Non-protected tabs keep native behavior.**
- **Out-of-window detachment is blocked for protected sources.** The
  `replaceTabsWithWindow` path reached from native `handle_dragend` is guarded for
  tabs, group labels, split views, and mixed selections; native dragend cleanup
  still runs, and normal-tab detachment remains native.
- **Coverage.** Automated adapter tests and the real Zen smoke suite exercise
  block mode, duplicate mode, safe same-zone/folder moves, multi-selection,
  cross-window, two real workspaces, non-default container tabs,
  container-specific Essentials, group labels, split-view source/target with
  membership snapshots, folder-to-folder membership through the native drop
  handler, out-of-window detachment blocking/invariants, failure cleanup, close
  guards, restart, and shutdown.

## Issue #6 acceptance

- **Automated PR CI.** `.github/workflows/ci.yml` runs `npm test` and
  `npm run check` for every pull request and every push to `main` on Node 22 and
  24; failures fail the workflow.
- **Policy and adapter regression coverage.** The policy matrix covers all tab
  types, actions, lock states, drop zones/windows and unsupported targets.
  Adapter tests cover copy failures at null/move/category stages, restore timeout,
  authorization cleanup, reinstall defaults, and prove the original tab is never
  removed or recategorized.
- **No live-profile dependency.** Node tests use VM/fakes and temporary filesystem
  fixtures only. The smoke and manual launchers resolve real symlink destinations
  and reject `~/.zen` before any write, verify `moz:profile`, and use temp
  profiles.
- **Manual checkout fails closed.** `npm run zen:manual` requires a ready Zen
  session, `status === "installed"`, at least one attached window, and active
  drop/close hooks before printing the checklist. Startup/capability/version/hook
  failures exit nonzero with the reported reason.
- **Manual checklist.** `docs/manual-zen-checklist.md` gives visible expected
  outcomes for close X, middle click, `Ctrl+W`, context menus, drag/drop,
  unloading, restart/session restore, workspaces/containers, multi-window,
  themes/layouts, and rollback.
- **Remaining unautomated cases.** The checklist explicitly lists physical OS
  drag-out for group/split/mixed sources, visual theme/Zen Mods combinations, and
  workspace switching mid-drag as not fully automated. Persistent installation is
  covered by `zen:installed-smoke` and the installer tests added for issue #12.
- **Version prerequisites.** Zen 1.23.4b and Node 22+ are stated in the checklist
  and integration documentation; newer Zen versions fail capability/version
  checks until revalidated.

## Issue #20 acceptance

- **Exactly two global states.** One native checkbox item, **Protect Pinned &
  Essentials**, on the Pinned/Essential tab context menu. Checked = Locked
  (default); unchecked = Unlocked. There is no third mode and no per-tab toggle.
- **Locked preserves #3–#5.** Close/Ctrl+W/middle-click, unpin, Essential removal,
  cross-zone moves and detach are blocked; same-zone reorder, supported folder
  organization, unload and shutdown remain native. `protectedDragBehavior` stays a
  separate low-level preference.
- **Unlocked restores native Zen.** The drop, detach and close/unpin/removal guards
  delegate to Zen, Svalinn's intentional per-tab entries are hidden, and the menu's
  native commands lose their `svalinn-blocked` marks. Normal tabs are native in
  both states. Toggling changes no tab, zone, or session data.
- **Atomic and synchronized.** `Services.prefs.setBoolPref("svalinn.locked", …)` is
  written first; every open window is then updated. A failed write or window sync
  reverts both the pref and all windows. New windows created while unlocked attach
  with the same state, and each `popupshowing` refreshes the checkbox.
- **Persistence and safe default.** `svalinn.locked` defaults to `true` when
  absent, so a fresh install is Locked. An explicit toggle survives normal restarts
  because it is stored in `prefs.js`, not in the managed `user.js` block.
  Unsupported or disabled installs expose no lock control and claim no state.
- **Cleanup.** The checkbox and separator are removed on uninstall, and window
  detach removes the `svalinn-unlocked` marker. Repeated install/uninstall cycles
  do not duplicate menu items or listeners.
- **Verification.** Unit/VM tests cover menu semantics, native close/unpin/drop/
  detach when unlocked, relock, multi-window and new-window synchronization,
  pending duplication cancellation, pref-write failure, and persistence. Real Zen
  smoke covers Locked → Unlocked → Locked, menu indication, native actions,
  multiple windows, and restart persistence in injected and persistent installs.



## Issue #12 acceptance

- **Persistent personal install.** Minimal autoconfig bootloader plus profile
  loader; no public extension/Sine publication. Full install/update/backup/
  rollback/uninstall/status commands are documented in
  [`persistent-install.md`](persistent-install.md).
- **No debugging port in normal browsing.** The loader starts from autoconfig;
  `zen:installed-smoke` verifies a successful startup without `--marionette`
  before running the full suite.
- **Restart and session restore.** Installed smoke restarts the same profile and
  verifies tab zones, guards, and the loaded adapter after restart.
- **Enable/disable and fallback.** `--disabled` writes the managed pref and
  `--enabled` restores it; changes apply on restart. The adapter fails closed
  (`unsupported`/`not-ready`) and attaches no hooks if Zen internals change.
- **Non-destructive install.** Complete backups are written before any target is
  modified; profile assets are staged first and the shared bootloader is activated
  last, with automatic restore on failure. Rollback validates destination identity,
  allowed paths, and content hashes before writing. Uninstall leaves browsing data
  alone, retains the shared bootloader while another profile is registered, and
  refuses to remove uncertain ownership. Conflicting autoconfig loaders or foreign
  files are refused unless explicitly forced.
- **Version guard.** `application.ini` must be a verified 1.23.x line before
  installation unless `--allow-unverified-version` is explicitly used.
- **Test isolation.** Installer tests use temporary fake Zen roots/profiles.
  Installed smoke copies the installation and uses a disposable profile; real
  `/opt` and `~/.zen` are not touched.
- **Scope.** Public release/distribution remains out of scope (#7); Sine
  compatibility is not claimed.

## Known limitations

- The persistent personal installation is a local autoconfig bootstrap, not a
  signed/public extension. Zen updates can replace installation-root files, so
  reinstall/update after a browser update. Public distribution and Sine integration
  remain separate decisions.
- This is not a hardened security boundary against malicious code already running
  with chrome privileges; it prevents accidental user gestures, not a compromised
  browser.
- Intentional unpin/Remove-from-Essentials commands are single-tab only. A mixed
  multi-selection hides them; `Unpin Selected Tabs` is also hidden when the
  selection contains a protected tab, avoiding partial native failure.
- CSS hiding is presentation only and can be overridden by Zen Mods or themes;
  the behavioral guard remains authoritative. The active marker ensures the CSS
  is inert when the adapter is absent, disabled, uninstalled, or failed to
  install.
- The context-menu style only adds `svalinn-blocked` display restrictions; Zen's
  native `hidden`/`disabled` state is not modified.
- Intentional command labels are English-only for now.
- Guards cover the tabbrowser close/unpin/Essential-removal entry points. Tab
  groups containing a protected tab are blocked entirely rather than partially
  closed.
- Default drag behavior is `block`. Optional `duplicate` mode only copies a
  single protected tab in the same window; cross-window, group/split-view,
  workspace, and multi-tab transitions still fail closed.
- Protected tabs cannot be detached out of the window; normal tabs still use native new-window detachment.
- Same-category delegation requires matching source/destination workspace and,
  for Essentials, container context; split-view or ambiguous group membership
  blocks instead of moving.
- Folder-to-folder acceptance uses a synthetic drop prepared with Zen's
  collapsed-folder drop state; it goes through the native drop handler and
  asserts membership, identity, container/workspace and tab count without direct
  repair calls.
- When a multi-selection includes a protected tab crossing categories, the whole
  drop is blocked. Normal tabs in that selection stay open but do not move.
- Independent per-category enable/disable for Essentials vs Pinned is not exposed
  yet; both are protected.
- Duplication waits for the SessionStore `SSTabRestored` event (bounded to 10
  seconds). If restoration does not complete, the copy is removed and the source
  is kept. Uninstalling cancels pending restoration work and removes unfinished
  copies.
- Protected drops with an unknown target or an unsafe planning result are
  consumed rather than delegated to Zen's native demotion path.
- The copy preserves the current URL and container, but not full back/forward
  history.
- The smoke test creates local `file://` tabs; session restore is verified for
  that shape only.
- A future Zen release may change internal APIs. The expected outcome is a clean
  `unsupported` report with no installation, followed by an intentional adapter
  update and re-run of the smoke test.
