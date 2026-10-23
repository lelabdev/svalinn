# Zen integration and disposable smoke test

Svalinn protects Pinned and Essential tabs inside Zen Browser. This document
covers the privileged integration: how a script reaches Zen's browser chrome,
how a disposable profile is used, how close/unpin removal is blocked, and how
cross-zone drag and drop is duplicated without touching a daily profile or the
Zen installation.

> Status: **close/unpin/remove protection, cross-zone duplication,
> lifecycle-safe close-affordance/menu hiding, and explicit per-tab unpin /
> Remove-from-Essentials actions are implemented and smoke-tested.** Normal tabs,
> unloading, browsing, browser quit, and session restore stay native.
> Multi-selection, cross-window moves, folders, and split views remain out of scope
> for drag and drop.

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

## Why Marionette chrome context

Several mechanisms can run code near Zen's tab UI. The requirement for issue #1
is the least invasive mechanism that is still privileged enough to map real tabs
and, later, intercept removal paths.

| Mechanism | Can inspect/deny tab removal? | Writes outside a disposable profile? |
| --- | --- | --- |
| Zen Mods | No — CSS only | No |
| `userChrome.css` | No — presentation only | No |
| userChromeJS / autoconfig (`config.js`) | Yes | **Yes — installation directory** |
| WebExtension | Not reliably; privileged `experiments` need signing | Depends on install method |
| **Marionette chrome context** | **Yes** | **No** |

Marionette is built into Gecko and is enabled per process with `--marionette`.
Chrome-context scripts need Gecko's explicit system-access flag:

```text
zen-browser --profile <test-profile> --marionette -remote-allow-system-access --no-remote
```

The smoke harness starts Zen with those flags, verifies the Marionette session's
`moz:profile` matches the disposable profile, and only then switches to chrome
context. Nothing is patched in `/opt/zen-browser-bin`, no files are added to
`~/.zen`, and nothing persists after the process exits.

### Alternatives rejected

- **Installation-directory autoconfig:** works, but violates the "no patches to
  `/opt/zen-browser-bin`" acceptance criterion and makes upgrades harder.
- **Unsigned privileged WebExtension:** cannot reliably intercept every close,
  unpin, keyboard, and drag path; signing and research APIs are not suitable for
  a disposable test.
- **Manual Browser Toolbox:** repeatable only by hand, not scriptable for CI.

## Run the smoke test

```bash
npm run zen:smoke
```

What happens:

1. A profile is created with `mkdtemp()` under the system temp directory, with
   `userChrome.css` copied into its `chrome/` directory.
2. Zen launches with Marionette, a unique profile, and `--no-remote`.
3. The harness verifies `moz:profile` before executing any chrome script.
4. Before install, protected-tab CSS is verified to be inert (no active marker).
5. The adapter bundle is evaluated in the chrome context.
6. One normal, one Pinned, and one Essential tab are created through Zen's own
   APIs.
7. The adapter maps the tabs back to `normal` / `pinned` / `essential`.
8. Synthetic drops verify all four cross-zone transitions create exactly one
   copy, keep the source protected, and select the copy.
9. Same-zone reordering and normal-tab drops are checked to stay native.
10. Duplication failure and a protected `about:config` tab are checked to leave
    the source intact.
11. Close, close-current, mixed multi-close, unpin, Remove from Essentials, and
    Zen's close shortcut are checked against protected and normal tabs.
12. Unloading a protected tab is checked to remain available.
13. Close-button CSS, folder-contained tabs, and context-menu restrictions are
    checked; Zen's native hidden/disabled menu state must remain unchanged.
14. Intentional Unpin and Remove-from-Essentials commands are executed for
    Pinned, Essential, and folder tabs; other protected tabs, close, and drag
    authorization remain blocked afterward.
15. Install, re-install, uninstall, and disabled mode are checked against a tab
    fingerprint to prove tabs were not changed.
16. Uninstall removes the active marker, menu style and guards so native close
    affordances return.
17. A second window is opened to verify the `domwindowopened` observer, close
    guard, menu style, and drop hook attach without touching tabs.
18. Zen restarts on the same profile and the original tabs must restore with
    their zones intact, with both guards reattached.
