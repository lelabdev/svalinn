# Native Zen contribution plan

Research deliverable for issue #21. This document maps Svalinn's current
behavior onto `zen-browser/desktop`, proposes a minimal native design, and
records what is still unknown. It is **not** a claim that Zen maintainers have
accepted or prioritized the feature.

- Upstream baseline: `zen-browser/desktop@dev`,
  commit [`2ad1945`](https://github.com/zen-browser/desktop/commit/2ad194525da74d7f00609a424d93a3c7db430d21)
  (2026-10-24).
- License: Zen is MPL-2.0; Svalinn is MIT. Native files must carry MPL-2.0
  headers, and ported policy logic should be rewritten in MPL-2.0 style with
  attribution rather than copied wholesale.
- This research was read-only against upstream and used GitHub APIs only. No
  Zen build was run, and no local browser profile or daily installation was
  touched. A local build requires a separate explicit request.

## Decisions at a glance

| Question | Recommendation |
| --- | --- |
| Upstream branch | `dev`; feature branches are normally based on `dev`/`twilight` |
| Fork required | Yes for a PR; the current GitHub account has read-only upstream access |
| Default for existing users | **Opt-in / off by default** (`zen.pinned-tab-manager.protect-pinned-essentials=false`) |
| Protection states | Exactly two when enabled: **Locked** (default) and **Unlocked** |
| Persistence | `zen.pinned-tab-manager.protected-tabs-locked` (default `true`) |
| UI | One native checkbox in the Pinned/Essential tab context menu |
| Feature enable UI | Small checkbox in **Settings → Pinned Tabs**; maintainers decide |
| Copy-on-drop | **Not** in the first native PR; revisit separately |
| Standalone release | Keep the current MIT/source installation; defer #7 until the native outcome |
| First native PR | Feature gate + prefs + menu checkbox + close/unpin/removal/drag guards + L10n + tests |
| Maintainer approval | **Not yet established**; see community section |

## Community and maintainer status

Existing upstream requests were found, but no maintainer has committed to the
feature or to reviewing a native PR:

- [Discussion #7050 — Idea on Pinned Tabs Functionality](https://github.com/zen-browser/desktop/discussions/7050)
  (2025-03): asks for accidental-close protection. Two community replies; no
  maintainer response.
- [Discussion #13833 — Lock/Protect Pinned Tabs from Accidental Unpinning &
  Closing](https://github.com/zen-browser/desktop/discussions/13833)
  (2026-05): closely matches Svalinn. One community workaround reply
  (`Ctrl+Shift+T`); no maintainer response.
- [Discussion #2829 — Parity with Arc on Pinned
  Tab](https://github.com/zen-browser/desktop/discussions/2829): broader pinned-tab
  requests; no maintainer commitment to protection.
- No open upstream issue or PR implementing this protection was found by
  repository search.

The authenticated GitHub account has `pull:true`, `push:false`,
`triage:false` on `zen-browser/desktop`, so **no Discussion comment was posted
in this research and no maintainer feedback can be claimed**. Before writing
native code, a human with permission should post a short comment in #13833 (or
open a focused feature request) linking the working MIT-licensed standalone
project and asking whether maintainers want a native PR, with which default and
scope.

**Status:** maintainer receptiveness remains unverified. This is the main open
acceptance criterion for #21.

## Native behavior specification

When the feature pref is enabled:

### Locked (default)

- Block accidental close of Pinned and Essential tabs from the close shortcut,
  middle click, close button/overlay, tab context menu, and multi-tab/group
  close entry points.
- Block unpin and Remove-from-Essentials unless an explicit future native
  confirmation path is added. The first PR has no per-tab Svalinn-only menu
  commands; native Zen commands are simply unavailable while Locked.
- Block drag/drop that would change category, window, workspace, container, or
  detach a Pinned/Essential tab outside the window. Preserve the source tab.
- Keep same-category reorder, folder reorder within the same category, unload,
  restart, session restore, and shutdown native.
- Show no close X/overlay for protected tabs. Native Zen CSS already hides these
  in the main vertical layout; verify expanded/compact and theme variants.

### Unlocked

- Delegate close, close shortcut, middle click, unpin, Remove from Essentials,
  drag/drop, detach and multi-close to native Zen.
- Show native destructive menu items and the native close affordance where Zen
  normally shows it.
- Do not move, close, unpin, or recreate any tab as a side effect of the toggle.
- Persist the state until the user toggles it again.
- Keep normal tabs native in both states.

### Failure behavior

- Never report a successful toggle unless the pref was written and the current
  window UI/marker reached the requested state.
- If a window cannot update, restore the pref and all windows, and keep the
  behavioral guards in the previous (fail-closed) state.
- Native code is not a security boundary: extensions or privileged programmatic
  removals are out of scope, matching the standalone project's documented model.
- Feature disabled means no menu item, no guards, and no pref side effects.

## Preference design

Add to `prefs/zen/workspaces.yaml` (the existing pinned-tab prefs live there):

```yaml
- name: zen.pinned-tab-manager.protect-pinned-essentials
  value: false

- name: zen.pinned-tab-manager.protected-tabs-locked
  value: true
```

- `protect-pinned-essentials` is the opt-in feature gate. Off by default so
  existing users see no behavior change.
- `protected-tabs-locked` is the runtime two-state toggle. It is read only when
  the feature gate is on. A fresh enable therefore starts Locked.
- The lock pref should not be added to any legacy `user.js` migration. Zen's
  normal pref storage is sufficient and avoids resetting the state on every
  startup.
- Settings UI: add one checkbox in
  `src/browser/components/preferences/zenTabsManagement.inc.xhtml` under the
  Pinned Tabs section, bound to `protect-pinned-essentials`. The lock state stays
  in the tab context menu, not Settings.

## UI, localization and multi-window synchronization

### Context menu

Add one native item in
`src/zen/tabs/ZenPinnedTabManager.mjs#_insertItemsIntoTabContextMenu`:

```xml
<menuitem id="context_zen-protect-pinned-essentials"
          type="checkbox"
          data-l10n-id="tab-context-zen-protect-pinned-essentials"
          hidden="true"/>
```

- Show it only for a Pinned/Essential context tab (or a multi-selection that
  includes one) and only when the feature gate is enabled.
- `checked = protected-tabs-locked`; refresh it in
  `updatePinnedTabContextMenu`, which `tab-context-menu-js.patch` already calls on
  every menu opening.
- Use an explicit unlocked label rather than ambiguity. Two Fluent keys are
  simpler and clearer than argument-heavy state text:
  - `tab-context-zen-protect-pinned-essentials` — “Protect Pinned & Essentials”
  - `...-unlocked` — “Protect Pinned & Essentials (currently unlocked)”
- Keep the item near the existing pinned-tab commands and add a separator so it
  is not mixed with normal tab actions.
- When Locked, hide/disable native `context_closeTab`,
  `context_unpinTab`, `context_unpinSelectedTabs`, and
  `context_zen-remove-essential` for protected tabs. Do not mutate unrelated
  native hidden/disabled states beyond those actions.

### Multi-window and persistence

- Each window has its own `gZenPinnedTabManager` instance. Register a preference
  observer in `init()` and remove it on `unload`.
- On a lock-pref change, update the menu item and the window's root marker in
  **every** browser window. Prefs are global, so one `Services.prefs.setBoolPref`
  fans out to all managers.
- New windows apply the current pref during init.
- Use a per-window root attribute for CSS, for example
  `document.documentElement`:
  - `zen-protected-tabs="locked"` while enabled and locked
  - `zen-protected-tabs="unlocked"` while enabled and unlocked
  - attribute absent when the feature is disabled
- Update the attribute only after the pref state is confirmed. On a failed
  update, restore the pref and all window attributes/menu states; do not report
  success.
- Unload/restart needs no session migration: prefs persist and init reapplies the
  state. Session restore must not be blocked or rewritten.

### CSS and close affordances

Native vertical-tab CSS already hides close buttons for pinned and Essential
tabs (`src/zen/tabs/zen-tabs/vertical-tabs.css`). Add scoped overrides only when
the feature is enabled and unlocked, e.g. under
`:root[zen-protected-tabs="unlocked"]`, so native close controls can reappear.
Keep the Locked rules as close to native Zen as possible; do not import
Svalinn's `userChrome.css` wholesale. Verify expanded/compact layouts and
light/dark themes manually because Zen's close-button geometry differs by mode.

## Native call-site map

| Upstream file | Symbol / area | Required change |
| --- | --- | --- |
| `src/zen/tabs/ZenPinnedTabManager.mjs` | `init` | Read the two prefs; apply root marker; register pref observer; initialize menu; clean up on unload |
| same | `_insertItemsIntoTabContextMenu` | Insert checkbox + separator |
| same | `updatePinnedTabContextMenu` | Show/hide the checkbox; synchronize checked state; hide destructive native items when Locked |
| same | `onCloseTabShortcut` | When Locked, suppress destructive `close` for protected tabs; allow unload/reset/switch as today |
| same | `_onTabClick` | Middle click already routes through `onCloseTabShortcut`; verify the guard covers it |
| same | `removeEssentials` | Refuse the whole mutation (including multi-selection) while Locked |
| same | `moveToAnotherTabContainerIfNecessary` | Refuse protected category/window/workspace/container changes before mutating; keep same-zone reorder native |
| `src/zen/drag-and-drop/ZenDragAndDrop.js` | `handle_drop`, `handle_drop_transition`, `handle_dragend` | Integrate the policy check for drop/detach; clear visuals after a blocked drop; do not create windows for protected out-of-window drags |
| `src/browser/components/tabbrowser/content/drag-and-drop.js` (Zen patch) | `_handle_drop` call to `moveToAnotherTabContainerIfNecessary` | Consult the protection policy before the native move/adopt path |
| `src/browser/components/tabbrowser/Tabbrowser-sys-mjs.patch` | `removeTab`, `removeTabs`, `removeCurrentTab`, `unpinTab`, `removeTabGroup` | Central guards are the preferred native boundary; allow shutdown/session/internal authorized paths. Confirm maintainer preference before patching this deeply |
| `src/browser/components/tabbrowser/content/tab-context-menu-js.patch` | menu update call | Already calls `updatePinnedTabContextMenu`; verify ordering covers the checkbox before display |
| `src/zen/tabs/zen-tabs/vertical-tabs.css` | pinned/essential close rules | Add unlocked overrides; preserve native locked hiding |
| `prefs/zen/workspaces.yaml` | prefs | Add the two defaults |
| `src/browser/components/preferences/zenTabsManagement.inc.xhtml` | Pinned Tabs section | Add the opt-in checkbox |
| `locales/en-US/browser/browser/zen-general.ftl` | menu strings | Add checked/unlocked labels and accesskeys |
| `locales/en-US/browser/browser/preferences/zen-preferences.ftl` | settings strings | Add feature-gate label/description |
| `src/zen/tests/pinned/browser.toml` + new test | native browser tests | Register the main regression suite |
| `src/zen/tests/tabs`, `folders`, `split_view`, `container_essentials`, `window_drag`, `window_sync` | existing suites | Add cross-context cases where the guard interacts with existing behavior |

### Why a central Tabbrowser guard

Svalinn currently replaces per-window `gBrowser.removeTab` and related methods.
Repeating that monkey-patching upstream would be fragile. Zen already maintains
patches for `Tabbrowser.sys.mjs`; a small policy guard in those patched methods
avoids per-window monkey patches and covers menu, shortcut, group, and
programmatic UI paths consistently. It must be bypassed for shutdown, tab
closing, session restore, and explicit native cleanup. If maintainers prefer not
to touch Firefox core methods, the fallback is to guard every Zen-owned call
site and hide menu entries, accepting that programmatic removal is not covered.

## Policy and scope details

- Port `src/policy.mjs` concepts (zone classification, protected-tab predicate,
  allow/block decision) into a small native module, e.g.
  `src/zen/tabs/ZenTabProtectionPolicy.mjs`, with MPL-2.0 headers and attribution.
- A protected tab is Pinned or Essential. Unknown/group/split shapes are handled
  conservatively in drag planning; do not partially mutate a multi-selection.
- Copy-on-drop (`protectedDragBehavior=duplicate`) is **deferred**. The first
  native PR blocks cross-zone moves and preserves the source, matching Zen's
  existing move semantics. Duplication is a separate behavior with its own
  identity/container/folder questions and should not delay the protection PR.
- Multi-selection, folders, split views, workspaces and container-specific
  Essentials must preserve or block the whole operation; no partial moves.
- Unload, same-category reorder, normal-tab operations, restart and shutdown
  remain native in both states.

## Native test plan

### New browser tests

Add `src/zen/tests/pinned/browser_protected_tabs.js` and register it in
`src/zen/tests/pinned/browser.toml`. Cover:

1. Feature disabled: no context-menu checkbox, no guards, native close/unpin/
   removal/drag behavior.
2. Enable + Locked: close shortcut, middle click, close menu, unpin, Remove from
   Essentials, multi-close/group close, cross-zone/window/workspace/container
   drag and detach are blocked; source tabs are unchanged.
3. Locked preserves same-category reorder, folder reorder within category,
   unload, restart/session restore and shutdown.
4. Menu checkbox: visible only on Pinned/Essential, checked while Locked,
   unchecked/labeled while Unlocked; native destructive entries reappear when
   unlocked.
5. Unlock → native close/unpin/remove/drag work; relock → guards return; no tab
   changed by the toggle itself.
6. Multi-window: toggle in one window updates the other window's checkbox and
   markers; a newly opened window inherits the state; failed pref/DOM update
   does not report success or leave a partial state.
7. Persistence: the pref survives a new window and native restart-equivalent
   setup; fresh enable defaults to Locked.
8. Unsupported/failed initialization: feature unavailable or manager not ready
   leaves native behavior intact and exposes no misleading control.

### Existing suites

Run and extend where the guard intersects existing behavior:

```bash
npm test pinned
npm test tabs
npm test folders
npm test split_view
npm test container_essentials
npm test window_drag
npm test window_sync
npm run lint
```

`npm test` delegates to `scripts/run_tests.py`, which runs `./mach test` against
the requested `src/zen/tests/<name>` directory. The pinned suite already covers
close shortcuts (`browser_pinned_close.js`), reset/unload behavior and Essential
transitions; the tabs suite covers vertical drag/drop. Add guard cases rather
than duplicating existing coverage.

### Build and environment plan

From the upstream contribution docs (requires an explicit later request):

```bash
git clone https://github.com/zen-browser/desktop.git --depth 10
cd desktop
npm i
npm run init
python3 ./scripts/update_en_US_packs.py
npm run build
# JavaScript-only iteration after the first build:
npm run build:ui
npm start
```

Requirements: ~30 GB free disk, Git, Python 3, Node 21+, Rust/Cargo and
sccache. Builds should use a separate checkout and a disposable profile. Do not
touch the user's daily Zen installation or profile.

## Standalone release decision

Defer #7 (downloadable standalone release). The current MIT-licensed source
installation remains the supported fallback while the native PR is explored.
Producing a packaged release now would add maintenance and distribution work
before maintainer feedback and would not help the upstream proposal. Revisit #7
only if the native path is rejected, stalls, or users need a simpler install.

## Attribution and licensing

- Zen source files are MPL-2.0; add the standard MPL header to every new native
  file.
- Svalinn is MIT. Rewrite policy logic in MPL-2.0 style; if any MIT text is
  copied, preserve the MIT notice and record the provenance in the PR.
- Do not copy the autoconfig installer/loader into upstream. The native feature
  must be ordinary in-tree Zen code.
- Localization contributions should follow Zen's Fluent and translation
  process; English source strings plus accesskeys are enough for the first PR.

## Open questions for maintainers

1. Is a native protection feature welcome at all, and is `dev` the right target?
2. Is opt-in/off-by-default acceptable, or should it be on by default?
3. Settings checkbox vs. `about:config`-only gate for the first PR?
4. Central `Tabbrowser` guards vs. guarding only Zen-owned call sites?
5. Should the close shortcut in Locked mode be a no-op, or fall back to Zen's
   configured unload/reset behavior?
6. Is copy-on-drop wanted later, or should native Zen keep block-only behavior?
7. Which test suites and platforms are required before review?

## Acceptance mapping for #21

| Criterion | Status |
| --- | --- |
| Verify upstream requests and maintainer welcome | Requests found; **maintainer welcome unverified**; no upstream comment posted (read-only account) |
| Establish target branch, guidelines, fork need, source candidates | **Done**: `dev`, contribution/build docs, fork required, components mapped |
| Map native call sites and minimal pref/UI/close/demotion/drop design | **Done in this document**, subject to maintainer review of central guards |
| Decide safe default, copy-on-drop scope, compatibility, record feedback | Default/off + deferred copy-on-drop decided; **feedback absent** |
| Practical build/test plan and file-level implementation brief | **Done**; build not executed by design |
| Decide separate downloadable release | **Deferred**; not a blocker |
| Confirm next native implementation PR boundary | First PR boundary proposed above; maintainer go/no-go still required |

## Next actions

1. A human with upstream write access posts a concise proposal in Discussion
   #13833 (or a feature request), linking Svalinn and asking for go/no-go and
   preferred scope/default.
2. If welcomed, fork `zen-browser/desktop`, branch from `dev`, and implement the
   first-PR boundary in this document.
3. Run the listed native suites and lint in a separate checkout with a
   disposable profile; report results in the upstream PR.
4. Keep the standalone Svalinn working and documented until the feature is
   actually accepted and shipped.
