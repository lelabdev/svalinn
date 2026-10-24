# Native Zen contribution plan

Handoff deliverable for issue #21. This document maps Svalinn's current behavior
onto `zen-browser/desktop`, fixes the proposed native design and test boundary,
and records what is still unknown. It is **not** a claim that Zen maintainers
have accepted, prioritized or integrated the feature.

- Upstream baseline: `zen-browser/desktop@dev`,
  commit [`2ad1945`](https://github.com/zen-browser/desktop/commit/2ad194525da74d7f00609a424d93a3c7db430d21)
  (2026-10-24).
- Contribution fork:
  [`lelabdev/zen-browser-desktop`](https://github.com/lelabdev/zen-browser-desktop)
  (verified fork; its `dev` matches upstream `2ad1945`, write access is on the
  fork only).
- Current Svalinn state: protection and the Locked/Unlocked toggle are merged
  (#20/PR #23); the research plan (#26) and README licensing clarification
  (#25/PR #27) are merged; separately packaged releases are cancelled (#7
  closed `not planned`).
- License: Zen is MPL-2.0; Svalinn is MIT. Native files must carry MPL-2.0
  headers, and ported policy logic should be rewritten in MPL-2.0 style with
  attribution rather than copied wholesale.
- This research used read-only GitHub APIs. No Zen build was run, and no local
  browser profile or daily installation was touched. A local build requires a
  separate explicit request.

## Decisions at a glance

| Question | Decision / proposal |
| --- | --- |
| Upstream branch | `dev`; feature branches are normally based on `dev`/`twilight` |
| Fork | Ready: `lelabdev/zen-browser-desktop`; upstream itself remains read-only |
| Default for existing users | **Opt-in / off by default** (`zen.pinned-tab-manager.protect-pinned-essentials=false`) |
| Protection states | Exactly two when enabled: **Locked** (default) and **Unlocked** |
| Persistence | `zen.pinned-tab-manager.protected-tabs-locked` (default `true`) |
| UI | One native checkbox in the Pinned/Essential tab context menu |
| Feature enable UI | Small checkbox in **Settings → Pinned Tabs**; maintainers decide |
| Copy-on-drop | **Not** in the first native PR; revisit separately |
| Standalone release | **Cancelled**: no extension package, tagged download or maintained browser fork; MIT source remains the prototype/fallback |
| First native PR | Feature gate + prefs + menu checkbox + close/unpin/removal/drag guards + L10n + tests |
| Maintainer approval | **Not established**; only a historical “good first issue” signal, not approval |

## Community and maintainer status

Existing upstream requests were found, but no maintainer has committed to the
feature or to reviewing a native PR:

- [Discussion #7050 — Idea on Pinned Tabs Functionality](https://github.com/zen-browser/desktop/discussions/7050)
  (2025-03): asks for accidental-close protection. The project owner posted a
  single Svalinn introduction and native-contribution note on 2026-10-24. No
  maintainer has responded as of that date.
- [Discussion #13833 — Lock/Protect Pinned Tabs from Accidental Unpinning &
  Closing](https://github.com/zen-browser/desktop/discussions/13833)
  (2026-05): closely matches Svalinn. One community workaround reply
  (`Ctrl+Shift+T`); no maintainer response.
- [Zen issue #11278 — Tabs and essentials easy to accidentally drag
  off](https://github.com/zen-browser/desktop/issues/11278): maintainer
  `mr-cheffy` said on 2026-03-12 that they would add “Lock Essentials” as a
  **good first issue**, and the repository applied that label. The issue was
  later closed by the reporter after the original drag problem appeared
  resolved (Hyprland sensitivity), not because the feature was implemented.
  This is a positive signal for a focused contribution, **not** approval of
  Svalinn's full scope, defaults or UX.
- [Discussion #2829 — Parity with Arc on Pinned
  Tab](https://github.com/zen-browser/desktop/discussions/2829): broader pinned-tab
  requests; no maintainer commitment to protection.
- No open upstream issue or PR implementing this protection was found by
  repository search.

The authenticated GitHub account has `pull:true`, `push:false`,
`triage:false` on `zen-browser/desktop`; write access exists only on the
contribution fork. The project owner already made the single appropriate
community reply, so no repetitive announcement should be posted. A maintainer
go/no-go and preferred scope/default are still required before implementation.

**Status:** maintainer acceptance remains unverified. Absence of a maintainer
response is explicitly documented here; the historical “good first issue”
signal is not treated as approval.

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

## Finalized first-PR parity choices

These choices close the open implementation questions for the first PR unless a
maintainer directs otherwise:

- **Ctrl+W / close shortcut while Locked:** suppress the destructive close and
  leave the tab untouched. Do not silently fall back to unload/reset when the
  user configured the shortcut as `close`; unload/reset/switch remain available
  through the existing native options and menu. This avoids surprising state
  changes while Locked.
- **Unpin / Remove from Essentials while Locked:** block the action and hide the
  corresponding native menu entries. The first native PR has no per-tab
  Svalinn-only removal commands; users Unlock, use native Zen actions, then
  Lock again. This keeps native menu ownership and avoids a second UX.
- **Guard boundary:** prefer small guards in the already-patched
  `Tabbrowser.sys.mjs` methods plus `ZenPinnedTabManager.removeEssentials`. This
  covers menu, shortcut, group and multi-selection paths without per-window
  monkey-patching. If maintainers reject core-method guards, fall back to
  guarding every Zen-owned call site and document that programmatic removal is
  outside the guarantee.
- **Feature gate:** one Settings checkbox bound to
  `protect-pinned-essentials`; the context-menu checkbox appears only when the
  feature is enabled. The Locked/Unlocked state remains the only runtime
  protection state. Maintainers may change the default or defer the Settings
  UI to `about:config`.
- **Copy-on-drop:** excluded from the first PR. Locked blocks cross-zone moves
  and preserves the source; Unlocked uses native move behavior. A later PR can
  propose duplication separately.
- **Required native suites:** `pinned`, `tabs`, `folders`, `split_view`,
  `container_essentials`, `window_drag`, `window_sync`, plus `npm run lint`.
  Maintainers may require the full `npm test` suite or additional platforms.

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
| `src/browser/components/tabbrowser/content/drag-and-drop-js.patch` | `_handle_drop` call to `moveToAnotherTabContainerIfNecessary` | Consult the protection policy before the native move/adopt path |
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

**No separate packaged release will be produced.** Issue #7 is closed
`not planned` at the project owner's direction: there will be no extension
package, tagged standalone download or maintained browser fork. The MIT-licensed
source installation remains available as the working prototype and fallback
until a native feature is accepted and shipped. This decision does not block the
native contribution; it removes packaging work from the critical path.

## Attribution and licensing

- Zen source files are MPL-2.0; add the standard MPL header to every new native
  file.
- Svalinn is MIT. Rewrite policy logic in MPL-2.0 style; if any MIT text is
  copied, preserve the MIT notice and record the provenance in the PR.
- Do not copy the autoconfig installer/loader into upstream. The native feature
  must be ordinary in-tree Zen code.
- Localization contributions should follow Zen's Fluent and translation
  process; English source strings plus accesskeys are enough for the first PR.

## Implementation handoff

This is the boundary for the next work item; it does **not** claim that native
code or an upstream PR exists.

- **Source:** fork [`lelabdev/zen-browser-desktop`](https://github.com/lelabdev/zen-browser-desktop),
  default `dev` at upstream `2ad1945`. Refresh from
  `zen-browser/desktop@dev` before branching.
- **Branch:** create one feature branch from `dev` once maintainers give
  go/no-go. Do not reuse a Svalinn branch or open a PR from an unrelated fork.
- **Out of scope:** Svalinn's autoconfig installer/loader, standalone packaging,
  copy-on-drop, branding, and any browser-fork distribution.

### Order of work

1. Add the two prefs and the Settings gate; verify defaults and pref persistence.
2. Add the native policy helper and the Locked/Unlocked manager state, pref
   observer, per-window root marker and rollback behavior.
3. Add the Pinned/Essential context-menu checkbox, Fluent strings, and
   locked-state hiding of native destructive entries.
4. Add close/middle-click/unpin/remove guards at the agreed boundary.
5. Add drag/drop and detach guards, preserving same-category reorder and native
   unload/restart/shutdown.
6. Add the CSS unlocked overrides and the browser test matrix; run lint and the
   required suites in a separate checkout with a disposable profile.

### Definition of done for the first PR

- Feature disabled → native behavior unchanged, with no menu item and no guards.
- Feature enabled → Locked by default; exactly two states; pref persists across
  restart and new windows; failed transitions do not report success or leave a
  partial unlock.
- Locked blocks close/shortcut/middle-click/unpin/removal/unsafe drag/detach and
  preserves the source tab; same-category reorder, unload, session restore and
  shutdown remain native.
- Unlocked delegates to native Zen and shows native destructive entries.
- MPL-2.0 headers, Fluent strings, attribution for any MIT-derived logic, and
  green required native tests.
- Upstream PR is focused, references the community request without claiming
  endorsement, and does not include the standalone installer.

### Handoff status

The fork is ready and the plan is complete, but **no feature branch, native
code or upstream PR has been created**. Starting implementation requires
maintainer feedback or an explicit owner decision to proceed without it, plus a
separate authorized build/test environment. The current environment must not be
used for a native build or daily-profile testing.

## Open questions for maintainers

The handoff uses the recommendations below unless maintainers decide otherwise:

1. Is a native protection feature welcome at all, and is `dev` the right target?
2. Is opt-in/off-by-default acceptable, or should it be on by default?
3. Settings checkbox vs. `about:config`-only gate for the first PR?
4. Central `Tabbrowser` guards vs. guarding only Zen-owned call sites? Proposed:
   central guards with a call-site fallback.
5. Should the close shortcut in Locked mode be a no-op, or fall back to Zen's
   configured unload/reset behavior? Proposed: no-op for destructive close.
6. Is copy-on-drop wanted later, or should native Zen keep block-only behavior?
   Proposed: block-only first, duplication later.
7. Which test suites and platforms are required before review? Proposed list is
   in the parity choices and test plan.

## Acceptance mapping for #21

| Criterion | Status |
| --- | --- |
| Verify upstream requests and maintainer welcome | Requests and the historical “good first issue” signal documented; **no maintainer response to the Svalinn proposal**; absence explicitly recorded |
| Establish target branch, guidelines, fork need, source candidates | **Done**: `dev`, contribution/build docs, fork ready, components mapped |
| Map native call sites and minimal pref/UI/close/demotion/drop design | **Done**, with central-guard recommendation and fallback |
| Decide safe default, copy-on-drop scope, compatibility, record feedback | Opt-in/off default, copy-on-drop deferred, compatibility documented, feedback absence recorded |
| Practical build/test plan and file-level implementation brief | **Done**; build not executed by design |
| Decide separate downloadable release | **Done**: cancelled `not planned`; no packaging |
| Confirm next native implementation PR boundary | **Done in the handoff above**; starting it still requires maintainer go/no-go or an explicit owner decision |

## Next actions

1. Wait for a maintainer response in Discussion #7050; do not post repetitive
   announcements. If none arrives, the owner decides whether to ask once in the
   most relevant discussion or proceed with a focused PR at their own risk.
2. If proceeding, refresh the contribution fork from `dev`, create one feature
   branch and implement the order of work in the handoff.
3. Run the native suites and lint in a separate authorized checkout with a
   disposable profile; report results in the upstream PR.
4. Keep the MIT Svalinn source working as the prototype/fallback. Do not claim
   native integration until Zen accepts and ships it, and do not close #21 until
   the resulting upstream PR is tracked.
