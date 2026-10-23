/**
 * Svalinn's browser-side adapter.
 *
 * This file is concatenated after `src/policy.mjs` and the `src/zen/*` helper
 * modules by `src/zen/build.mjs`, then evaluated in Zen's chrome context by the
 * smoke harness. It contains no imports. It installs a tab-strip drop guard
 * that duplicates protected tabs on cross-zone drops; close, unpin, and
 * Essential-removal interception belong to later issues.
 */
(() => {
  "use strict";

  const ADAPTER_VERSION = "0.2.0";
  const MARKER = "__svalinn";
  const DROP_HOOK = "__svalinnDropHook";
  const ENABLED_PREF = "svalinn.enabled";

  const state = {
    installed: false,
    enabled: null,
    windows: new Set(),
    observer: null,
    capabilities: null,
    warnings: [],
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
   * Decide whether this drop should duplicate a protected tab.
   * Read-only: returns null whenever Zen should keep its native behavior.
   */
  function planProtectedDrop(win, dnd, event) {
    try {
      const dataTransfer = event?.dataTransfer;
      if (!dataTransfer || dataTransfer.dropEffect !== "move") return null;

      const dropType =
        win.TAB_DROP_TYPE ?? "application/x-moz-tabbrowser-tab";
      const types = dataTransfer.mozTypesAt?.(0);
      if (!types || types[0] !== dropType) return null;

      const source = dataTransfer.mozGetDataAt(dropType, 0);
      if (!source || source.documentGlobal !== win) return null;
      if (!win.gBrowser?.isTab?.(source)) return null;

      const movingTabs = source._dragData?.movingTabs;
      if (
        !Array.isArray(movingTabs) ||
        movingTabs.length !== 1 ||
        movingTabs[0] !== source
      ) {
        return null;
      }

      const targetZone = zoneFromTarget(event.target);
      if (!targetZone) return null;

      const decision = decideDrop({
        tab: readTabFlags(source),
        targetZone,
        sameWindow: true,
        locked: true,
      });
      if (decision !== "duplicate") return null;

      const dropIndex =
        typeof dnd?._getDropIndex === "function"
          ? dnd._getDropIndex(event)
          : null;
      const elements = dnd?._tabbrowserTabs?.dragAndDropElements;
      const dropTarget =
        Array.isArray(elements) && Number.isInteger(dropIndex)
          ? elements[dropIndex] ?? null
          : null;

      return { source, targetZone, dropIndex, dropTarget };
    } catch (error) {
      state.warnings.push(`drop-plan: ${error}`);
      return null;
    }
  }

  function applyZone(copy, targetZone, win) {
    const gBrowser = win.gBrowser;
    const manager = win.gZenPinnedTabManager;

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

    const actual = zoneOf(readTabFlags(copy));
    if (actual !== targetZone) {
      throw new Error(`duplicated tab stayed in zone ${actual}`);
    }
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

    let finished = false;
    const discard = reason => {
      state.warnings.push(`drop-duplicate: ${reason}`);
      try {
        gBrowser.removeTab(copy, { animate: false });
      } catch (cleanupError) {
        state.warnings.push(`drop-cleanup: ${cleanupError}`);
      }
    };

    const finalize = () => {
      if (finished) return;
      finished = true;
      try {
        applyZone(copy, plan.targetZone, win);

        const target =
          plan.dropTarget && plan.dropTarget !== copy
            ? plan.dropTarget
            : null;

        if (target) {
          gBrowser.moveTabsBefore([copy], target);
        } else {
          const lastIndex = Math.max(0, gBrowser.tabs.length - 1);
          const elementIndex = Number.isInteger(plan.dropIndex)
            ? Math.min(Math.max(plan.dropIndex, 0), lastIndex)
            : lastIndex;
          gBrowser.moveTabTo(copy, { elementIndex });
        }

        gBrowser.selectedTab = copy;
      } catch (error) {
        discard(error);
      }
    };

    if (typeof copy.addEventListener === "function") {
      copy.addEventListener("SSTabRestored", finalize, { once: true });
    }

    if (copy.id) {
      finalize();
      return copy;
    }

    // SessionStore restores duplicated tabs asynchronously and overwrites
    // their category while doing so. Apply the requested zone only after the
    // tab has an id; otherwise the copy can silently fall back to Normal.
    const deadline = Date.now() + 10_000;
    const poll = () => {
      if (finished) return;
      if (copy.id) {
        finalize();
        return;
      }
      if (Date.now() >= deadline) {
        finished = true;
        discard("restore-timeout");
        return;
      }
      setTimeout(poll, 50);
    };
    setTimeout(poll, 50);
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
    const patched = function (event) {
      if (!state.installed || !state.enabled) {
        return original.call(this, event);
      }

      const plan = planProtectedDrop(win, this, event);
      if (!plan) {
        return original.call(this, event);
      }

      try {
        event.preventDefault();
        event.stopPropagation();
      } catch (error) {
        state.warnings.push(`drop-event: ${error}`);
      }

      duplicateTabForDrop(win, this, plan);
      cleanupAfterProtectedDrop(this, plan.source);
      return undefined;
    };

    Object.defineProperty(dnd, DROP_HOOK, {
      value: { original, patched },
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
    try {
      dnd.handle_drop = hook.original;
      delete dnd[DROP_HOOK];
    } catch (error) {
      state.warnings.push(`drop-unhook: ${error}`);
    }
  }

  function attachWindow(win) {
    if (!win || win.closed) return false;
    if (!installDropHook(win)) {
      state.warnings.push("drop-hook-unavailable");
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
        removeDropHook(win);
        return false;
      }
    }
    state.windows.add(win);
    return true;
  }

  function detachWindow(win) {
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
      allowUnverifiedVersion = false,
    } = options;

    if (state.installed) {
      return report("already-installed", { changedTabs: false });
    }

    state.enabled = enabled ?? prefEnabled();
    state.capabilities = null;
    state.warnings.length = 0;

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
    }
    return {
      adapter: ADAPTER_VERSION,
      installed: state.installed,
      enabled: state.enabled,
      windows,
      warnings: [...state.warnings],
    };
  }

  function hookedWindows() {
    return browserWindows().filter(win =>
      Boolean(win?.gBrowser?.tabContainer?.tabDragAndDrop?.[DROP_HOOK])
    ).length;
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
