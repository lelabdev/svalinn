/**
 * Svalinn's browser-side adapter.
 *
 * This file is concatenated after `src/policy.mjs` and the `src/zen/*` helper
 * modules by `src/zen/build.mjs`, then evaluated in Zen's chrome context by the
 * smoke harness. It contains no imports. It installs a tab-strip drop guard
 * that duplicates protected tabs on cross-zone drops, plus close/unpin/
 * Essential-removal guards that leave unloading and normal tabs untouched.
 */
(() => {
  "use strict";

  const ADAPTER_VERSION = "0.6.0";
  const MARKER = "__svalinn";
  const DROP_HOOK = "__svalinnDropHook";
  const CLOSE_HOOK = "__svalinnCloseHook";
  const CONTEXT_HOOK = "__svalinnContextHook";
  const ACTIVE_ATTR = "svalinn-active";
  const UNLOCKED_ATTR = "svalinn-unlocked";
  const MENU_BLOCK_ATTR = "svalinn-blocked";
  const ENABLED_PREF = "svalinn.enabled";
  const LOCKED_PREF = "svalinn.locked";
  const DRAG_BEHAVIOR_PREF = "svalinn.protectedDragBehavior";

  const state = {
    installed: false,
    enabled: null,
    locked: true,
    windows: new Set(),
    observer: null,
    capabilities: null,
    warnings: [],
    pending: new Set(),
    restoredTabs: new WeakSet(),
    restoreTimeoutMs: 10_000,
    authorization: null,
    dragBehavior: "block",
  };

  function browserWindows() {
    const result = [];
    try {
      const enumerator = Services.wm.getEnumerator("navigator:browser");
      if (enumerator && typeof enumerator[Symbol.iterator] === "function") {
        for (const win of enumerator) {
          if (win && !win.closed) result.push(win);
        }
      } else {
        while (enumerator?.hasMoreElements?.()) {
          const win = enumerator.getNext();
          if (win && !win.closed) result.push(win);
        }
      }
    } catch (error) {
      state.warnings.push(`window-enumeration: ${error}`);
    }
    return result;
  }

  function prefEnabled() {
    try {
      return Boolean(Services.prefs.getBoolPref(ENABLED_PREF, false));
    } catch {
      return false;
    }
  }

  function prefLocked() {
    try {
      return Services.prefs.getBoolPref(LOCKED_PREF, true) !== false;
    } catch {
      return true;
    }
  }

  function persistLocked(value) {
    Services.prefs.setBoolPref(LOCKED_PREF, Boolean(value));
  }

  function normalizeDragBehavior(value) {
    return value === "duplicate" ? "duplicate" : "block";
  }

  function prefDragBehavior() {
    try {
      return normalizeDragBehavior(
        Services.prefs.getStringPref(DRAG_BEHAVIOR_PREF, "block")
      );
    } catch {
      return "block";
    }
  }

  function setDragBehavior(value) {
    state.dragBehavior = normalizeDragBehavior(value);
    return state.dragBehavior;
  }

  function withTimeout(promise, timeoutMs, message) {
    if (!(timeoutMs > 0)) return promise;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(message ?? "timeout")),
        timeoutMs
      );
      promise.then(
        value => {
          clearTimeout(timer);
          resolve(value);
        },
        error => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  function waitForWindowReady(win, timeoutMs) {
    const promises = [];
    const candidates = [
      win?.gZenStartup?.promiseInitialized,
      win?.delayedStartupPromise,
      win?.SessionStore?.promiseAllWindowsRestored,
    ];
    for (const candidate of candidates) {
      if (candidate && typeof candidate.then === "function") {
        promises.push(candidate);
      }
    }
    if (!promises.length) return Promise.resolve(true);
    return withTimeout(
      Promise.allSettled(promises).then(() => true),
      timeoutMs,
      "zen-startup-timeout"
    );
  }

  function zoneFromTarget(target) {
    if (!target || typeof target.closest !== "function") return null;
    try {
      if (target.closest(".zen-essentials-container")) return ZONES.ESSENTIAL;
      if (target.closest(".zen-workspace-pinned-tabs-section")) {
        return ZONES.PINNED;
      }
      if (target.closest(".zen-workspace-normal-tabs-section")) {
        return ZONES.NORMAL;
      }
      const section = target.closest(".zen-workspace-tabs-section");
      if (section?.classList?.contains("zen-essentials-container")) {
        return ZONES.ESSENTIAL;
      }
      if (
        section?.classList?.contains("zen-workspace-pinned-tabs-section")
      ) {
        return ZONES.PINNED;
      }
      if (
        section?.classList?.contains("zen-workspace-normal-tabs-section")
      ) {
        return ZONES.NORMAL;
      }
    } catch (error) {
      state.warnings.push(`drop-zone: ${error}`);
    }
    return null;
  }

  function activeWorkspaceId(win) {
    try {
      return (
        win?.gZenWorkspaces?.activeWorkspace ??
        win?.gZenWorkspaces?.getActiveWorkspaceFromCache?.()?.uuid ??
        null
      );
    } catch {
      return null;
    }
  }

  function activeContainerId(win) {
    try {
      return (
        win?.gZenWorkspaces?.getActiveWorkspaceFromCache?.()?.containerTabId ?? 0
      );
    } catch {
      return 0;
    }
  }

  function targetWorkspaceId(win, target) {
    try {
      const node = target?.closest?.("[zen-workspace-id]");
      if (node) return node.getAttribute("zen-workspace-id");
      if (target?.closest?.(".zen-essentials-container")) {
        return activeWorkspaceId(win);
      }
      if (win?.gZenWorkspaces?.activeWorkspaceElement?.contains?.(target)) {
        return activeWorkspaceId(win);
      }
    } catch {
      // Unknown target workspace; callers fail closed for protected tabs.
    }
    return null;
  }

  function tabContainerId(tab) {
    try {
      return tab?.userContextId ?? Number(tab?.getAttribute?.("usercontextid") ?? 0);
    } catch {
      return 0;
    }
  }

  function isSplitViewItem(win, item) {
    try {
      if (win?.gBrowser?.isSplitViewWrapper?.(item)) return true;
      if (item?.splitview || item?.splitView) return true;
      if (item?.group?.hasAttribute?.("split-view-group")) return true;
    } catch {
      return true;
    }
    return false;
  }

  function collectMovingTabs(win, source, movingTabs) {
    const tabs = [];
    const seen = new Set();
    let uncertain = null;
    let hasSplitView = false;

    const visit = (item, depth = 0) => {
      if (!item || uncertain) return;
      if (seen.has(item)) return;
      seen.add(item);
      if (depth > 6) {
        uncertain = "group-depth";
        return;
      }

      try {
        if (win?.gBrowser?.isTab?.(item)) {
          tabs.push(item);
          if (isSplitViewItem(win, item)) hasSplitView = true;
          return;
        }

        if (win?.gBrowser?.isSplitViewWrapper?.(item)) {
          hasSplitView = true;
          const members = item.tabs;
          if (!members || typeof members[Symbol.iterator] !== "function") {
            uncertain = "split-members";
            return;
          }
          for (const tab of members) visit(tab, depth + 1);
          return;
        }

        if (win?.gBrowser?.isTabGroupLabel?.(item)) {
          const members = item.group?.tabs;
          if (!members || typeof members[Symbol.iterator] !== "function") {
            uncertain = "group-members";
            return;
          }
          for (const tab of members) visit(tab, depth + 1);
          return;
        }

        // Some Zen folder/group implementations expose members directly.
        const directMembers = item?.group?.tabs ?? item?.tabs;
        if (directMembers && typeof directMembers[Symbol.iterator] === "function") {
          if (item?.group?.hasAttribute?.("split-view-group")) {
            hasSplitView = true;
          }
          for (const tab of directMembers) visit(tab, depth + 1);
          return;
        }

        uncertain = "unknown-drag-item";
      } catch {
        uncertain = "unreadable-drag-item";
      }
    };

    visit(source);
    if (Array.isArray(movingTabs)) {
      for (const item of movingTabs) visit(item);
    }

    return { tabs, uncertain, hasSplitView };
  }

  /**
   * Classify a drop before Zen mutates anything.
   *
   * - NATIVE: non-protected or same-category organization; delegate.
   * - DUPLICATE: optional safe single-tab cross-zone copy.
   * - BLOCK: protected category change or unsupported path; keep source.
   */
  function planDrop(win, dnd, event) {
    if (!state.locked) return { action: "native" };
    let source = null;
    let protectedTabs = [];
    let collected = null;

    try {
      const dataTransfer = event?.dataTransfer;
      if (!dataTransfer || dataTransfer.dropEffect !== "move") {
        return { action: "native" };
      }

      const dropType =
        win.TAB_DROP_TYPE ?? "application/x-moz-tabbrowser-tab";
      const types = dataTransfer.mozTypesAt?.(0);
      if (!types || types[0] !== dropType) return { action: "native" };

      source = dataTransfer.mozGetDataAt(dropType, 0);
      if (!source) return { action: "native" };

      collected = collectMovingTabs(
        win,
        source,
        source._dragData?.movingTabs
      );
    } catch {
      return { action: "native" };
    }

    if (collected.uncertain) {
      return {
        action: "block",
        source,
        reason: `uncertain-members:${collected.uncertain}`,
      };
    }

    protectedTabs = collected.tabs.filter(tab =>
      isProtected(readTabFlags(tab))
    );
    if (!protectedTabs.length) return { action: "native" };

    if (protectedTabs.some(tab => tab.documentGlobal !== win)) {
      return {
        action: "block",
        source,
        reason: "cross-window",
      };
    }

    try {
      const targetZone = zoneFromTarget(event.target);
      if (!targetZone) {
        return {
          action: "block",
          source,
          reason: "unknown-target",
        };
      }

      const targetTab = event.target?.closest?.(".tabbrowser-tab") ?? null;
      if (
        collected.hasSplitView ||
        isSplitViewItem(win, event.target) ||
        (targetTab && isSplitViewItem(win, targetTab))
      ) {
        return {
          action: "block",
          source,
          reason: "split-view",
        };
      }

      const activeWorkspace = activeWorkspaceId(win);
      if (!activeWorkspace) {
        return {
          action: "block",
          source,
          reason: "workspace-unknown",
        };
      }

      const targetWorkspace = targetWorkspaceId(win, event.target);
      if (!targetWorkspace || targetWorkspace !== activeWorkspace) {
        return {
          action: "block",
          source,
          reason: "target-workspace-mismatch",
        };
      }

      for (const tab of protectedTabs) {
        const flags = readTabFlags(tab);
        const tabWorkspace = flags.essential
          ? activeWorkspace
          : tab.getAttribute?.("zen-workspace-id");
        if (!tabWorkspace) {
          return {
            action: "block",
            source,
            reason: "source-workspace-unknown",
          };
        }
        if (tabWorkspace !== activeWorkspace) {
          return {
            action: "block",
            source,
            reason: "source-workspace-mismatch",
          };
        }
      }

      if (
        targetZone === ZONES.ESSENTIAL &&
        win.gZenWorkspaces?.containerSpecificEssentials
      ) {
        const targetContainer = activeContainerId(win);
        for (const tab of protectedTabs) {
          if (tabContainerId(tab) !== targetContainer) {
            return {
              action: "block",
              source,
              reason: "container-mismatch",
            };
          }
        }
      }

      const movingTabs = source._dragData?.movingTabs;
      const singleProtected =
        win.gBrowser?.isTab?.(source) &&
        protectedTabs.length === 1 &&
        Array.isArray(movingTabs) &&
        movingTabs.length === 1 &&
        movingTabs[0] === source;

      if (!singleProtected) {
        const crossing = protectedTabs.filter(
          tab => zoneOf(readTabFlags(tab)) !== targetZone
        );
        if (crossing.length) {
          return {
            action: "block",
            source,
            reason: "multi-or-group-cross-zone",
          };
        }
        return { action: "native", source };
      }

      const flags = readTabFlags(source);
      if (zoneOf(flags) === targetZone) {
        return { action: "native", source };
      }

      if (state.dragBehavior !== "duplicate") {
        return {
          action: "block",
          source,
          reason: "protected-cross-zone",
        };
      }

      const dropIndex =
        typeof dnd?._getDropIndex === "function"
          ? dnd._getDropIndex(event)
          : null;
      const elements = dnd?._tabbrowserTabs?.dragAndDropElements;
      const dropTarget =
        Array.isArray(elements) && Number.isInteger(dropIndex)
          ? elements[dropIndex] ?? null
          : null;

      return {
        action: "duplicate",
        source,
        targetZone,
        dropIndex,
        dropTarget,
      };
    } catch (error) {
      return {
        action: "block",
        source,
        reason: `planning-error:${error}`,
      };
    }
  }

  function applyZone(copy, targetZone, win) {
    const gBrowser = win.gBrowser;
    const manager = win.gZenPinnedTabManager;

    if (targetZone === ZONES.NORMAL) {
      if (copy.hasAttribute("zen-essential")) {
        withAuthorization(copy, ["remove-essential", "unpin"], () => {
          manager.removeEssentials(copy);
        });
      } else if (copy.pinned) {
        withAuthorization(copy, ["unpin"], () => {
          gBrowser.unpinTab(copy);
        });
      }
    } else if (targetZone === ZONES.PINNED) {
      if (copy.hasAttribute("zen-essential")) {
        withAuthorization(copy, ["remove-essential"], () => {
          manager.removeEssentials(copy, false);
        });
      } else if (!copy.pinned) {
        gBrowser.pinTab(copy);
      }
    } else if (targetZone === ZONES.ESSENTIAL) {
      if (!copy.hasAttribute("zen-essential")) {
        const added = manager.addToEssentials(copy);
        if (added === false) {
          throw new Error("addToEssentials rejected the duplicated tab");
        }
      }
    }

    const actual = zoneOf(readTabFlags(copy));
    if (actual !== targetZone) {
      throw new Error(`duplicated tab stayed in zone ${actual}`);
    }
  }

  function removePendingCopy(op) {
    if (op.removed) return;
    op.removed = true;
    try {
      if (op.copy?.isConnected !== false) {
        withAuthorization(op.copy, ["close"], () => {
          op.win?.gBrowser?.removeTab?.(op.copy, { animate: false });
        });
      }
    } catch (error) {
      state.warnings.push(`drop-cleanup: ${error}`);
    }
  }

  function settlePending(op, discardReason = null) {
    if (op.done) return;
    op.done = true;
    if (op.timer) clearTimeout(op.timer);
    state.pending.delete(op);

    if (discardReason) {
      state.warnings.push(`drop-duplicate: ${discardReason}`);
      removePendingCopy(op);
      return;
    }

    try {
      const gBrowser = op.win.gBrowser;
      applyZone(op.copy, op.plan.targetZone, op.win);

      const target =
        op.plan.dropTarget && op.plan.dropTarget !== op.copy
          ? op.plan.dropTarget
          : null;

      if (target) {
        gBrowser.moveTabsBefore([op.copy], target);
      } else {
        const lastIndex = Math.max(0, gBrowser.tabs.length - 1);
        const elementIndex = Number.isInteger(op.plan.dropIndex)
          ? Math.min(Math.max(op.plan.dropIndex, 0), lastIndex)
          : lastIndex;
        gBrowser.moveTabTo(op.copy, { elementIndex });
      }

      gBrowser.selectedTab = op.copy;
    } catch (error) {
      state.warnings.push(`drop-duplicate: ${error}`);
      removePendingCopy(op);
    }
  }

  function finalizePending(op) {
    if (op.done) return;
    if (
      !state.installed ||
      !state.enabled ||
      !state.locked ||
      op.cancelled ||
      !op.win ||
      op.win.closed === true
    ) {
      settlePending(op, "operation-cancelled");
      return;
    }
    const dnd = op.win?.gBrowser?.tabContainer?.tabDragAndDrop;
    if (!dnd?.[DROP_HOOK]) {
      settlePending(op, "hook-inactive");
      return;
    }
    settlePending(op);
  }

  function cancelPending(op, reason) {
    if (op.done || op.cancelled) return;
    op.cancelled = true;
    settlePending(op, reason);
  }

  function cancelPendingForWindow(win, reason) {
    for (const op of [...state.pending]) {
      if (op.win === win) cancelPending(op, reason);
    }
  }

  function cancelAllPending(reason) {
    for (const op of [...state.pending]) cancelPending(op, reason);
  }

  function duplicateTabForDrop(win, dnd, plan) {
    const gBrowser = win.gBrowser;
    let copy = null;

    try {
      copy = gBrowser.duplicateTab(plan.source);
    } catch (error) {
      state.warnings.push(`drop-duplicate: ${error}`);
      return null;
    }
    if (!copy) {
      state.warnings.push("drop-duplicate: duplicateTab returned null");
      return null;
    }

    const op = {
      win,
      copy,
      plan,
      done: false,
      cancelled: false,
      removed: false,
      timer: null,
    };
    state.pending.add(op);
    op.timer = setTimeout(() => {
      cancelPending(op, "restore-timeout");
    }, state.restoreTimeoutMs);

    // A synchronous restore can dispatch SSTabRestored before duplicateTab
    // returns. The window listener records that, so this branch is safe.
    if (state.restoredTabs.has(copy)) {
      finalizePending(op);
    }

    return copy;
  }

  function cleanupAfterProtectedDrop(dnd, source) {
    try {
      dnd.clearDragOverVisuals?.();
    } catch (error) {
      state.warnings.push(`drop-cleanup-visuals: ${error}`);
    }
    try {
      dnd._resetTabsAfterDrop?.(source);
    } catch (error) {
      state.warnings.push(`drop-cleanup-tabs: ${error}`);
    }
    try {
      if (dnd._tabDropIndicator) dnd._tabDropIndicator.hidden = true;
    } catch (error) {
      state.warnings.push(`drop-cleanup-indicator: ${error}`);
    }
  }

  /**
   * Replace the tab strip's drop handler for one window.
   * @returns {boolean} false when the expected Zen internals are missing.
   */
  function detachMembers(win, contextTab) {
    const gBrowser = win?.gBrowser;
    let movingTabs;
    try {
      movingTabs = contextTab?.multiselected
        ? gBrowser?.selectedElements ?? gBrowser?.selectedTabs ?? []
        : [contextTab];
    } catch {
      movingTabs = [contextTab];
    }
    return collectMovingTabs(win, contextTab, movingTabs);
  }

  function installDropHook(win) {
    const dnd = win?.gBrowser?.tabContainer?.tabDragAndDrop;
    if (!dnd || typeof dnd.handle_drop !== "function") return false;
    if (typeof win.gBrowser.replaceTabsWithWindow !== "function") return false;
    if (dnd[DROP_HOOK]) return true;

    const original = dnd.handle_drop;
    const originalReplaceTabsWithWindow =
      win.gBrowser.replaceTabsWithWindow;
    const restoredListener = event => {
      const tab = event?.target;
      if (!tab) return;
      state.restoredTabs.add(tab);
      for (const op of [...state.pending]) {
        if (op.win === win && op.copy === tab) finalizePending(op);
      }
    };
    const unloadListener = () => {
      cancelPendingForWindow(win, "window-unloaded");
      detachWindow(win);
    };

    try {
      win.addEventListener("SSTabRestored", restoredListener, true);
      win.addEventListener("unload", unloadListener, { once: true });
    } catch (error) {
      state.warnings.push(`drop-restore-listener: ${error}`);
      try {
        win.removeEventListener("SSTabRestored", restoredListener, true);
      } catch {}
      return false;
    }

    const patched = function (event) {
      if (!state.installed || !state.enabled || !state.locked) {
        return original.call(this, event);
      }

      const plan = planDrop(win, this, event);
      if (plan.action === "native") {
        return original.call(this, event);
      }

      try {
        event.preventDefault();
        event.stopPropagation();
      } catch (error) {
        state.warnings.push(`drop-event: ${error}`);
      }

      if (plan.action === "duplicate") {
        duplicateTabForDrop(win, this, plan);
      } else {
        state.warnings.push(`drop-blocked:${plan.reason ?? "unsafe"}`);
      }

      cleanupAfterProtectedDrop(this, plan.source);
      return undefined;
    };

    const patchedReplaceTabsWithWindow = function (contextTab, options) {
      if (!state.installed || !state.enabled || !state.locked) {
        return originalReplaceTabsWithWindow.call(this, contextTab, options);
      }
      const collection = detachMembers(win, contextTab);
      if (collection.uncertain) {
        state.warnings.push(
          `detach-blocked:uncertain-members:${collection.uncertain}`
        );
        return null;
      }
      if (
        collection.tabs.some(tab => isProtected(readTabFlags(tab)))
      ) {
        state.warnings.push("detach-blocked:protected-tab");
        return null;
      }
      return originalReplaceTabsWithWindow.call(
        this,
        contextTab,
        options
      );
    };

    Object.defineProperty(dnd, DROP_HOOK, {
      value: {
        original,
        patched,
        restoredListener,
        unloadListener,
        originalReplaceTabsWithWindow,
        patchedReplaceTabsWithWindow,
      },
      configurable: true,
      writable: false,
      enumerable: false,
    });
    dnd.handle_drop = patched;
    win.gBrowser.replaceTabsWithWindow = patchedReplaceTabsWithWindow;
    return true;
  }

  function removeDropHook(win) {
    const dnd = win?.gBrowser?.tabContainer?.tabDragAndDrop;
    const hook = dnd?.[DROP_HOOK];
    if (!hook) return;
    cancelPendingForWindow(win, "window-detached");
    try {
      if (hook.restoredListener) {
        win.removeEventListener(
          "SSTabRestored",
          hook.restoredListener,
          true
        );
      }
      if (hook.unloadListener) {
        win.removeEventListener("unload", hook.unloadListener);
      }
      dnd.handle_drop = hook.original;
      if (hook.originalReplaceTabsWithWindow) {
        win.gBrowser.replaceTabsWithWindow =
          hook.originalReplaceTabsWithWindow;
      }
      delete dnd[DROP_HOOK];
    } catch (error) {
      state.warnings.push(`drop-unhook: ${error}`);
    }
  }

  function guardActive(win) {
    if (!win || win.closed === true) return false;
    if (win.gZenStartup?.isReady !== true) return false;
    try {
      if (Services.startup?.shuttingDown) return false;
    } catch {
      // Ignore a missing startup service; the other checks still apply.
    }
    try {
      if (win.gZenWorkspaces?._isClosingWindow) return false;
    } catch {
      // Ignore transient Zen state.
    }
    return true;
  }

  function authorizedFor(tab, action) {
    const auth = state.authorization;
    return Boolean(auth && auth.tab === tab && auth.actions.has(action));
  }

  function withAuthorization(tab, actions, callback) {
    const previous = state.authorization;
    state.authorization = { tab, actions: new Set(actions) };
    try {
      return callback();
    } finally {
      state.authorization = previous;
    }
  }

  function canPerform(win, tab, action) {
    if (!state.locked) return true;
    if (!guardActive(win) || !tab || tab.closing === true) return true;
    if (authorizedFor(tab, action)) return true;
    return (
      decideAction({
        tab: readTabFlags(tab),
        action,
        locked: true,
      }) !== "block"
    );
  }

  function resolveEssentialsTargets(win, tab) {
    if (tab) return Array.isArray(tab) ? tab : [tab];
    const contextTab = win?.TabContextMenu?.contextTab;
    if (!contextTab) return [];
    return contextTab.multiselected
      ? [...win.gBrowser.selectedTabs]
      : [contextTab];
  }

  function performIntentionalAction(tab, action) {
    if (!state.installed || !state.enabled) {
      return { status: "disabled" };
    }
    if (!state.locked) return { status: "unlocked" };
    const win = tab?.documentGlobal ?? browserWindows()[0];
    if (!win || !tab) return { status: "missing-tab" };

    const flags = readTabFlags(tab);
    if (!isProtected(flags)) return { status: "not-protected" };
    if (action === "unpin" && (!flags.pinned || flags.essential)) {
      return { status: "wrong-zone" };
    }
    if (action === "remove-essential" && !flags.essential) {
      return { status: "wrong-zone" };
    }
    if (action !== "unpin" && action !== "remove-essential") {
      return { status: "unsupported-action" };
    }

    try {
      if (action === "unpin") {
        withAuthorization(tab, ["unpin"], () => {
          win.gBrowser.unpinTab(tab);
        });
      } else {
        withAuthorization(
          tab,
          ["remove-essential", "unpin"],
          () => {
            win.gZenPinnedTabManager.removeEssentials(tab);
          }
        );
      }
    } catch (error) {
      state.warnings.push(`intentional-action:${action}:${error}`);
      return {
        status: "error",
        error: String(error),
        zone: zoneOf(readTabFlags(tab)),
      };
    }

    const zone = zoneOf(readTabFlags(tab));
    if (zone !== "normal") {
      return { status: "unchanged", zone };
    }
    return {
      status: action === "unpin" ? "unpinned" : "removed-essential",
      zone,
    };
  }

  function warnBlocked(action, tabs) {
    const ids = (Array.isArray(tabs) ? tabs : [tabs])
      .filter(Boolean)
      .map(tab => tab.id || "unknown")
      .join(",");
    state.warnings.push(`tab-action-blocked:${action}:${ids}`);
  }

  /**
   * Guard close, unpin, and Essential-removal entry points.
   * @returns {boolean} false when required internals are missing.
   */
  function installCloseHook(win) {
    const gBrowser = win?.gBrowser;
    const manager = win?.gZenPinnedTabManager;
    if (!gBrowser || !manager) return false;
    if (gBrowser[CLOSE_HOOK]) return true;

    for (const method of ["removeTab", "removeTabs", "removeCurrentTab", "unpinTab"]) {
      if (typeof gBrowser[method] !== "function") return false;
    }
    if (typeof manager.removeEssentials !== "function") return false;

    const originals = {
      removeTab: gBrowser.removeTab,
      removeTabs: gBrowser.removeTabs,
      removeCurrentTab: gBrowser.removeCurrentTab,
      unpinTab: gBrowser.unpinTab,
      removeEssentials: manager.removeEssentials,
      removeTabGroup:
        typeof gBrowser.removeTabGroup === "function"
          ? gBrowser.removeTabGroup
          : null,
    };

    gBrowser.removeTab = function (tab, options) {
      if (!canPerform(win, tab, "close")) {
        warnBlocked("close", tab);
        return undefined;
      }
      return originals.removeTab.call(this, tab, options);
    };

    gBrowser.removeTabs = function (tabs, options) {
      const list = Array.from(tabs ?? []);
      const allowed = list.filter(tab => canPerform(win, tab, "close"));
      if (allowed.length === list.length) {
        return originals.removeTabs.call(this, tabs, options);
      }
      warnBlocked(
        "close",
        list.filter(tab => !allowed.includes(tab))
      );
      if (!allowed.length) return undefined;
      return originals.removeTabs.call(this, allowed, options);
    };

    gBrowser.removeCurrentTab = function (options) {
      const tab = this.selectedTab;
      if (!canPerform(win, tab, "close")) {
        warnBlocked("close", tab);
        return undefined;
      }
      return originals.removeCurrentTab.call(this, options);
    };

    gBrowser.unpinTab = function (tab, options) {
      if (!canPerform(win, tab, "unpin")) {
        warnBlocked("unpin", tab);
        return undefined;
      }
      return originals.unpinTab.call(this, tab, options);
    };

    manager.removeEssentials = function (tab, unpin = true) {
      const targets = resolveEssentialsTargets(win, tab);
      const blocked = targets.filter(
        targetTab => !canPerform(win, targetTab, "remove-essential")
      );
      if (blocked.length) {
        warnBlocked("remove-essential", blocked);
        return undefined;
      }
      return originals.removeEssentials.call(this, tab, unpin);
    };

    if (originals.removeTabGroup) {
      gBrowser.removeTabGroup = function (group, options) {
        const tabs = Array.from(group?.tabs ?? []);
        const blocked = tabs.filter(
          tab => !canPerform(win, tab, "close")
        );
        if (blocked.length) {
          warnBlocked("close-group", blocked);
          return Promise.resolve();
        }
        return originals.removeTabGroup.call(this, group, options);
      };
    }

    Object.defineProperty(gBrowser, CLOSE_HOOK, {
      value: { originals, manager },
      configurable: true,
      writable: false,
      enumerable: false,
    });
    return true;
  }

  function removeCloseHook(win) {
    const gBrowser = win?.gBrowser;
    const hook = gBrowser?.[CLOSE_HOOK];
    if (!hook) return;
    try {
      gBrowser.removeTab = hook.originals.removeTab;
      gBrowser.removeTabs = hook.originals.removeTabs;
      gBrowser.removeCurrentTab = hook.originals.removeCurrentTab;
      gBrowser.unpinTab = hook.originals.unpinTab;
      if (hook.originals.removeTabGroup) {
        gBrowser.removeTabGroup = hook.originals.removeTabGroup;
      }
      hook.manager.removeEssentials = hook.originals.removeEssentials;
      delete gBrowser[CLOSE_HOOK];
    } catch (error) {
      state.warnings.push(`close-unhook: ${error}`);
    }
  }

  const MANAGED_MENU_ITEMS = Object.freeze([
    "context_closeTab",
    "context_unpinTab",
    "context_unpinSelectedTabs",
    "context_zen-remove-essential",
  ]);
  const UNPIN_ITEM_ID = "context_svalinn-unpin";
  const REMOVE_ITEM_ID = "context_svalinn-remove-essential";
  const LOCK_ITEM_ID = "context_svalinn-protect";
  const LOCK_SEPARATOR_ID = "context_svalinn-protect-separator";

  function lockItemLabel() {
    return state.locked
      ? "Protect Pinned & Essentials"
      : "Protect Pinned & Essentials (currently unlocked)";
  }

  function syncLockMenuItem(doc) {
    const item = doc?.getElementById?.(LOCK_ITEM_ID);
    if (!item) return;
    item.checked = state.locked;
    item.setAttribute("checked", String(state.locked));
    item.setAttribute("aria-checked", String(state.locked));
    item.setAttribute("label", lockItemLabel());
  }

  function updateContextMenu(win) {
    const doc = win?.document;
    if (!doc) return;

    for (const id of MANAGED_MENU_ITEMS) {
      doc.getElementById(id)?.removeAttribute(MENU_BLOCK_ATTR);
    }

    const contextTab = win?.TabContextMenu?.contextTab;
    const contextTabs = win?.TabContextMenu?.contextTabs ?? [];
    const multiselected =
      Boolean(win?.TabContextMenu?.multiselected) || contextTabs.length > 1;
    const flags = contextTab ? readTabFlags(contextTab) : null;
    const protectedContext = Boolean(flags && isProtected(flags));
    const protectedSelected = contextTabs.some(tab =>
      isProtected(readTabFlags(tab))
    );

    const lockItem = doc.getElementById(LOCK_ITEM_ID);
    const separator = doc.getElementById(LOCK_SEPARATOR_ID);
    const showLock = protectedContext || protectedSelected;
    if (lockItem) {
      lockItem.hidden = !showLock;
      syncLockMenuItem(doc);
    }
    if (separator) separator.hidden = !showLock;

    const unpinItem = doc.getElementById(UNPIN_ITEM_ID);
    const removeItem = doc.getElementById(REMOVE_ITEM_ID);
    if (unpinItem) {
      unpinItem.hidden = !(
        state.locked &&
        !multiselected &&
        flags &&
        flags.pinned &&
        !flags.essential
      );
    }
    if (removeItem) {
      removeItem.hidden = !(state.locked && !multiselected && flags?.essential);
    }

    // Unlocked means native Zen behavior: never hide native actions or show
    // Svalinn's intentional-removal duplicates.
    if (!state.locked) return;

    if (!protectedContext && !protectedSelected) return;

    if (protectedContext) {
      doc.getElementById("context_closeTab")?.setAttribute(
        MENU_BLOCK_ATTR,
        "true"
      );
    }
    if (protectedContext && flags?.pinned) {
      doc.getElementById("context_unpinTab")?.setAttribute(
        MENU_BLOCK_ATTR,
        "true"
      );
    }
    if (protectedSelected) {
      doc.getElementById("context_unpinSelectedTabs")?.setAttribute(
        MENU_BLOCK_ATTR,
        "true"
      );
    }
    if (protectedContext && flags?.essential) {
      doc.getElementById("context_zen-remove-essential")?.setAttribute(
        MENU_BLOCK_ATTR,
        "true"
      );
    }
  }

  /**
   * Add explicit per-tab unpin/remove commands and keep destructive native
   * commands visually unavailable without mutating Zen's hidden/disabled state.
   */
  function installContextMenuHook(win) {
    const doc = win?.document;
    const menu = doc?.getElementById?.("tabContextMenu");
    if (!doc || !menu) return false;
    if (menu[CONTEXT_HOOK]) return true;

    let style = doc.getElementById("svalinn-menu-style");
    if (!style) {
      style = doc.createElement("style");
      style.id = "svalinn-menu-style";
      style.textContent =
        '#tabContextMenu [svalinn-blocked="true"] { display: none !important; }';
      doc.documentElement.appendChild(style);
    }

    const makeItem = (id, label) => {
      let item = doc.getElementById(id);
      if (!item) {
        item = doc.createXULElement
          ? doc.createXULElement("menuitem")
          : doc.createElement("menuitem");
        item.id = id;
        item.setAttribute("label", label);
        item.setAttribute("hidden", "true");
        const anchor =
          doc.getElementById("context_zen-remove-essential") ??
          doc.getElementById("context_pinTab");
        if (anchor?.after) anchor.after(item);
        else menu.appendChild(item);
      }
      return item;
    };

    const unpinItem = makeItem(UNPIN_ITEM_ID, "Unpin This Pinned Tab");
    const removeItem = makeItem(
      REMOVE_ITEM_ID,
      "Remove This Tab from Essentials"
    );

    let separator = doc.getElementById(LOCK_SEPARATOR_ID);
    if (!separator) {
      separator = doc.createXULElement
        ? doc.createXULElement("menuseparator")
        : doc.createElement("menuseparator");
      separator.id = LOCK_SEPARATOR_ID;
      separator.setAttribute("hidden", "true");
      menu.appendChild(separator);
    }
    let lockItem = doc.getElementById(LOCK_ITEM_ID);
    if (!lockItem) {
      lockItem = doc.createXULElement
        ? doc.createXULElement("menuitem")
        : doc.createElement("menuitem");
      lockItem.id = LOCK_ITEM_ID;
      lockItem.setAttribute("type", "checkbox");
      lockItem.setAttribute("label", lockItemLabel());
      lockItem.setAttribute("checked", String(state.locked));
      lockItem.setAttribute("hidden", "true");
      lockItem.checked = state.locked;
      menu.appendChild(lockItem);
    }

    const onUnpin = () => {
      performIntentionalAction(win.TabContextMenu?.contextTab, "unpin");
      try {
        menu.hidePopup?.();
      } catch {
        // Menu may already be closed.
      }
    };
    const onRemove = () => {
      performIntentionalAction(
        win.TabContextMenu?.contextTab,
        "remove-essential"
      );
      try {
        menu.hidePopup?.();
      } catch {
        // Menu may already be closed.
      }
    };
    const onToggleLock = () => {
      setLocked(!state.locked);
      updateContextMenu(win);
    };
    const onShowing = event => {
      if (event?.target?.id === "tabContextMenu") updateContextMenu(win);
    };

    unpinItem.addEventListener("command", onUnpin);
    removeItem.addEventListener("command", onRemove);
    lockItem.addEventListener("command", onToggleLock);
    menu.addEventListener("popupshowing", onShowing);

    Object.defineProperty(menu, CONTEXT_HOOK, {
      value: {
        style,
        unpinItem,
        removeItem,
        lockItem,
        separator,
        onUnpin,
        onRemove,
        onToggleLock,
        onShowing,
      },
      configurable: true,
      writable: false,
      enumerable: false,
    });
    return true;
  }

  function removeContextMenuHook(win) {
    const doc = win?.document;
    const menu = doc?.getElementById?.("tabContextMenu");
    const hook = menu?.[CONTEXT_HOOK];
    if (!hook) return;
    try {
      menu.removeEventListener("popupshowing", hook.onShowing);
      hook.unpinItem?.removeEventListener("command", hook.onUnpin);
      hook.removeItem?.removeEventListener("command", hook.onRemove);
      hook.lockItem?.removeEventListener("command", hook.onToggleLock);
      hook.unpinItem?.remove();
      hook.removeItem?.remove();
      hook.lockItem?.remove();
      hook.separator?.remove();
      for (const id of MANAGED_MENU_ITEMS) {
        doc.getElementById(id)?.removeAttribute(MENU_BLOCK_ATTR);
      }
      hook.style?.remove();
      delete menu[CONTEXT_HOOK];
    } catch (error) {
      state.warnings.push(`context-menu-unhook: ${error}`);
    }
  }

  function setActiveMarker(win, active) {
    try {
      win?.document?.documentElement?.toggleAttribute?.(
        ACTIVE_ATTR,
        Boolean(active)
      );
    } catch (error) {
      state.warnings.push(`active-marker: ${error}`);
    }
  }

  function setLockMarker(win) {
    try {
      win?.document?.documentElement?.toggleAttribute?.(
        UNLOCKED_ATTR,
        !state.locked
      );
    } catch (error) {
      state.warnings.push(`lock-marker: ${error}`);
    }
  }

  function syncWindowLock(win) {
    setLockMarker(win);
    updateContextMenu(win);
  }

  /**
   * Change the single global protection state.
   *
   * The preference is written before any window changes. If a window cannot be
   * synchronized, both the preference and every window are reverted so the UI
   * never claims a state the guards do not enforce.
   */
  function setLocked(value) {
    if (!state.installed || !state.enabled) {
      return report("not-installed", {
        locked: state.locked,
        changedTabs: false,
      });
    }

    const next = Boolean(value);
    if (next === state.locked) {
      try {
        for (const win of browserWindows()) syncWindowLock(win);
      } catch (error) {
        state.warnings.push(`lock-sync: ${error}`);
        return report("error", {
          reason: "lock-sync",
          locked: state.locked,
          changedTabs: false,
          error: String(error),
        });
      }
      return report(next ? "locked" : "unlocked", {
        locked: next,
        changedTabs: false,
      });
    }

    const previous = state.locked;
    try {
      persistLocked(next);
    } catch (error) {
      state.warnings.push(`lock-pref: ${error}`);
      return report("error", {
        reason: "lock-pref",
        locked: previous,
        changedTabs: false,
        error: String(error),
      });
    }

    if (!next) cancelAllPending("unlocked");
    state.locked = next;

    try {
      for (const win of browserWindows()) syncWindowLock(win);
    } catch (error) {
      state.locked = previous;
      try {
        persistLocked(previous);
      } catch (persistError) {
        state.warnings.push(`lock-pref-revert: ${persistError}`);
      }
      for (const win of browserWindows()) {
        try {
          syncWindowLock(win);
        } catch {}
      }
      state.warnings.push(`lock-sync: ${error}`);
      return report("error", {
        reason: "lock-sync",
        locked: previous,
        changedTabs: false,
        error: String(error),
      });
    }

    if (!next) cancelAllPending("unlocked");

    return report(next ? "locked" : "unlocked", {
      locked: next,
      changedTabs: false,
    });
  }

  function toggleLocked() {
    return setLocked(!state.locked);
  }

  function attachWindow(win) {
    if (!win || win.closed) return false;
    if (!installDropHook(win)) {
      state.warnings.push("drop-hook-unavailable");
      return false;
    }
    if (!installCloseHook(win)) {
      state.warnings.push("close-hook-unavailable");
      removeDropHook(win);
      return false;
    }
    if (!installContextMenuHook(win)) {
      state.warnings.push("context-menu-unavailable");
    }
    try {
      Object.defineProperty(win, MARKER, {
        value: api,
        configurable: true,
        writable: true,
        enumerable: false,
      });
    } catch {
      try {
        win[MARKER] = api;
      } catch (error) {
        state.warnings.push(`window-attach: ${error}`);
        removeContextMenuHook(win);
        removeCloseHook(win);
        removeDropHook(win);
        return false;
      }
    }
    state.windows.add(win);
    setActiveMarker(win, true);
    try {
      syncWindowLock(win);
    } catch (error) {
      state.warnings.push(`lock-sync: ${error}`);
    }
    return true;
  }

  function detachWindow(win) {
    setActiveMarker(win, false);
    try {
      win?.document?.documentElement?.removeAttribute?.(UNLOCKED_ATTR);
    } catch (error) {
      state.warnings.push(`lock-marker: ${error}`);
    }
    removeContextMenuHook(win);
    removeCloseHook(win);
    removeDropHook(win);
    try {
      delete win[MARKER];
    } catch (error) {
      state.warnings.push(`window-detach: ${error}`);
    }
    state.windows.delete(win);
  }

  function addWindowObserver() {
    if (state.observer) return;
    const observer = {
      observe(subject, topic) {
        if (topic !== "domwindowopened" || !state.installed) return;
        try {
          subject.addEventListener(
            "load",
            () => {
              if (state.installed) attachWindow(subject);
            },
            { once: true }
          );
        } catch (error) {
          state.warnings.push(`window-observer: ${error}`);
        }
      },
    };
    try {
      Services.obs.addObserver(observer, "domwindowopened");
      state.observer = observer;
    } catch (error) {
      state.warnings.push(`window-observer-unavailable: ${error}`);
    }
  }

  function removeWindowObserver() {
    if (!state.observer) return;
    try {
      Services.obs.removeObserver(state.observer, "domwindowopened");
    } catch (error) {
      state.warnings.push(`window-observer-removal: ${error}`);
    }
    state.observer = null;
  }

  function report(status, extra = {}) {
    return {
      status,
      adapter: ADAPTER_VERSION,
      installed: state.installed,
      enabled: state.enabled,
      locked: state.locked,
      dragBehavior: state.dragBehavior,
      windows: state.windows.size,
      pending: state.pending.size,
      capabilities: state.capabilities,
      warnings: [...state.warnings],
      ...extra,
    };
  }

  function probe({ allowUnverifiedVersion = false } = {}) {
    return probeCapabilities(browserWindows()[0] ?? null, {
      allowUnverifiedVersion,
    });
  }

  async function install(options = {}) {
    const {
      enabled,
      locked = null,
      waitForStartup = true,
      timeoutMs = 30_000,
      restoreTimeoutMs = 10_000,
      dragBehavior = null,
      allowUnverifiedVersion = false,
    } = options;

    if (state.installed) {
      return report("already-installed", { changedTabs: false });
    }

    state.enabled = enabled ?? prefEnabled();
    state.locked = locked === null ? prefLocked() : Boolean(locked);
    state.capabilities = null;
    state.restoreTimeoutMs = restoreTimeoutMs;
    state.dragBehavior = normalizeDragBehavior(
      dragBehavior ?? prefDragBehavior()
    );
    state.warnings.length = 0;
    cancelAllPending("reinstall");
    state.restoredTabs = new WeakSet();

    if (!state.enabled) {
      return report("disabled", { changedTabs: false });
    }

    const windows = browserWindows();
    if (!windows.length) {
      return report("not-ready", {
        reason: "no-browser-window",
        changedTabs: false,
      });
    }

    state.capabilities = probeCapabilities(windows[0], {
      allowUnverifiedVersion,
    });
    if (!state.capabilities.ok) {
      return report("unsupported", {
        reason: "capability-check-failed",
        changedTabs: false,
      });
    }

    if (waitForStartup) {
      try {
        await Promise.all(
          windows.map(win => waitForWindowReady(win, timeoutMs))
        );
      } catch (error) {
        return report("not-ready", {
          reason: "startup-timeout",
          error: String(error),
          changedTabs: false,
        });
      }
    }

    const attached = [];
    for (const win of browserWindows()) {
      if (!attachWindow(win)) {
        for (const done of attached) detachWindow(done);
        return report("unsupported", {
          reason: "window-hook-install-failed",
          changedTabs: false,
        });
      }
      attached.push(win);
    }
    addWindowObserver();
    state.installed = true;

    return report("installed", { changedTabs: false });
  }

  function uninstall() {
    state.authorization = null;
    cancelAllPending("uninstall");
    removeWindowObserver();
    for (const win of [...state.windows]) detachWindow(win);
    state.windows.clear();
    state.installed = false;
    state.enabled = false;
    return report("uninstalled", { changedTabs: false });
  }

  function setEnabled(value) {
    return value ? install({ enabled: true }) : uninstall();
  }

  function snapshot() {
    const wins = browserWindows();
    const windows = snapshotWindows(wins);
    for (let index = 0; index < windows.length; index += 1) {
      windows[index].hooked = Boolean(
        wins[index]?.gBrowser?.tabContainer?.tabDragAndDrop?.[DROP_HOOK]
      );
      windows[index].closeHooked = Boolean(
        wins[index]?.gBrowser?.[CLOSE_HOOK]
      );
    }
    return {
      adapter: ADAPTER_VERSION,
      installed: state.installed,
      enabled: state.enabled,
      locked: state.locked,
      dragBehavior: state.dragBehavior,
      windows,
      warnings: [...state.warnings],
      pending: state.pending.size,
    };
  }

  function pendingDuplications() {
    return state.pending.size;
  }

  function hookedWindows() {
    return browserWindows().filter(win =>
      Boolean(win?.gBrowser?.tabContainer?.tabDragAndDrop?.[DROP_HOOK])
    ).length;
  }

  function closeGuardedWindows() {
    return browserWindows().filter(win => Boolean(win?.gBrowser?.[CLOSE_HOOK]))
      .length;
  }

  function classify(tab) {
    return describeTab(tab);
  }

  const api = {
    version: ADAPTER_VERSION,
    marker: MARKER,
    probe,
    install,
    uninstall,
    setEnabled,
    snapshot,
    hookedWindows,
    closeGuardedWindows,
    pendingDuplications,
    performIntentionalAction,
    setDragBehavior,
    dragBehavior: () => state.dragBehavior,
    setLocked,
    toggleLocked,
    locked: () => state.locked,
    classify,
    policy: {
      ZONES,
      zoneOf,
      isProtected,
      decideAction,
      decideDrop,
    },
  };

  globalThis.Svalinn = api;
})();
