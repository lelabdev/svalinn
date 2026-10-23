/**
 * Capability checks for the privileged Zen browser scope.
 *
 * The adapter is injected into Zen's chrome context, where the globals below
 * are available. Every check is defensive: a missing or renamed internal must
 * produce a report, never a thrown error or a partially installed hook.
 */

import { inspectZenVersion } from "./version.mjs";

/** Internal globals and methods Svalinn depends on. */
export const REQUIRED_METHODS = Object.freeze({
  gBrowser: [
    "pinTab",
    "unpinTab",
    "addTab",
    "duplicateTab",
    "removeTab",
    "moveTabsBefore",
    "moveTabTo",
  ],
  gZenPinnedTabManager: [
    "addToEssentials",
    "removeEssentials",
    "onCloseTabShortcut",
  ],
});

/**
 * @param {unknown} value
 * @returns {value is Record<string, any>}
 */
function isObject(value) {
  return typeof value === "object" && value !== null;
}

function read(scope, key) {
  try {
    return scope?.[key];
  } catch {
    return undefined;
  }
}

function readServices(scope) {
  const scoped = read(scope, "Services");
  if (scoped !== undefined) return scoped;
  try {
    return globalThis?.Services;
  } catch {
    return undefined;
  }
}

/**
 * Inspect a privileged browser scope for the APIs Svalinn needs.
 *
 * @param {any} scope Browser window (or any object exposing Zen globals).
 * @param {object} [options]
 * @param {boolean} [options.allowUnverifiedVersion] Install even when the Zen
 *   version is outside the verified release line.
 * @param {{ major: number, minor: number }} [options.verifiedLine]
 * @returns {{
 *   ok: boolean,
 *   isZen: boolean,
 *   appName: string | null,
 *   version: string | null,
 *   versionStatus: "verified" | "unverified" | "unparseable",
 *   allowUnverifiedVersion: boolean,
 *   missing: string[],
 *   tabShape: boolean,
 *   error: string | null,
 * }}
 */
export function probeCapabilities(
  scope,
  { allowUnverifiedVersion = false, verifiedLine } = {}
) {
  const missing = [];
  let error = null;

  const services = readServices(scope);
  const appInfo = isObject(services) ? read(services, "appinfo") : undefined;
  const appName = isObject(appInfo) ? read(appInfo, "name") : null;
  const version = isObject(appInfo) ? read(appInfo, "version") : null;
  const isZen = appName === "Zen";

  if (!isZen) missing.push("Services.appinfo.name=Zen");

  const versionReport = inspectZenVersion(
    version,
    verifiedLine ? { verifiedLine } : undefined
  );
  if (versionReport.status !== "verified" && !allowUnverifiedVersion) {
    missing.push(`Zen version ${version ?? "unknown"} is not verified`);
  }

  if (!isObject(read(scope, "gBrowser"))) {
    missing.push("gBrowser");
  }
  for (const method of REQUIRED_METHODS.gBrowser) {
    if (typeof read(read(scope, "gBrowser"), method) !== "function") {
      missing.push(`gBrowser.${method}`);
    }
  }

  const tabs = read(read(scope, "gBrowser"), "tabs");
  if (!tabs || typeof tabs[Symbol.iterator] !== "function") {
    missing.push("gBrowser.tabs");
  }

  const dropControl = read(
    read(read(scope, "gBrowser"), "tabContainer"),
    "tabDragAndDrop"
  );
  if (!isObject(dropControl)) {
    missing.push("gBrowser.tabContainer.tabDragAndDrop");
  } else if (typeof read(dropControl, "handle_drop") !== "function") {
    missing.push("gBrowser.tabContainer.tabDragAndDrop.handle_drop");
  }

  if (!isObject(read(scope, "gZenPinnedTabManager"))) {
    missing.push("gZenPinnedTabManager");
  }
  for (const method of REQUIRED_METHODS.gZenPinnedTabManager) {
    if (
      typeof read(read(scope, "gZenPinnedTabManager"), method) !== "function"
    ) {
      missing.push(`gZenPinnedTabManager.${method}`);
    }
  }

  if (!isObject(read(scope, "gZenStartup"))) {
    missing.push("gZenStartup");
  }
  if (!isObject(read(scope, "gZenWorkspaces"))) {
    missing.push("gZenWorkspaces");
  }
  if (!isObject(read(scope, "SessionStore"))) {
    missing.push("SessionStore");
  }

  let tabShape = true;
  try {
    const first = tabs && typeof tabs[Symbol.iterator] === "function"
      ? [...tabs][0]
      : undefined;
    if (first) {
      tabShape =
        typeof first.pinned === "boolean" &&
        typeof first.hasAttribute === "function";
      if (!tabShape) missing.push("tab shape (pinned/hasAttribute)");
    }
  } catch (cause) {
    tabShape = false;
    error = String(cause);
    missing.push("tab shape (unreadable)");
  }

  return {
    ok: missing.length === 0,
    isZen,
    appName: typeof appName === "string" ? appName : null,
    version: typeof version === "string" ? version : null,
    versionStatus: versionReport.status,
    allowUnverifiedVersion,
    missing,
    tabShape,
    error,
  };
}
