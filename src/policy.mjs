/**
 * Svalinn's pure policy module.
 *
 * No browser globals, user data, profile files, or privileged hooks.
 * The browser adapter (still to be implemented) must use this policy before
 * invoking actions that could remove or demote protected tabs.
 */

export const ZONES = Object.freeze({
  ESSENTIAL: "essential",
  PINNED: "pinned",
  NORMAL: "normal",
});

export const REMOVAL_ACTIONS = Object.freeze([
  "close",
  "unpin",
  "remove-essential",
  "detach",
]);

/**
 * Essential is also technically pinned in Zen; order is deliberate.
 * @param {{ pinned?: boolean, essential?: boolean }} tab
 */
export function zoneOf(tab) {
  if (tab?.essential) return ZONES.ESSENTIAL;
  if (tab?.pinned) return ZONES.PINNED;
  return ZONES.NORMAL;
}

export function isProtected(tab) {
  return zoneOf(tab) !== ZONES.NORMAL;
}

/**
 * A protected tab may be removed only during an explicit unlock.
 * Unloading is never considered removal.
 */
export function decideAction({ tab, action, locked = true }) {
  if (action === "unload") return "allow";
  if (locked && isProtected(tab) && REMOVAL_ACTIONS.includes(action)) {
    return "block";
  }
  return "allow";
}

/**
 * Dragging protected tabs across zones/windows creates copies.
 * In-zone reordering in the same window remains native.
 * Dragging normal tabs is not changed.
 */
export function decideDrop({
  tab,
  targetZone,
  sameWindow = true,
  locked = true,
}) {
  if (!Object.values(ZONES).includes(targetZone)) {
    return "unsupported";
  }
  if (!locked || !isProtected(tab)) return "native";
  return zoneOf(tab) !== targetZone || !sameWindow ? "duplicate" : "native";
}