19. Zen shuts down, and the temporary profile is removed.

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
```

The profile is rejected if it is `~/.zen` or inside it. If the requested
Marionette port is already used by another Zen, the `moz:profile` check aborts
the run before any privileged script executes.

## Close affordances, menus and intentional removal

Issue #4 hides accidental close affordances, prevents destructive menu commands
from appearing actionable, and provides explicit per-tab commands for intentional
unpin/removal. There is no global unlock mode, padlock icon, toolbar button, or
timed authorization.

### Close affordance CSS

`userChrome.css` hides the close button/overlay for Pinned and Essential tabs
only inside a window with the `svalinn-active` marker:

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

## Cross-zone duplication

Issue #2 makes a protected tab a permanent shortcut. Dragging a Pinned or
Essential tab into another category creates one copy in the destination and
leaves the source in place.

| Source | Target | Result |
| --- | --- | --- |
| Essential | Normal | Duplicate as Normal; source stays Essential |
| Essential | Pinned | Duplicate as Pinned; source stays Essential |
| Pinned | Normal | Duplicate as Normal; source stays Pinned |
| Pinned | Essential | Duplicate as Essential; source stays Pinned |
| Essential / Pinned | Same category | Native reorder |
| Normal | Any category | Native behavior |

How it works:

1. On install, Svalinn replaces `gBrowser.tabContainer.tabDragAndDrop.handle_drop`
   for each browser window with a guarded wrapper.
2. A wrapper is only engaged for a same-window, single-tab `move` drop where the
   source is protected and the target section is a different zone.
3. The native drop handler is skipped, so Zen never calls `removeEssentials` or
   `gBrowser.unpinTab` on the protected source.
4. The tab is duplicated, then its zone is applied **after** the
   `SSTabRestored` event. This is important: duplicated tabs are restored
   asynchronously and can overwrite an early category change. A nonempty tab id
   is deliberately not treated as proof of restoration.
5. Pending duplication operations are tracked per window. `uninstall()`,
   `setEnabled(false)`, and window detach cancel the restore listener/timer and
   remove any not-yet-finalized copy without touching the source.
6. The copy is positioned and selected. If duplication, category application, or
   restore fails or times out, the copy is removed and the source is left
   untouched.
7. If a protected same-window single-tab drop has an unknown target or a
   planning error, the drop is consumed and the source is preserved. Zen's
   native demotion handler is not called.
8. Same-zone reordering, normal tabs, multi-selected tabs, and cross-window drags
   fall through to Zen's native handler.

The guard is restored on `Svalinn.uninstall()` or when the browser exits.
Multi-selection, cross-window moves, folders, split views, and group labels are
intentionally left native for follow-up work.

## Install and uninstall model

There is intentionally no persistent installation for this phase.

- **Install:** run the smoke command. The adapter is evaluated in the running
  browser's chrome context and attaches a non-enumerable `__svalinn` marker to
  each browser window. `Svalinn.install({ enabled: true })` waits for Zen
  startup, validates capabilities, then attaches every window, installs the close
  and drop guards, and observes new windows.
- **Uninstall:** `Svalinn.uninstall()` restores the native close, unpin,
  Essential-removal, and drop entry points, removes the marker, and removes the
  window observer. Quitting Zen removes everything else; the disposable profile
  can be deleted. There is no prior state to restore in Zen's installation
  directory or daily profile.

The adapter is disabled by default (`svalinn.enabled` defaults to `false`) and
the smoke test passes `enabled: true` explicitly. A disabled call returns
`{ status: "disabled" }` and attaches nothing. The intentional-removal UX is
deferred, so uninstall/disable remains only a development lifecycle control, not
a documented user workflow.

### In-browser API

```js
Svalinn.probe({ allowUnverifiedVersion: false });
// { ok, isZen, appName, version, versionStatus, missing, tabShape }

await Svalinn.install({ enabled: true, waitForStartup: true, timeoutMs: 30000 });
// { status: "installed" | "unsupported" | "disabled" | "not-ready" | "already-installed", ... }

Svalinn.snapshot();
// { adapter, installed, enabled, warnings, pending,
//   windows: [{ ready, hasManager, hooked, closeHooked, tabCount, tabs }] }

