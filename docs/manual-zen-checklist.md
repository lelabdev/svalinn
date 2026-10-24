# Manual Zen smoke-test checklist

Use this checklist in a **disposable** Zen profile only. It complements the
automated Node/VM tests and `npm run zen:smoke`; it is not a substitute for them.

## Prerequisites

| Item | Expected |
| --- | --- |
| Zen | `1.23.4b` verified. Other versions may be probed but are unsupported until revalidated. |
| OS | Linux (Arch/CachyOS tested), Wayland or X11. |
| Node | 22 or newer. |
| Repo | Checkout with `src/zen/` and `userChrome.css`. |
| Profile | New/empty temporary profile. Never `~/.zen`. |
| Binary | `zen-browser` on `PATH`, or pass `--zen /path/to/zen-browser`. |

`userChrome.css` requires
`toolkit.legacyUserProfileCustomizations.stylesheets = true`; the manual launcher
sets it in the disposable profile.

## Safety preflight

```bash
npm test
npm run check
npm run zen:smoke
node src/zen/smoke.mjs --headless
```

Do not continue if any command fails. The smoke harness verifies `moz:profile`,
never edits `/opt/zen-browser-bin`, and never writes to the daily profile.

## Start a manual session

```bash
npm run zen:manual -- --keep-profile
```

The launcher:

1. creates a temporary profile and copies `userChrome.css` into it;
2. starts Zen with Marionette and `--no-remote`;
3. verifies the connected `moz:profile`;
4. injects the adapter and installs both close and drag guards;
5. leaves Zen open for the checklist.

The adapter is session-only. Closing Zen removes the guards. The generated
profile path is printed; delete it when finished, or omit `--keep-profile` so it
is removed automatically.

## 1. Baseline

| Check | Expected |
| --- | --- |
| Create a Normal tab | Native controls; close X can be shown on hover. |
| Create/pin a Pinned tab | No close X/overlay while locked. |
| Create an Essential tab | No close X/overlay while locked. |
| Context menu on Pinned/Essential | Native Close/Unpin/Remove entries hidden; matching Svalinn command visible. |
| Context menu on Normal | Native entries unchanged; Svalinn commands hidden. |

## 2. Close and intentional removal

| Gesture | Pinned | Essential | Normal |
| --- | --- | --- | --- |
| Close X / `Ctrl+W` / middle click | Stays open | Stays open | Closes |
| Context menu → Close | Hidden | Hidden | Native |
| Context menu → Unpin | Hidden (use Svalinn command) | Hidden | Native |
| Context menu → Remove from Essentials | — | Hidden (use Svalinn command) | — |
| Svalinn → **Unpin This Pinned Tab** | Unpins once; remains open | — | — |
| Svalinn → **Remove This Tab from Essentials** | — | Removes once to Normal | — |
| Mixed multi-select close | Protected stays, normal closes | Protected stays | Normal closes |

After an intentional command, protection must be active again immediately. There
is no timer or global unlock.

## 3. Drag and drop

| Gesture | Expected |
| --- | --- |
| Reorder within Essentials/Pinned | Native reorder; category retained. |
| Move a Pinned tab between compatible folders | Native folder membership; stays Pinned. |
| Drag Pinned ↔ Normal/Essential, or Essential ↔ Normal/Pinned | Blocked; original tab remains in its category. |
| Drag protected tab to another window | Blocked; stays in original window. |
| Drag protected tab outside the window and release | Blocked; no new window; original remains. |
| Drag Normal tab outside the window | Native new-window detachment works. |
| Multi-select containing a protected tab across categories | Whole drop blocked; all tabs remain. |
| Split-view source/target with protected tab | Blocked; split membership unchanged. |
| Normal-tab drag | Native. |
| Optional duplicate mode (`svalinn.protectedDragBehavior=duplicate`) | Four safe single-tab cross-category drops copy into target and keep source; unsafe contexts still block. |

Optional duplicate-mode check (session-scoped in the Browser Console):

```js
Svalinn.setDragBehavior("duplicate")
// perform the four transitions, then:
Svalinn.setDragBehavior("block")
```

## 4. Unload, restart and shutdown

| Check | Expected |
| --- | --- |
| Context menu → Unload protected tab | Allowed; tab remains, may be pending. |
| Quit Zen normally | No guard trap; process exits. |
| Restart same profile | Protected tabs restore with original category/session. |
| Reinstall/reopen manual session | Fresh session is locked and drag behavior defaults to `block`. |

## 5. Workspaces, containers, multi-window

| Check | Expected |
| --- | --- |
| Two workspaces; protected tab from another workspace dropped into active workspace | Blocked; original workspace retained. |
| Container-specific Essentials: incompatible container dropped on Essentials | Blocked; original container/category retained. |
| Open second window; protected tab remains attached to both windows | Guards attach; tabs unaffected. |
| Protected tab dragged to second window | Blocked; stays in source window. |

## 6. Themes and layouts

Repeat the baseline close-X and context-menu checks in:

- light theme;
- dark theme;
- expanded sidebar;
- compact sidebar.

The close X should be absent on locked protected tabs and present on Normal tabs
when Zen would normally show it. Zen Mods/themes may override presentation; the
behavioral guard must still block close/unpin/removal.

## 7. Disable and rollback

| Check | Expected |
| --- | --- |
| `Svalinn.uninstall()` (manual session) | Native close X/menus return; guards removed; tabs unchanged. |
| Close Zen | Temporary profile can be deleted; daily profile untouched. |
| Re-run `npm run zen:smoke` | PASS again. |

## Remaining cases not fully automated

- Physical OS drag-out for group labels, split views, and mixed selections: the
  automated Zen smoke uses `handle_dragend` events; real xdotool was used for
  Pinned/Essential/Normal drag-out.
- Visual theme/mod layout combinations depend on the user's Zen Mods and monitor
  setup; checklist screenshots/computed styles are the evidence.
- Real workspace switching mid-drag is modeled through source/target workspace
  checks and synthetic drops; a physical pointer gesture is still a manual case.
- A persistent installation path is future work (#12); the current manual session
  is disposable and adapter injection is session-scoped.

## CI

GitHub Actions runs `npm test` and `npm run check` on Node 22 and 24 for pushes to
`main` and every pull request. Browser smoke and this manual checklist are not run
in CI because they need a real Zen binary and display.
