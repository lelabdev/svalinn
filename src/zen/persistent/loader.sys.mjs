/**
 * Svalinn persistent loader.
 *
 * Loaded by the tiny autoconfig bootloader in Zen's installation directory.
 * It loads the unchanged adapter bundle into Zen's hidden chrome window and
 * activates it after the first browser window is ready. No Marionette or
 * debugging port is required during normal browsing.
 */

const STATUS_PREF = "svalinn.status";
const ERROR_PREF = "svalinn.lastError";
const VERSION_PREF = "svalinn.loaderVersion";
const WINDOWS_PREF = "svalinn.guardWindows";
const LOADER_VERSION = "0.1.0";

function setStatus(status, details = {}) {
  try {
    Services.prefs.setStringPref(STATUS_PREF, status);
    Services.prefs.setStringPref(ERROR_PREF, details.error ?? "");
    Services.prefs.setStringPref(VERSION_PREF, LOADER_VERSION);
    Services.prefs.setIntPref(
      WINDOWS_PREF,
      Number(details.windows ?? 0) || 0
    );
  } catch {
    // Never let status reporting break browser startup.
  }
}

function getAdapterHosts() {
  const hosts = [];
  try {
    const hidden = Services.appShell.hiddenDOMWindow;
    if (hidden && !hidden.closed) hosts.push(hidden);
  } catch {
    // Headless and some Zen configurations have no hidden chrome window.
  }
  const browser = Services.wm.getMostRecentWindow("navigator:browser");
  if (browser && !browser.closed && !hosts.includes(browser)) {
    hosts.push(browser);
  }
  return hosts;
}

function loadAdapter() {
  for (const host of getAdapterHosts()) {
    try {
      Services.scriptloader.loadSubScript(
        "chrome://svalinn/content/adapter.js",
        host,
        "UTF-8"
      );
      if (host.Svalinn) return host.Svalinn;
    } catch {
      // Try the next chrome host (hidden window may be unavailable/headless).
    }
  }
  return null;
}

async function activate() {
  if (!Services.prefs.getBoolPref("svalinn.enabled", true)) {
    setStatus("disabled");
    return;
  }

  setStatus("starting");
  try {
    const api = loadAdapter();
    if (!api) {
      setStatus("error", { error: "adapter did not load" });
      return;
    }

    const result = await api.install({
      enabled: true,
      waitForStartup: true,
      timeoutMs: 30_000,
    });

    if (
      result?.status === "installed" ||
      result?.status === "already-installed"
    ) {
      setStatus("installed", {
        windows: result.windows,
      });
      return;
    }

    setStatus(result?.status ?? "error", {
      error:
        result?.error ??
        result?.reason ??
        "adapter did not install",
      windows: result?.windows,
    });
  } catch (error) {
    setStatus("error", { error: String(error) });
  }
}

if (!Services.appinfo.inSafeMode) {
  const existing = Services.wm.getMostRecentWindow("navigator:browser");
  if (existing) {
    activate();
  } else {
    const observer = {
      observe(subject, topic) {
        if (topic !== "browser-delayed-startup-finished") return;
        try {
          Services.obs.removeObserver(observer, topic);
        } catch {}
        activate();
      },
    };
    Services.obs.addObserver(observer, "browser-delayed-startup-finished");
  }
}
