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


## Roadmap

The live, issue-linked plan is tracked in **[Roadmap #13 — features first, personal installation second](https://github.com/lelabdev/svalinn/issues/13)**.

| Phase | Issues | Status / result |
| --- | --- | --- |
| 0. Foundation | [#1](https://github.com/lelabdev/svalinn/issues/1), [#2](https://github.com/lelabdev/svalinn/issues/2), [#3](https://github.com/lelabdev/svalinn/issues/3) | **Done and merged:** Zen test adapter, protected cross-zone duplication (single tab / same window), and close/demotion guards |
| 1. Finish the actions | [#4](https://github.com/lelabdev/svalinn/issues/4), [#5](https://github.com/lelabdev/svalinn/issues/5) | **Next:** visual controls and temporary unlock; cross-window, multi-tab, workspace/container/folder/split-view safety |
| 2. Test & stabilize | [#6](https://github.com/lelabdev/svalinn/issues/6) | CI and regressions against real Zen; may begin in parallel with phase 1 |
| 3. Personal installation | [#12](https://github.com/lelabdev/svalinn/issues/12) | Package the **feature-complete** behavior for persistent use in the user's Zen; test on a disposable profile first |
| 4. Distribution | [#7](https://github.com/lelabdev/svalinn/issues/7) | Install/uninstall, compatibility, releases for other users |
| Parallel polish | [#8](https://github.com/lelabdev/svalinn/issues/8) | Final round-shield SVG icon; non-blocking |

**Potential native Zen contribution:** only after the behavior is validated; propose it in Zen Discussions and, if welcomed, submit an opt-in implementation against `zen-browser/desktop`'s `dev` branch. This is **not** required to use Svalinn personally.

**Safety:** do not patch `/opt/zen-browser-bin` or enable experimental scripts in the daily profile during development.
