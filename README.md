# Svalinn

[![CI](https://github.com/lelabdev/svalinn/actions/workflows/ci.yml/badge.svg)](https://github.com/lelabdev/svalinn/actions/workflows/ci.yml)

**Tab Guardian for Zen Browser** — protect Essentials and Pinned tabs against accidental removal.

## Intended behavior

| Operation | Locked behavior |
| --- | --- |
| Close an Essential or Pinned (X, middle click, Ctrl+W, context menu) | Block |
| Remove from Essentials / Unpin | Blocked by default; explicit per-tab command allows one action |
| Drag protected tab to another category / window / out of the window | Block by default; source and category preserved |
| Optional `protectedDragBehavior=duplicate` | Copy safe single-tab cross-category transitions; source preserved |
| Reorder within its own category | Allow |
| Unload protected tab | Allow |
| Explicit per-tab Unpin / Remove from Essentials command | Allow that one intentional action; no timer or global unlock |
| Normal tabs | Keep Zen's native behavior |

## Current status

**Close/unpin/removal protection, explicit per-tab unpin/removal, lifecycle-safe close/menu hiding, drag category protection (block by default, optional duplication), and a persistent personal loader are implemented and smoke-tested.**

- `src/policy.mjs`: dependency-free, testable protection rules.
- `tests/`: policy matrix plus adapter, capability, close-guard, drop-guard,
  intentional-action, CSS-scope, bundling, installer, and protocol tests. Run
  with `npm test`.
- `.github/workflows/ci.yml`: GitHub Actions runs `npm test` and `npm run check`
  on Node 22 and 24 for `main` pushes and every pull request.
- `docs/manual-zen-checklist.md`: disposable-profile manual gesture checklist.
  Start a session with `npm run zen:manual`.
- `src/zen/`: privileged adapter with close/demotion guards, default-block drag
  protection, optional copy-on-drop, lifecycle-scoped close/menu UI, per-tab
  intentional actions, a Marionette smoke harness, and a persistent personal
  installer/loader.
- `src/zen/persistent/` + `src/zen/install.mjs`: autoconfig bootloader and
  profile-local loader. Normal browsing needs no Marionette or debug port.
- `userChrome.css`: hides the close X/overlay for protected tabs only while the
  adapter is successfully installed (`:root[svalinn-active]`). CSS is not the
  security boundary.
- `assets/icon.svg`: earlier provisional icon, not yet approved as final.

## Personal installation

Svalinn can be installed persistently for personal use in Zen. It uses a
minimal autoconfig bootloader (the same class of mechanism as Sine/userChromeJS
loaders, without depending on Sine) plus a trusted loader in the profile. It is
not a published extension and does not use Marionette while browsing.

```bash
# Test against a copied installation first; /opt and ~/.zen stay untouched.
npm run zen:installed-smoke

# Install/update into an explicit profile.
node src/zen/install.mjs --profile /path/to/profile \
  --install-root /opt/zen-browser-bin

# Enable, disable, update, roll back or remove.
node src/zen/install.mjs --profile /path/to/profile --install-root /opt/zen-browser-bin \
  --disabled
node src/zen/install.mjs --profile /path/to/profile --install-root /opt/zen-browser-bin \
  --command rollback
node src/zen/install.mjs --profile /path/to/profile --install-root /opt/zen-browser-bin \
  --command uninstall
```

The installer backs up `user.js`, `chrome/userChrome.css` and affected
browser/profile files before writing, requires `--confirm-daily` for `~/.zen`,
refuses an existing different autoconfig loader, and fails closed on unverified
Zen versions. Installation changes only `svalinn.cfg` and
`defaults/pref/svalinn-autoconfig.js` in the installation root; no `/opt` patch
is performed during development or smoke tests. See
[`docs/persistent-install.md`](docs/persistent-install.md) for the full model,
status prefs, backups, rollback, sudo ownership handling, and troubleshooting.

## Verification

The normal adapter smoke suite is unchanged:

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
protected/normal out-of-window detached dragend paths, optional duplicate mode
with non-default container identity, same-zone/normal-tab behavior, failure
safety, restart, then deletes the profile. It never patches
`/opt/zen-browser-bin` and never uses `~/.zen`.

The persistent-installed suite runs the same checks after installing the real
bootloader/loader in a **copied** Zen installation. It first verifies startup
without Marionette, then runs the full windowed/headless suite through the
loaded adapter, including restart/session restore:

```bash
npm run zen:installed-smoke                 # headless, temporary install copy
npm run zen:installed-smoke -- --headed     # visible window
npm run zen:installed-smoke -- --install-root /tmp/opencode/zen-copy
```

See [`docs/zen-integration.md`](docs/zen-integration.md) for the mechanism,
manual smoke matrix, security model, and rollback steps.

## Testing and CI

```bash
npm test                 # Node VM/policy adapter tests
npm run check            # syntax checks + full test suite
npm run zen:smoke        # disposable real-Zen smoke (windowed/headless by flag)
npm run zen:installed-smoke # persistent loader in a copied install (no /opt writes)
npm run zen:manual       # disposable profile for the manual checklist
```

GitHub Actions runs the Node test/syntax checks automatically on every pull
request and on `main` pushes (Node 22 and 24). Browser smoke and the manual
gesture matrix are not run in CI because they require a real Zen binary and
display. `zen:manual` canonicalizes symlinked profile paths, refuses `~/.zen`
before writing, and exits nonzero unless the adapter is installed with active
guards. The expected manual outcomes and the remaining unautomated cases are
documented in [`docs/manual-zen-checklist.md`](docs/manual-zen-checklist.md).


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

1. Verify the persistent loader against the next Zen release and update the
   verified capability/version line, then re-run the installed smoke suite.
2. Consider independent per-category protection and extend duplication to
   additional drag contexts only after their category semantics are verified.
3. Decide whether the personal loader should remain self-contained or integrate
   with an external loader such as Sine after a separate review. Public release
   is tracked separately (#7); this phase is personal use only.

**Safety:** use the installer's backups and `--confirm-daily`; test with
`zen:installed-smoke` and a copied installation before changing a daily profile.
Never use `sudo` to run Zen itself.
