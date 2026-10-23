/**
 * Svalinn's browser-side adapter.
 *
 * This file is concatenated after `src/policy.mjs` and the `src/zen/*` helper
 * modules by `src/zen/build.mjs`, then evaluated in Zen's chrome context by the
 * smoke harness. It deliberately contains no imports and installs no
 * destructive hooks: issue #1 only establishes detection, policy loading, and
 * read-only tab mapping for protected close/move work in later issues.
 */
(() => {
  "use strict";

  const ADAPTER_VERSION = "0.1.0";
  const MARKER = "__svalinn";
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

  function attachWindow(win) {
    if (!win || win.closed) return false;
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
        return false;
      }
    }
    state.windows.add(win);
    return true;
  }

  function detachWindow(win) {
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

    for (const win of browserWindows()) attachWindow(win);
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
    return {
      adapter: ADAPTER_VERSION,
      installed: state.installed,
      enabled: state.enabled,
      windows: snapshotWindows(browserWindows()),
    };
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
