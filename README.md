# Svalinn

**Tab Guardian for Zen Browser** — protect Essentials and Pinned tabs against accidental removal.

## Intended behavior

| Operation | Locked behavior |
| --- | --- |
| Close an Essential or Pinned (X, middle click, Ctrl+W, context menu) | Block |
| Remove from Essentials / Unpin | Block |
| Drag protected tab to another category | Duplicate into target; preserve original |
| Drag protected tab to another window | Duplicate; preserve original |
| Reorder within its own category | Allow |
| Unload protected tab | Allow |
| Explicit temporary unlock | Allow intentional removal and movement |
| Normal tabs | Keep Zen's native behavior |

## Current status

**Close/unpin/removal protection, cross-zone duplication, and lifecycle-safe close-affordance/menu hiding implemented and smoke-tested.**

- `src/policy.mjs`: dependency-free, testable protection rules.
- `tests/`: policy regression tests plus adapter, capability, close-guard,
  drop-guard, CSS-scope, bundling, and protocol tests. Run with `npm test`.
- `src/zen/`: privileged adapter with close/demotion and cross-zone drop guards,
  lifecycle-scoped close-affordance CSS and context-menu restrictions, plus a
  Marionette smoke harness.
- `userChrome.css`: hides the close X/overlay for protected tabs only while the
  adapter is successfully installed (`:root[svalinn-active]`). CSS is not the
  security boundary.
- `assets/icon.svg`: earlier provisional icon, not yet approved as final.

Observed on **Zen 1.23.4b** (TufTux, Arch Linux): `ZenPinnedTabManager.mjs` includes `removeEssentials`, `addToEssentials`, `onCloseTabShortcut`, and `moveToAnotherTabContainerIfNecessary`. Dragging a Pinned to normal invokes `gBrowser.unpinTab`.

Zen Mods are CSS-only. A true guard requires a privileged integration with browser chrome. With Svalinn enabled:

- Close button, middle click, `Ctrl+W`, context-menu close, close-other/selected,
  unpin, and Remove from Essentials are blocked for protected tabs.
- Mixed multi-close still closes normal tabs and keeps protected tabs.
- Normal tabs, unloading, browser quit, window close, and session restore stay
  native.
- Close X/overlay are hidden while active; destructive context-menu entries are
  visually blocked without changing Zen's native menu state. Uninstall/disable
  removes the marker and restores native affordances.
- Intentional close/unpin removal UX is deliberately deferred by issue #4; there
  is no unlock command, timer, or demotion bypass in this phase.
- Cross-zone drag and drop duplicates for a single tab in one window:

| Source | Target | Result |
| --- | --- | --- |
| Essential | Normal / Pinned | Duplicate into target; keep Essential |
| Pinned | Normal / Essential | Duplicate into target; keep Pinned |
| Protected | Same category | Native reorder |
| Normal | Any category | Native behavior |

The smoke harness validates these paths in a disposable profile:

```bash
npm run zen:smoke
```

It launches an isolated profile with `userChrome.css`, verifies pre-install CSS is
inert, normal/Pinned/Essential mapping, close/unpin/removal guards, mixed
multi-close, the Zen close shortcut, unloading, CSS close-button visibility,
folder-contained tabs, context-menu restrictions that preserve Zen's native
state, uninstall restoring native affordances, all four duplication transitions,
same-zone and normal-tab behavior, failure safety, uninstall during a pending
restore, restart/session restore, then deletes the profile. It never patches
`/opt/zen-browser-bin` and never uses `~/.zen`. See
[`docs/zen-integration.md`](docs/zen-integration.md) for the mechanism, manual
smoke matrix, security model, and rollback steps.


## Potential upstream contribution to Zen Browser

Svalinn is developed **specifically for Zen Browser** and is useful as a standalone
personal customization. A longer-term possibility is to contribute the behavior
**natively to Zen**, so users would not need a privileged mod. **This is only a
proposal:** no upstream PR has been opened and the Zen maintainers have not
accepted the feature.

Proposed approach:

1. Keep implementing and validating the behavior in
   [lelabdev/svalinn](https://github.com/lelabdev/svalinn), starting with
   copy-on-drop: dragging a Pinned or Essential outside its category creates a
   copy in the destination while the original stays in place.
2. Present the idea in [Zen Browser GitHub Discussions](https://github.com/zen-browser/desktop/discussions)
   **before submitting a feature PR**, as recommended in Zen's README.
   Suggest an **opt-in setting disabled by default** so existing users keep the
   current drag-and-drop behavior.
3. If maintainers are interested, fork
   [zen-browser/desktop](https://github.com/zen-browser/desktop), develop from
   the upstream `dev` branch, follow
   [Zen's contribution guidelines](https://github.com/zen-browser/desktop/blob/dev/docs/contribute.md),
   and open a focused, tested PR for native integration.
4. Continue maintaining Svalinn as a separate prototype/personal tool unless
   and until native support is accepted and shipped. An upstream PR is **not**
   the same as an accepted or released feature.

Related upstream discussion: [zen-browser/desktop#11278 —
“Tabs and essentials easy to accidentally drag off”](https://github.com/zen-browser/desktop/issues/11278).
The issue is **closed** after the original drag sensitivity problem was reported
resolved. A “Lock Essentials” option was discussed there, but Svalinn's
**copy-on-drop** design is a distinct proposed behavior.


## Next tasks

1. Decide and implement the minimal intentional unpin/Remove-from-Essentials interaction (#4), without adding a permanent button or a broad bypass.
2. Choose and document a maintainable deployment path for the adapter (the smoke harness is not a user installation), then test in a disposable Zen profile and verify Zen update compatibility before enabling in the main profile.
3. Extend pre-move duplication to multi-selected, cross-window, folder, tab-group and split-view cases.

**Safety:** do not patch `/opt/zen-browser-bin` or enable experimental scripts in the daily profile during development.
