/**
 * Mapping between real Zen tab elements and Svalinn's pure policy.
 *
 * Tabs are DOM elements: pinned state is `tab.pinned`, Essential state is the
 * `zen-essential` attribute. Reading these properties is non-destructive and
 * must remain safe to call while Zen is still restoring a session.
 */

import { ZONES, zoneOf } from "../policy.mjs";

/**
 * @param {any} tab
 * @returns {{ pinned: boolean, essential: boolean }}
 */
export function readTabFlags(tab) {
  const pinned = Boolean(tab?.pinned);
  let essential = false;
  try {
    essential =
      typeof tab?.hasAttribute === "function" &&
      Boolean(tab.hasAttribute("zen-essential"));
  } catch {
    essential = false;
  }
  return { pinned, essential };
}

function readTabId(tab) {
  try {
    return typeof tab?.id === "string" ? tab.id : null;
  } catch {
    return null;
  }
}

function readTabUrl(tab) {
  try {
    return tab?.linkedBrowser?.currentURI?.spec ?? null;
  } catch {
    return null;
  }
}

/**
 * Describe one tab without changing it.
 *
 * @param {any} tab
 * @param {number} [index]
 * @returns {{
 *   index: number,
 *   id: string | null,
 *   zone: "essential" | "pinned" | "normal",
 *   pinned: boolean,
 *   essential: boolean,
 *   url: string | null,
 * }}
 */
export function describeTab(tab, index = 0) {
  const flags = readTabFlags(tab);
  return {
    index,
    id: readTabId(tab),
    zone: zoneOf(flags),
    pinned: flags.pinned,
    essential: flags.essential,
    url: readTabUrl(tab),
  };
}

/**
 * Snapshot every tab in the given windows. Read-only.
 *
 * @param {Iterable<any>} windows
 */
export function snapshotWindows(windows) {
  const result = [];
  for (const win of windows) {
    let tabs = [];
    try {
      tabs = [...(win?.gBrowser?.tabs ?? [])].map(describeTab);
    } catch {
      tabs = [];
    }
    result.push({
      ready: Boolean(win?.gZenStartup?.isReady),
      hasManager: Boolean(win?.gZenPinnedTabManager),
      tabCount: tabs.length,
      tabs,
    });
  }
  return result;
}

export { ZONES };
