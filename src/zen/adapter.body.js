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

  const ADAPTER_VERSION = "0.3.0";
  const MARKER = "__svalinn";
  const DROP_HOOK = "__svalinnDropHook";
  const CLOSE_HOOK = "__svalinnCloseHook";
  const ENABLED_PREF = "svalinn.enabled";

  const state = {
    installed: false,
    enabled: null,
    windows: new Set(),
    observer: null,
    capabilities: null,
    warnings: [],
    pending: new Set(),
    restoredTabs: new WeakSet(),
    restoreTimeoutMs: 10_000,
    bypass: 0,
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

  /**
   * Classify a drop before Zen mutates anything.
   *
   * - NATIVE: deliberately unsupported or non-protected case; delegate.
   * - DUPLICATE: protected cross-zone move; copy instead of demoting.
   * - BLOCK: protected in-scope move whose target/plan cannot be trusted.
   */
  function planDrop(win, dnd, event) {
    let source = null;
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
      if (!source || source.documentGlobal !== win) {
        return { action: "native" };
      }
      if (!win.gBrowser?.isTab?.(source)) return { action: "native" };

      const movingTabs = source._dragData?.movingTabs;
      if (
        !Array.isArray(movingTabs) ||
        movingTabs.length !== 1 ||
        movingTabs[0] !== source
      ) {
        return { action: "native" };
      }
    } catch (error) {
      return { action: "native" };
    }

    // From here the drop belongs to a protected-tab lifecycle. If anything is
    // unclear, fail closed instead of letting native demote the source.
    try {
      const flags = readTabFlags(source);
      if (!isProtected(flags)) return { action: "native" };

      const targetZone = zoneFromTarget(event.target);
      if (!targetZone) {
        return {
          action: "block",
          source,
          reason: "unknown-target",
        };
      }

      const decision = decideDrop({
        tab: flags,
        targetZone,
        sameWindow: true,
        locked: true,
      });
      if (decision === "native") return { action: "native" };
      if (decision !== "duplicate") {
        return {
          action: "block",
          source,
          reason: `unsupported-decision:${decision}`,
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

    withBypass(() => {
      if (targetZone === ZONES.NORMAL) {
        if (copy.hasAttribute("zen-essential")) {
          manager.removeEssentials(copy);
        } else if (copy.pinned) {
          gBrowser.unpinTab(copy);
        }
      } else if (targetZone === ZONES.PINNED) {
        if (copy.hasAttribute("zen-essential")) {
          manager.removeEssentials(copy, false);
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
    });

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
        withBypass(() => {
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
  function installDropHook(win) {
    const dnd = win?.gBrowser?.tabContainer?.tabDragAndDrop;
    if (!dnd || typeof dnd.handle_drop !== "function") return false;
    if (dnd[DROP_HOOK]) return true;

    const original = dnd.handle_drop;
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
      if (!state.installed || !state.enabled) {
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

    Object.defineProperty(dnd, DROP_HOOK, {
      value: { original, patched, restoredListener, unloadListener },
      configurable: true,
      writable: false,
      enumerable: false,
    });
    dnd.handle_drop = patched;
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
      delete dnd[DROP_HOOK];
    } catch (error) {
      state.warnings.push(`drop-unhook: ${error}`);
    }
  }

  function withBypass(callback) {
    state.bypass += 1;
    try {
      return callback();
    } finally {
      state.bypass -= 1;
    }
  }

  function guardActive(win) {
    if (state.bypass > 0) return false;
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

  function shouldBlock(win, tab, action) {
    if (!guardActive(win) || !tab || tab.closing === true) return false;
    return (
      decideAction({
        tab: readTabFlags(tab),
        action,
        locked: true,
      }) === "block"
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
      if (shouldBlock(win, tab, "close")) {
        warnBlocked("close", tab);
        return undefined;
      }
      return originals.removeTab.call(this, tab, options);
    };

    gBrowser.removeTabs = function (tabs, options) {
      const list = Array.from(tabs ?? []);
      const allowed = list.filter(tab => !shouldBlock(win, tab, "close"));
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
      if (shouldBlock(win, tab, "close")) {
        warnBlocked("close", tab);
        return undefined;
      }
      return originals.removeCurrentTab.call(this, options);
    };

    gBrowser.unpinTab = function (tab, options) {
      if (shouldBlock(win, tab, "unpin")) {
        warnBlocked("unpin", tab);
        return undefined;
      }
      return originals.unpinTab.call(this, tab, options);
    };

    manager.removeEssentials = function (tab, unpin = true) {
      const targets = resolveEssentialsTargets(win, tab);
      const blocked = targets.filter(targetTab =>
        shouldBlock(win, targetTab, "remove-essential")
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
        const blocked = tabs.filter(tab => shouldBlock(win, tab, "close"));
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
        removeCloseHook(win);
        removeDropHook(win);
        return false;
      }
    }
    state.windows.add(win);
    return true;
  }

  function detachWindow(win) {
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
      waitForStartup = true,
      timeoutMs = 30_000,
      restoreTimeoutMs = 10_000,
      allowUnverifiedVersion = false,
    } = options;

    if (state.installed) {
      return report("already-installed", { changedTabs: false });
    }

    state.enabled = enabled ?? prefEnabled();
    state.capabilities = null;
    state.restoreTimeoutMs = restoreTimeoutMs;
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
