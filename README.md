# Svalinn

**Tab Guardian for Zen Browser** — protect Essentials and Pinned tabs against accidental removal.

## Intended behavior

| Operation | Locked behavior |
| --- | --- |
| Close an Essential or Pinned (X, middle click, Ctrl+W, context menu) | Block |
| Remove from Essentials / Unpin | Blocked by default; explicit per-tab command allows one action |
| Drag protected tab to another category | Duplicate into target; preserve original |
| Drag protected tab to another window | Duplicate; preserve original |
| Reorder within its own category | Allow |
| Unload protected tab | Allow |
| Explicit per-tab Unpin / Remove from Essentials command | Allow that one intentional action; no timer or global unlock |
| Normal tabs | Keep Zen's native behavior |

## Current status

**Close/unpin/removal protection, explicit per-tab unpin/removal, lifecycle-safe close/menu hiding, and drag category protection (block by default, optional duplication) implemented and smoke-tested.**

- `src/policy.mjs`: dependency-free, testable protection rules.
- `tests/`: policy regression tests plus adapter, capability, close-guard,
  drop-guard, intentional-action, CSS-scope, bundling, and protocol tests. Run
  with `npm test`.
- `src/zen/`: privileged adapter with close/demotion guards, default-block drag
  protection, optional copy-on-drop, lifecycle-scoped close/menu UI, per-tab
  intentional actions, and a Marionette smoke harness.
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
- Right-click a protected tab for **Unpin This Pinned Tab** or **Remove This Tab
  from Essentials**. Each runs the native action for that single tab only, under
  a per-action authorization that ends with the call; no timer or global unlock.
- Protected category is preserved on drag. Default behavior blocks
  category-changing/cross-window/multi-tab/unsafe drops; same-category reordering
  and safe folder moves stay native. Copy-on-drop is optional
  (`svalinn.protectedDragBehavior = duplicate`):

| Drag | Result |
| --- | --- |
| Reorder within Essentials/Pinned, or safe same-category folder move | Native |
| Protected cross-category, cross-window, multi-tab, group/split, or unknown target | Block; source category preserved |
| Optional duplicate mode, single tab/same window | Duplicate; source preserved; failures block |
| Normal tabs | Native behavior |

The smoke harness validates these paths in a disposable profile:

```bash
npm run zen:smoke
```

It launches an isolated profile with `userChrome.css`, verifies pre-install CSS is
inert, normal/Pinned/Essential mapping, close/unpin/removal guards, mixed
multi-close, the Zen close shortcut, unloading, CSS close-button visibility,
folder-contained tabs, context-menu restrictions that preserve Zen's native
state, intentional unpin/Remove-from-Essentials commands, uninstall restoring
native affordances, default drag blocking, multi/folder/cross-window safety,
two real workspaces, a non-default container, container-specific Essentials,
group-label and split-view drops, folder-to-folder membership, multi-tab reorder,
optional duplicate mode with non-default container identity, same-zone/normal-tab
behavior, failure safety, restart, then deletes the profile. It never patches
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

1. Choose and document a maintainable deployment path for the adapter (the smoke harness is not a user installation), then test in a disposable Zen profile and verify Zen update compatibility before enabling in the main profile.
2. Consider independent per-category protection and extend duplication to additional drag contexts only after their category semantics are verified.

**Safety:** do not patch `/opt/zen-browser-bin` or enable experimental scripts in the daily profile during development.
