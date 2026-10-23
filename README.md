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

**Policy and tests only — not installed or functional inside Zen yet.**

- `src/policy.mjs`: dependency-free, testable protection rules.
- `tests/policy.test.mjs`: regression tests, run with `npm test` or `bun run test`.
- `userChrome.css`: visual draft; **does not protect against keyboard, drag/drop, or native tab removal**.
- `assets/icon.svg`: earlier provisional icon, not yet approved as final.

Observed on **Zen 1.23.4b** (TufTux, Arch Linux): `ZenPinnedTabManager.mjs` includes `removeEssentials`, `addToEssentials`, `onCloseTabShortcut`, and `moveToAnotherTabContainerIfNecessary`. Dragging a Pinned to normal invokes `gBrowser.unpinTab`.

Zen Mods are CSS-only. A true guard will require an experimentally validated, privileged integration with browser chrome. A regular Firefox WebExtension cannot reliably prevent all close paths.

## Next tasks

1. Build a privileged browser adapter applying the policy *before* close, unpin, and Essential removal; ensure explicit unlock, browser exit and session recovery continue working.
2. Implement copy-on-drop at the pre-move boundary, with container, workspace, cross-window and multi-selected tab cases.
3. Test in a disposable Zen profile and verify Zen update compatibility before enabling in the main profile.

**Safety:** do not patch `/opt/zen-browser-bin` or enable experimental scripts in the daily profile during development.
