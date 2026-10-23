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

**Close/unpin/removal protection and cross-zone duplication implemented and smoke-tested.**

- `src/policy.mjs`: dependency-free, testable protection rules.
- `tests/`: policy regression tests plus adapter, capability, close-guard,
  drop-guard, bundling, and protocol tests. Run with `npm test`.
- `src/zen/`: privileged adapter with close/demotion and cross-zone drop guards,
  plus a Marionette smoke harness.
- `userChrome.css`: visual draft; **does not protect against keyboard, drag/drop, or native tab removal**.
- `assets/icon.svg`: earlier provisional icon, not yet approved as final.

Observed on **Zen 1.23.4b** (TufTux, Arch Linux): `ZenPinnedTabManager.mjs` includes `removeEssentials`, `addToEssentials`, `onCloseTabShortcut`, and `moveToAnotherTabContainerIfNecessary`. Dragging a Pinned to normal invokes `gBrowser.unpinTab`.

Zen Mods are CSS-only. A true guard requires a privileged integration with browser chrome. With Svalinn enabled:

- Close button, middle click, `Ctrl+W`, context-menu close, close-other/selected,
  unpin, and Remove from Essentials are blocked for protected tabs.
- Mixed multi-close still closes normal tabs and keeps protected tabs.
- Normal tabs, unloading, browser quit, window close, and session restore stay
  native.
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

It launches an isolated profile, injects the adapter, verifies
normal/Pinned/Essential mapping, close/unpin/removal guards, mixed multi-close,
the Zen close shortcut, unloading, all four duplication transitions, same-zone
and normal-tab behavior, failure safety, uninstall during a pending restore,
restart/session restore, then deletes the profile. It never patches
`/opt/zen-browser-bin` and never uses `~/.zen`. See
[`docs/zen-integration.md`](docs/zen-integration.md) for the mechanism, manual
smoke matrix, security model, and rollback steps.

## Next tasks

1. Choose and document a maintainable deployment path for the adapter (the smoke harness is not a user installation), then test in a disposable Zen profile and verify Zen update compatibility before enabling in the main profile.
2. Extend pre-move duplication to multi-selected, cross-window, folder, tab-group and split-view cases.
3. Add explicit temporary unlock and visual controls on top of the policy.

**Safety:** do not patch `/opt/zen-browser-bin` or enable experimental scripts in the daily profile during development.