Svalinn.hookedWindows(); // number of windows with the drop guard installed
Svalinn.closeGuardedWindows(); // number of windows with close/demotion guards
Svalinn.pendingDuplications(); // restore operations waiting for SSTabRestored
Svalinn.uninstall(); // { status: "uninstalled", changedTabs: false }
Svalinn.classify(tab); // { zone: "essential" | "pinned" | "normal", ... }
```

`install()` returns `unsupported` with a `missing` list when Zen renames or
removes any internal. Nothing is attached in that case, so a partial or
destructive hook cannot exist. Version verification accepts the `1.23.x` line;
`allowUnverifiedVersion: true` is available only for deliberate experiments on a
newer build.

## Security implications

Chrome-context execution with `-remote-allow-system-access` is equivalent to
running arbitrary code with the browser's full privileges: it can read cookies,
credentials, session data, and every profile file. Treat it as a temporary
debugging backdoor.

Rules for this repository:

- Never launch it with `~/.zen` or any profile containing real data.
- Never keep a Zen process running with `--marionette
  -remote-allow-system-access` after testing.
- Never expose the Marionette port beyond loopback.
- Keep the harness's profile verification; it is what prevents accidentally
  driving the daily browser when the port is already in use.
- Do not add auto-start hooks, systemd units, or profile-level injection in this
  phase.
- The smoke pages are local `file://` documents; no network access is needed.

If the harness is interrupted, stop the spawned browser and delete the
disposable profile:

```bash
pgrep -af 'zen-browser.*svalinn-zen-'   # inspect first
pkill -f 'zen-browser.*svalinn-zen-'
rm -rf /tmp/svalinn-zen-*
```

No rollback is required in Zen itself because neither the installation directory
nor the daily profile was modified.

## Tests

```bash
npm test
npm run check
npm run zen:smoke
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
  multi-window snapshots and observer attachment, cross-zone duplication,
  native reordering, event-driven lazy SessionStore restoration (including a
  nonempty-id false signal), restore timeout, unknown and throwing targets,
  planning errors, uninstall cancellation, duplication failures, Essential
  rejection, and no source-tab mutation
- injection bundling, CSS marker scoping, and Marionette framing/error handling

`npm run zen:smoke` is the integration check against a real Zen process. It
covers startup, pre-install CSS being inert, capability probing, install/uninstall,
close/unpin/removal guards, mixed multi-close, Zen's close shortcut, unloading,
CSS close-button visibility, folder-contained tabs, locked context-menu
restrictions without mutating Zen's native hidden state, intentional unpin and
Remove-from-Essentials commands (including folder tabs and authorization
cleanup), CSS/guards restored after uninstall, all four cross-zone transitions,
same-zone and normal-tab dragging, deletion-safe failure paths, `about:config`
duplication, an unknown-target negative control, delayed-restore cancellation by
uninstall, reinstall after cancellation, multi-window attachment,
restart/session restore, and shutdown. It is not part of `npm test` because it
launches a browser.

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
  synchronous native call, cleared in `finally`; there is no timer, global unlock,
  or persistent state. Failed, cancelled, and repeated calls leave no
  authorization.
- **Normal-tab controls remain native.** Normal tabs keep their close X, menu
  items, middle click, and `Ctrl+W`; the Svalinn commands are hidden.
- **CSS is not the security boundary.** Behavioral guards block close/unpin/
  removal even if a theme re-shows the X; CSS limits are documented.
- **Folder and layout coverage.** Folder-contained Pinned tabs are covered by the
  selectors and tests; close hiding was verified in compact/expanded and
  light/dark combinations in a windowed Zen profile.
- **Disposable profile only.** The harness creates an isolated profile, verifies
  `moz:profile`, and never edits `/opt/zen-browser-bin` or `~/.zen`.

## Known limitations

- The adapter is a development/smoke harness, not a user-facing installation
  method. A future issue must choose and document a supported deployment path.
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
- Multi-selected tabs are filtered for close, but cross-zone duplication is
  limited to a single tab in one window. Cross-window drags, folders, and split
  views stay native.
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
